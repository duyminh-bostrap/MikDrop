'use strict';
/**
 * MikDrop - Signaling Server
 *
 * Server này CHỈ làm 3 việc:
 *   1. Phục vụ giao diện web (thư mục /public)
 *   2. Discovery: biết thiết bị nào đang mở MikDrop và báo cho các thiết bị khác
 *   3. Chuyển tiếp tin nhắn báo hiệu WebRTC (offer / answer / ICE) giữa 2 thiết bị
 *
 * Nội dung tệp đi thẳng giữa 2 thiết bị qua WebRTC DataChannel, KHÔNG lưu trên server.
 * (Chỉ khi WebRTC không kết nối được, client mới chuyển sang chế độ dự phòng
 *  "relay": server chuyển tiếp từng mảnh dữ liệu trong RAM, không ghi đĩa, không lưu lại.)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const PORT = Number(argValue('--port') || process.env.PORT) || 3000;
const USE_HTTPS = args.includes('--https') || process.env.HTTPS === '1';
const MDNS_NAME = 'mikdrop.local';

// ---------------------------------------------------------------------------
// Địa chỉ mạng LAN
// ---------------------------------------------------------------------------
const VIRTUAL_NIC = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|zerotier|loopback|bluetooth/i;

function ipToInt(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

function getLanInterfaces() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      list.push({
        name,
        address: a.address,
        netmask: a.netmask,
        virtual: VIRTUAL_NIC.test(name),
        isPrivate,
      });
    }
  }
  // Ưu tiên card mạng thật + dải IP riêng lên đầu
  return list.sort((a, b) => a.virtual - b.virtual || b.isPrivate - a.isPrivate);
}

// ---------------------------------------------------------------------------
// HTTP(S) + Socket.io
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/api/info', (req, res) => {
  const scheme = USE_HTTPS ? 'https' : 'http';
  res.json({
    urls: getLanInterfaces().map((i) => `${scheme}://${i.address}:${PORT}`),
  });
});

async function createServer() {
  if (!USE_HTTPS) return http.createServer(app);

  // HTTPS tự ký - cần để iPhone dùng được "Lưu vào Ảnh" (Web Share API chỉ chạy trên HTTPS)
  const certDir = path.join(__dirname, '.cert');
  const keyFile = path.join(certDir, 'key.pem');
  const certFile = path.join(certDir, 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const selfsigned = require('selfsigned');
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 2, value: MDNS_NAME },
      { type: 7, ip: '127.0.0.1' },
      ...getLanInterfaces().map((i) => ({ type: 7, ip: i.address })),
    ];
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'MikDrop' }], {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
    console.log('  Đã tạo chứng chỉ HTTPS tự ký trong thư mục .cert/');
  }
  return https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app);
}

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------
const DEVICE_TYPES = new Set(['phone', 'tablet', 'laptop', 'desktop']);
const peers = new Map(); // socket.id -> { id, name, type }

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
const publicPeer = (p) => ({ id: p.id, name: p.name, type: p.type });

function attachSignaling(io) {
  io.on('connection', (socket) => {
    socket.on('join', (info) => {
      const peer = {
        id: socket.id,
        name: cleanName(info && info.name) || 'Thiết bị',
        type: DEVICE_TYPES.has(info && info.type) ? info.type : 'desktop',
      };
      peers.set(socket.id, peer);
      socket.emit('peers', [...peers.values()].filter((p) => p.id !== socket.id).map(publicPeer));
      socket.broadcast.emit('peer-joined', publicPeer(peer));
    });

    socket.on('rename', (name) => {
      const peer = peers.get(socket.id);
      if (!peer) return;
      peer.name = cleanName(name) || peer.name;
      socket.broadcast.emit('peer-updated', publicPeer(peer));
    });

    // Các thông điệp chỉ cần chuyển tiếp nguyên vẹn tới thiết bị đích
    const FORWARD = [
      'transfer-request',
      'transfer-accept',
      'transfer-decline',
      'transfer-cancel',
      'signal',
      'use-relay',
    ];
    for (const event of FORWARD) {
      socket.on(event, (msg) => {
        if (!peers.has(socket.id) || !msg || typeof msg.to !== 'string') return;
        const target = io.sockets.sockets.get(msg.to);
        if (!target || !peers.has(msg.to)) {
          socket.emit('peer-gone', { id: msg.to, transferId: msg.transferId });
          return;
        }
        target.emit(event, { ...msg, from: socket.id });
      });
    }

    // Chế độ dự phòng: chuyển tiếp từng mảnh dữ liệu (không lưu), có xác nhận để điều tiết tốc độ
    socket.on('relay', (msg, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      if (!peers.has(socket.id) || !msg || typeof msg.to !== 'string') return done('bad-request');
      const target = io.sockets.sockets.get(msg.to);
      if (!target || !peers.has(msg.to)) return done('gone');
      target.timeout(60000).emit(
        'relay',
        { from: socket.id, transferId: msg.transferId, kind: msg.kind, data: msg.data },
        (err) => done(err ? 'timeout' : undefined)
      );
    });

    socket.on('disconnect', () => {
      if (peers.delete(socket.id)) socket.broadcast.emit('peer-left', { id: socket.id });
    });
  });
}

// ---------------------------------------------------------------------------
// mDNS: để truy cập được bằng http://mikdrop.local
// ---------------------------------------------------------------------------
function startMdns() {
  let mdns;
  try {
    mdns = require('multicast-dns')();
  } catch (err) {
    return null;
  }
  mdns.on('error', () => {});
  mdns.on('query', (query, rinfo) => {
    const asked = query.questions.some(
      (q) => q.name && q.name.toLowerCase() === MDNS_NAME && (q.type === 'A' || q.type === 'ANY')
    );
    if (!asked) return;
    const all = getLanInterfaces().filter((i) => !i.virtual);
    // Ưu tiên địa chỉ cùng dải mạng với thiết bị đang hỏi
    const same = all.filter(
      (i) => rinfo && rinfo.address && (ipToInt(i.address) & ipToInt(i.netmask)) === (ipToInt(rinfo.address) & ipToInt(i.netmask))
    );
    const ips = (same.length ? same : all).map((i) => i.address);
    mdns.respond({
      answers: ips.map((ip) => ({ name: MDNS_NAME, type: 'A', ttl: 120, data: ip })),
    });
  });
  return mdns;
}

// ---------------------------------------------------------------------------
// Khởi động
// ---------------------------------------------------------------------------
(async () => {
  const server = await createServer();
  const io = new Server(server, {
    maxHttpBufferSize: 8 * 1024 * 1024, // đủ cho các mảnh relay 256KB + ảnh xem trước
    pingInterval: 10000,
    pingTimeout: 20000,
  });
  attachSignaling(io);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Cổng ${PORT} đang được dùng. Thử: PORT=${PORT + 1} npm start (hoặc node server.js --port ${PORT + 1})\n`);
    } else if (err.code === 'EACCES') {
      console.error(`\n  Không đủ quyền mở cổng ${PORT}. Hãy dùng cổng >= 1024 hoặc chạy với quyền quản trị.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    const scheme = USE_HTTPS ? 'https' : 'http';
    const portPart = (USE_HTTPS && PORT === 443) || (!USE_HTTPS && PORT === 80) ? '' : `:${PORT}`;
    const lan = getLanInterfaces();

    console.log('\n  MikDrop đang chạy 🚀\n');
    console.log(`  Trên máy này:      ${scheme}://localhost${portPart}`);
    for (const i of lan) {
      console.log(`  Thiết bị khác:     ${scheme}://${i.address}${portPart}   (${i.name}${i.virtual ? ', có thể là card ảo' : ''})`);
    }
    if (startMdns()) console.log(`  Tên miền dễ nhớ:   ${scheme}://${MDNS_NAME}${portPart}`);
    if (USE_HTTPS) console.log('\n  HTTPS tự ký: trình duyệt sẽ cảnh báo lần đầu, hãy chọn "Tiếp tục/Nâng cao → Truy cập".');

    const best = lan.find((i) => !i.virtual && i.isPrivate) || lan[0];
    if (best) {
      try {
        const url = `${scheme}://${best.address}${portPart}`;
        console.log('\n  Quét mã QR bằng iPhone để mở nhanh:\n');
        require('qrcode-terminal').generate(url, { small: true }, (qr) => {
          console.log(qr.replace(/^/gm, '    '));
        });
      } catch (err) {
        /* QR là tính năng phụ, bỏ qua nếu lỗi */
      }
    } else {
      console.log('\n  ⚠ Không tìm thấy địa chỉ mạng LAN. Hãy kiểm tra kết nối Wi-Fi.\n');
    }
  });
})();
