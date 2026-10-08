'use strict';
/**
 * "Chia sẻ từ app khác": đầu nhận tệp cho Phím tắt (Shortcuts) trên iPhone, hiện trong nút Chia sẻ của iOS.
 *
 * iOS không cho trang web tự thêm mình vào bảng chia sẻ, nên phím tắt sẽ đẩy tệp lên server này
 * (HTTP thường, trong LAN) rồi server đóng vai "thiết bị gửi" tới thiết bị đã chọn:
 *
 *   Phím tắt --GET /api/devices--------------> danh sách tên thiết bị đang mở MikDrop (JSON)
 *   Phím tắt --POST /api/share?to=TÊN&name=TÊN_TỆP  (thân yêu cầu = nội dung tệp, mỗi tệp một lần gọi)
 *   server gom các tệp gửi liền nhau (cùng người nhận) thành MỘT yêu cầu, ghi tạm ra đĩa
 *   server --transfer-request--> thiết bị nhận   (như một thiết bị gửi bình thường, id ảo "share:...")
 *   thiết bị nhận bấm Chấp nhận --> server phát từng mảnh qua đường relay có sẵn --> nhận ack --> xoá tệp tạm
 *
 * Người nhận vẫn phải bấm Chấp nhận. Tệp tạm bị xoá khi xong, bị từ chối, hết hạn (2 phút) hoặc server tắt.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');

const VPREFIX = 'share:';
const ALL_LABEL = 'All devices';
const MAX_FILE = (Number(process.env.SHARE_MAX_FILE_MB) || 2048) * 1048576;   // mỗi tệp
const MAX_TOTAL = (Number(process.env.SHARE_MAX_TOTAL_MB) || 4096) * 1048576; // tổng dung lượng đang chờ trên đĩa
const BATCH_GAP_MS = 2500;      // các tệp gửi cách nhau dưới khoảng này được gộp thành một yêu cầu
const ACCEPT_TTL_MS = 120000;   // người nhận không trả lời thì huỷ
const ACK_TTL_MS = 30000;       // đã gửi xong mà không thấy xác nhận thì dọn dẹp
const RELAY_WINDOW = 8;         // số mảnh được phép "đang bay", giống phía trình duyệt

const isVirtualId = (id) => typeof id === 'string' && id.startsWith(VPREFIX);

function attachShare({ app, io, peers, cleanName, roomForRequest, enabled }) {
  let dir = null;
  let pendingBytes = 0;
  const batches = new Map();   // key -> { room, to, fromName, files, timer }
  const transfers = new Map(); // id ảo -> lần truyền

  const ensureDir = () => {
    if (!dir) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikdrop-share-'));
      process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* bỏ qua */ } });
    }
    return dir;
  };

  // Trình duyệt của trang web khác không được gọi vào đây: yêu cầu chéo trang luôn kèm Origin khác Host.
  // Phím tắt và curl không gửi Origin nên vẫn qua.
  const sameOriginOrNone = (req) => {
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch (err) { return false; }
  };

  // Các thiết bị có thể nhận trong một phòng, mỗi thiết bị một nhãn duy nhất (trùng tên thì thêm số)
  function targetsIn(room) {
    const seen = new Map();
    const list = [];
    for (const p of peers.values()) {
      if (p.room !== room) continue;
      const n = (seen.get(p.name) || 0) + 1;
      seen.set(p.name, n);
      list.push({ label: n > 1 ? `${p.name} (${n})` : p.name, peer: p });
    }
    return list;
  }

  function resolveTargets(room, to) {
    const all = targetsIn(room);
    if (!to || to === ALL_LABEL) return all.map((t) => t.peer);
    const hit = all.find((t) => t.label === to) || all.find((t) => t.peer.name === to);
    return hit ? [hit.peer] : [];
  }

  // --- HTTP ---------------------------------------------------------------
  app.get('/api/devices', (req, res) => {
    if (!enabled) return res.status(403).json({ error: 'disabled' });
    if (!sameOriginOrNone(req)) return res.status(403).json({ error: 'forbidden' });
    const labels = targetsIn(roomForRequest(req)).map((t) => t.label);
    res.set('Cache-Control', 'no-store').json(labels.length > 1 ? [...labels, ALL_LABEL] : labels);
  });

  app.post('/api/share', (req, res) => {
    const reject = (status, error) => {
      res.set('Connection', 'close').status(status).json({ error });
      res.on('finish', () => req.destroy());
    };
    if (!enabled) return reject(403, 'disabled');
    if (!sameOriginOrNone(req)) return reject(403, 'forbidden');

    const room = roomForRequest(req);
    const to = String(req.query.to || '').trim();
    if (!resolveTargets(room, to).length) return reject(404, 'no-device'); // không có thiết bị nhận: đừng nhận tệp làm gì
    const declared = Number(req.headers['content-length']) || 0;
    if (declared > MAX_FILE) return reject(413, 'too-large');
    if (pendingBytes + declared > MAX_TOTAL) return reject(503, 'busy');

    const fromName = cleanName(req.query.from) || 'iPhone';
    const name = String(req.query.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200) || `file-${Date.now()}`;
    let type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) || type === 'application/x-www-form-urlencoded') type = '';

    const file = path.join(ensureDir(), crypto.randomBytes(12).toString('hex'));
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, enc, cb) {
        bytes += chunk.length;
        pendingBytes += chunk.length;
        if (bytes > MAX_FILE || pendingBytes > MAX_TOTAL) return cb(new Error(bytes > MAX_FILE ? 'too-large' : 'busy'));
        cb(null, chunk);
      },
    });
    pipeline(req, counter, fs.createWriteStream(file), (err) => {
      if (err) {
        pendingBytes -= bytes;
        fs.unlink(file, () => {});
        if (!res.headersSent) res.status(err.message === 'too-large' ? 413 : err.message === 'busy' ? 503 : 400).json({ error: err.message });
        return;
      }
      addToBatch({ room, to, fromName }, { path: file, name, size: bytes, type });
      res.json({ ok: true, name, size: bytes });
    });
  });

  function addToBatch(key, file) {
    const k = `${key.room}|${key.to}|${key.fromName}`;
    let b = batches.get(k);
    if (!b) { b = { ...key, files: [], timer: null }; batches.set(k, b); }
    b.files.push(file);
    clearTimeout(b.timer);
    b.timer = setTimeout(() => { batches.delete(k); send(b); }, BATCH_GAP_MS);
  }

  const dropFiles = (files) => files.forEach((f) => { fs.unlink(f.path, () => {}); pendingBytes -= f.size; });

  // Gửi yêu cầu "X muốn gửi N tệp" tới từng thiết bị nhận; mỗi thiết bị một lần truyền riêng, dùng chung các tệp tạm
  function send(b) {
    const targets = resolveTargets(b.room, b.to);
    if (!targets.length) return dropFiles(b.files);
    const group = { files: b.files, refs: targets.length };
    for (const peer of targets) {
      const sock = io.sockets.sockets.get(peer.id);
      if (!sock) { release(group); continue; }
      const id = crypto.randomBytes(8).toString('hex');
      const tr = { id, vid: VPREFIX + id, group, targetId: peer.id, fromName: b.fromName, state: 'waiting', cancelled: false, sock };
      transfers.set(tr.vid, tr);
      tr.ttl = setTimeout(() => {
        if (tr.state !== 'waiting') return;
        sock.emit('transfer-cancel', { from: tr.vid, transferId: tr.id });
        finish(tr);
      }, ACCEPT_TTL_MS);
      sock.emit('transfer-request', {
        from: tr.vid,
        fromName: b.fromName,
        fromType: 'phone',
        transferId: tr.id,
        files: group.files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        thumbs: [],
      });
    }
  }

  function release(group) {
    if (--group.refs <= 0) dropFiles(group.files);
  }

  function finish(tr) {
    if (!transfers.delete(tr.vid)) return;
    tr.cancelled = true;
    clearTimeout(tr.ttl);
    clearTimeout(tr.ackTimer);
    if (tr.wake) tr.wake();
    release(tr.group);
  }

  // Phát tệp tới người nhận qua đường relay có sẵn (người nhận coi như một lần nhận bình thường ở chế độ relay)
  async function stream(tr) {
    const sock = tr.sock;
    let inflight = 0;
    let error = null;
    const waiters = [];
    tr.wake = () => waiters.splice(0).forEach((r) => r());
    const relay = async (kind, data) => {
      while (inflight >= RELAY_WINDOW) {
        if (error || tr.cancelled) break;
        await new Promise((r) => waiters.push(r));
      }
      if (error) throw error;
      if (tr.cancelled) throw new Error('cancelled');
      inflight++;
      sock.timeout(60000).emit('relay', { from: tr.vid, transferId: tr.id, kind, data }, (err) => {
        inflight--;
        if (err) error = err;
        const w = waiters.shift();
        if (w) w();
      });
    };

    sock.emit('use-relay', { from: tr.vid, transferId: tr.id, fast: true });
    try {
      const files = tr.group.files;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        await relay('ctrl', { t: 'start', i, name: f.name, size: f.size, type: f.type });
        for await (const chunk of fs.createReadStream(f.path, { highWaterMark: 256 * 1024 })) await relay('bin', chunk);
        await relay('ctrl', { t: 'end', i });
      }
      tr.state = 'finishing'; // phải đặt trước khi gửi 'done', vì người nhận trả ack ngay khi nhận được
      tr.ackTimer = setTimeout(() => finish(tr), ACK_TTL_MS);
      await relay('ctrl', { t: 'done' });
    } catch (err) {
      if (!tr.cancelled && transfers.has(tr.vid)) sock.emit('transfer-cancel', { from: tr.vid, transferId: tr.id });
      finish(tr);
    }
  }

  // --- Thông điệp từ người nhận gửi tới "thiết bị ảo" ---------------------------------
  // Trả true nếu thông điệp đã được xử lý ở đây (server.js không chuyển tiếp nữa).
  function handleEvent(socket, event, msg) {
    if (!msg || !isVirtualId(msg.to)) return false;
    const tr = transfers.get(msg.to);
    if (!tr || tr.targetId !== socket.id || tr.id !== msg.transferId) return true;
    if (event === 'transfer-accept' && tr.state === 'waiting') {
      tr.state = 'sending';
      clearTimeout(tr.ttl);
      stream(tr);
    } else if (event === 'transfer-decline' || event === 'transfer-cancel') {
      finish(tr);
    }
    return true;
  }

  function handleRelay(socket, msg, ack) {
    if (!msg || !isVirtualId(msg.to)) return false;
    if (typeof ack === 'function') ack();
    const tr = transfers.get(msg.to);
    if (tr && tr.targetId === socket.id && tr.state === 'finishing' && msg.kind === 'ctrl' && msg.data && msg.data.t === 'ack') finish(tr);
    return true;
  }

  function onDisconnect(socketId) {
    for (const tr of [...transfers.values()]) if (tr.targetId === socketId) finish(tr);
  }

  return { handleEvent, handleRelay, onDisconnect, enabled };
}

module.exports = { attachShare };
