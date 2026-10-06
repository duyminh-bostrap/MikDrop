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

// Khi đóng gói thành MikDrop.exe (Node SEA), giao diện được nhúng trong file exe
let sea = null;
try {
  sea = require('node:sea');
  if (!sea.isSea()) sea = null;
} catch (err) {
  sea = null;
}
const BASE_DIR = sea ? path.dirname(process.execPath) : __dirname; // nơi lưu .cert khi chạy bằng exe

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

// Bản exe trên Windows chạy nền, không có cửa sổ terminal (exe được đặt ở chế độ GUI khi build):
// log ghi vào MikDrop.log cạnh file exe, lỗi nghiêm trọng hiện bằng hộp thoại.
const HEADLESS = !!sea && process.platform === 'win32';
if (HEADLESS) {
  const logFile = path.join(BASE_DIR, 'MikDrop.log');
  try { fs.writeFileSync(logFile, ''); } catch (err) { /* thư mục có thể không ghi được, bỏ qua */ }
  const write = (...parts) => {
    try { fs.appendFileSync(logFile, `${parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ')}\n`); } catch (err) { /* bỏ qua */ }
  };
  console.log = write;
  console.warn = write;
  console.error = write;
}

// Tự thoát khi không còn trang web nào mở (mặc định chỉ với bản exe; --keep-alive để tắt tính năng này)
const AUTO_EXIT = !!sea && !args.includes('--keep-alive');
const AUTO_EXIT_GRACE_MS = 15000;       // chờ khi tải lại trang hoặc mạng chập chờn
const AUTO_EXIT_FIRST_MS = 120000;      // chờ trình duyệt mở lần đầu

const EXPLICIT_PORT = Number(argValue('--port') || process.env.PORT) || 0;
let PORT = EXPLICIT_PORT || 3000; // nếu không chỉ định và cổng bận, tự thử cổng kế tiếp
const USE_HTTPS = args.includes('--https') || process.env.HTTPS === '1';
const MDNS_NAME = 'mikdrop.local';

// Chế độ đám mây: server nằm sau reverse proxy (Render, Fly, Railway...) nên HTTPS do nền tảng lo,
// địa chỉ IP thật của thiết bị lấy từ header X-Forwarded-For.
const CLOUD = process.env.TRUST_PROXY === '1';
// Lấy IP thật của thiết bị khi đứng sau proxy:
//  - TRUSTED_IP_HEADER: header do proxy đặt và client không giả được. Render đi qua Cloudflare, nơi
//    CF-Connecting-IP luôn là IP thật (Cloudflare từ chối request nếu client tự đặt header này).
//  - Nếu không có: dùng phần tử thứ PROXY_HOPS tính từ bên phải của X-Forwarded-For (mặc định 1 proxy).
//    Các phần tử bên trái do client tự khai nên không tin.
const TRUSTED_IP_HEADER = (process.env.TRUSTED_IP_HEADER || (process.env.RENDER ? 'cf-connecting-ip' : '')).toLowerCase();
const PROXY_HOPS = Number(process.env.PROXY_HOPS) || 1;
const RELAY_ENABLED = process.env.RELAY !== '0';           // RELAY=0 tắt chế độ dự phòng (tiết kiệm băng thông)
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM) || 50;

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
// Chạy trong LAN: không cần STUN (và hoạt động được cả khi mất Internet). Chạy trên Internet: dùng STUN.
let ICE_SERVERS = CLOUD ? DEFAULT_ICE : [];
try {
  if (process.env.ICE_SERVERS) ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); // có thể thêm TURN
} catch (err) {
  console.warn('ICE_SERVERS không phải JSON hợp lệ, dùng STUN mặc định.');
}

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
if (sea) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch (err) { return next(); }
    if (p.endsWith('/')) p += 'index.html';
    let data;
    try { data = Buffer.from(sea.getAsset('public' + p)); } catch (err) { return next(); }
    res.type(path.extname(p) || 'bin').set('Cache-Control', 'no-cache').send(data);
  });
} else {
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
}
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/api/config', (req, res) => res.json({ iceServers: ICE_SERVERS, relay: RELAY_ENABLED }));
// Mã QR dạng SVG cho giao diện web ("Mời thiết bị"). Sinh trên server nên chạy được khi không có Internet.
app.get('/api/qr.svg', async (req, res) => {
  const text = String(req.query.u || '');
  if (!text || text.length > 300) return res.status(400).type('text').send('bad request');
  try {
    const svg = await require('qrcode').toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    res.status(500).type('text').send('qr error');
  }
});
app.get('/api/info', (req, res) => {
  const scheme = USE_HTTPS ? 'https' : 'http';
  res.json({
    urls: getLanInterfaces().map((i) => `${scheme}://${i.address}:${PORT}`),
    canQuit: !!sea, // bản exe: giao diện hiện nút "Thoát MikDrop" khi mở từ chính máy này
  });
});

// Thoát hẳn MikDrop (bản exe không có cửa sổ để đóng). Chỉ nhận từ chính máy này và yêu cầu header tuỳ chỉnh,
// nên trang web khác không thể tự gọi (header lạ buộc trình duyệt kiểm tra CORS trước, mà server không cho phép).
const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));
app.post('/api/quit', (req, res) => {
  if (!sea || !isLoopback(req.socket.remoteAddress) || req.headers['x-mikdrop'] !== '1') {
    return res.status(403).type('text').send('forbidden');
  }
  res.type('text').send('bye');
  setTimeout(() => process.exit(0), 200);
});

async function createServer() {
  if (!USE_HTTPS) return http.createServer(app);

  // HTTPS tự ký - cần để iPhone dùng được "Lưu vào Ảnh" (Web Share API chỉ chạy trên HTTPS)
  const certDir = path.join(BASE_DIR, '.cert');
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
const peers = new Map(); // socket.id -> { id, name, type, room }

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
const publicPeer = (p) => ({ id: p.id, name: p.name, type: p.type });

// --- Phòng: thiết bị chỉ thấy nhau khi cùng phòng --------------------------
// Mặc định phòng được suy ra từ địa chỉ IP công cộng (cùng nhà/Wi-Fi => cùng IP => cùng phòng).
// Mọi kết nối từ mạng nội bộ (192.168.x.x...) vào server chạy tại nhà đều rơi vào phòng "lan".
// Thiết bị ở mạng khác nhau có thể nhập chung một mã phòng.
function clientIp(socket) {
  let ip = socket.handshake.address || '';
  if (CLOUD) {
    const trusted = TRUSTED_IP_HEADER && socket.handshake.headers[TRUSTED_IP_HEADER];
    if (trusted) {
      ip = String(trusted).trim();
    } else {
      const xff = socket.handshake.headers['x-forwarded-for'];
      if (xff) {
        const parts = String(xff).split(',').map((p) => p.trim()).filter(Boolean);
        ip = parts[Math.max(0, parts.length - PROXY_HOPS)] || ip;
      }
    }
  }
  return ip.replace(/^::ffff:/i, '').replace(/%.*$/, '');
}

const isPrivateIp = (ip) =>
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^(f[cd]|fe80)/i.test(ip);

function ipv6Prefix64(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const gap = ip.includes('::') ? Math.max(0, 8 - h.length - t.length) : 0;
  return [...h, ...Array(gap).fill('0'), ...t]
    .slice(0, 4)
    .map((x) => x.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
}

function autoRoom(ip) {
  if (!ip || isPrivateIp(ip)) return 'lan';
  // IPv6: các thiết bị trong cùng nhà thường chung tiền tố /64 nhưng khác đuôi (địa chỉ tạm thời)
  return ip.includes(':') ? `ip6:${ipv6Prefix64(ip)}` : `ip:${ip}`;
}

const normalizeRoomCode = (s) => {
  const code = String(s || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,23}$/.test(code) ? code : '';
};

const roomSize = (room) => [...peers.values()].filter((p) => p.room === room).length;

function attachSignaling(io) {
  io.on('connection', (socket) => {
    socket.on('join', (info) => {
      const prev = peers.get(socket.id);
      const code = normalizeRoomCode(info && info.room);
      const room = code ? `code:${code}` : autoRoom(clientIp(socket));

      if (prev && prev.room !== room) {
        socket.leave(prev.room);
        peers.delete(socket.id);
        io.to(prev.room).emit('peer-left', { id: socket.id });
      }
      if (!peers.has(socket.id) && roomSize(room) >= MAX_PEERS_PER_ROOM) {
        socket.emit('join-error', { message: 'Phòng đã đầy.' });
        return;
      }

      const peer = {
        id: socket.id,
        room,
        name: cleanName(info && info.name) || 'Thiết bị',
        type: DEVICE_TYPES.has(info && info.type) ? info.type : 'desktop',
      };
      const isNew = !peers.has(socket.id);
      peers.set(socket.id, peer);
      socket.join(room);

      socket.emit('room', { code: code || null });
      socket.emit(
        'peers',
        [...peers.values()].filter((p) => p.room === room && p.id !== socket.id).map(publicPeer)
      );
      socket.to(room).emit(isNew ? 'peer-joined' : 'peer-updated', publicPeer(peer));
    });

    socket.on('rename', (name) => {
      const peer = peers.get(socket.id);
      if (!peer) return;
      peer.name = cleanName(name) || peer.name;
      socket.to(peer.room).emit('peer-updated', publicPeer(peer));
    });

    // Chỉ cho phép trao đổi với thiết bị cùng phòng
    const sameRoomTarget = (msg) => {
      const me = peers.get(socket.id);
      const other = msg && typeof msg.to === 'string' ? peers.get(msg.to) : null;
      if (!me || !other || other.room !== me.room) return null;
      return io.sockets.sockets.get(other.id) || null;
    };

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
        const target = sameRoomTarget(msg);
        if (!target) {
          socket.emit('peer-gone', { id: msg.to, transferId: msg.transferId });
          return;
        }
        target.emit(event, { ...msg, from: socket.id });
      });
    }

    // Chế độ dự phòng: chuyển tiếp từng mảnh dữ liệu (không lưu), có xác nhận để điều tiết tốc độ
    socket.on('relay', (msg, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      if (!RELAY_ENABLED) return done('disabled');
      if (!peers.has(socket.id) || !msg || typeof msg.to !== 'string') return done('bad-request');
      const target = sameRoomTarget(msg);
      if (!target) return done('gone');
      target.timeout(60000).emit(
        'relay',
        { from: socket.id, transferId: msg.transferId, kind: msg.kind, data: msg.data },
        (err) => done(err ? 'timeout' : undefined)
      );
    });

    socket.on('disconnect', () => {
      const peer = peers.get(socket.id);
      if (peer) {
        peers.delete(socket.id);
        io.to(peer.room).emit('peer-left', { id: socket.id });
      }
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
// Lỗi nghiêm trọng. Bản exe không có cửa sổ terminal nên báo bằng hộp thoại Windows.
function fatal(message) {
  console.error(message);
  if (HEADLESS) {
    const text = String(message).trim().slice(0, 500).replace(/'/g, "''");
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('${text}', 'MikDrop')`],
      { windowsHide: true },
      () => process.exit(1)
    );
  } else {
    process.exit(1);
  }
}

function printBanner() {
  if (CLOUD) {
    console.log(`MikDrop đang lắng nghe ở cổng ${PORT} (chế độ đám mây, relay ${RELAY_ENABLED ? 'bật' : 'tắt'}).`);
    return;
  }
  const scheme = USE_HTTPS ? 'https' : 'http';
  const portPart = (USE_HTTPS && PORT === 443) || (!USE_HTTPS && PORT === 80) ? '' : `:${PORT}`;
  const lan = getLanInterfaces();

  console.log('\n  MikDrop đang chạy\n');
  console.log(`  Trên máy này:      ${scheme}://localhost${portPart}`);
  for (const i of lan) {
    console.log(`  Thiết bị khác:     ${scheme}://${i.address}${portPart}   (${i.name}${i.virtual ? ', có thể là card ảo' : ''})`);
  }
  if (startMdns()) console.log(`  Tên miền dễ nhớ:   ${scheme}://${MDNS_NAME}${portPart}`);
  if (USE_HTTPS) console.log('\n  HTTPS tự ký: trình duyệt sẽ cảnh báo lần đầu, hãy chọn "Tiếp tục/Nâng cao → Truy cập".');

  const best = lan.find((i) => !i.virtual && i.isPrivate) || lan[0];
  if (HEADLESS) {
    // Không có terminal: mã QR hiện trong giao diện web
  } else if (best) {
    try {
      const url = `${scheme}://${best.address}${portPart}`;
      console.log('\n  Quét mã QR bằng iPhone để mở nhanh:\n');
      require('qrcode-terminal').generate(url, { small: true }, (qr) => {
        console.log(qr.replace(/^/gm, '    '));
        if (sea) console.log('\n  Giữ cửa sổ này mở trong lúc dùng MikDrop. Đóng cửa sổ để tắt.'); // bản exe chạy ở chế độ --keep-alive hoặc không phải Windows
      });
    } catch (err) {
      /* QR là tính năng phụ, bỏ qua nếu lỗi */
    }
  } else {
    console.log('\n  Không tìm thấy địa chỉ mạng LAN. Hãy kiểm tra kết nối Wi-Fi hoặc bật Mobile Hotspot.\n');
  }

  // Bản exe: tự mở giao diện trên máy này
  if (sea && process.platform === 'win32' && !args.includes('--no-open')) {
    require('child_process').exec(`start "" "${scheme}://localhost${portPart}"`, { windowsHide: true }, () => {});
  }
}

// Bản exe: thoát khi không còn trang web nào kết nối (đã đóng trình duyệt), để không chạy ngầm vô ích
function setupAutoExit(io) {
  if (!AUTO_EXIT) return;
  let timer = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (io.engine.clientsCount === 0) {
        console.log('Không còn trang web nào đang mở, MikDrop tự thoát.');
        process.exit(0);
      }
    }, ms);
  };
  io.on('connection', (socket) => {
    clearTimeout(timer);
    socket.on('disconnect', () => {
      // clientsCount được cập nhật sau sự kiện đóng, nên kiểm tra ở vòng lặp kế tiếp
      setImmediate(() => { if (io.engine.clientsCount === 0) arm(AUTO_EXIT_GRACE_MS); });
    });
  });
  arm(AUTO_EXIT_FIRST_MS); // trình duyệt chưa kịp mở (hoặc bị chặn) thì cũng không chạy ngầm mãi
}

(async () => {
  const server = await createServer();
  const io = new Server(server, {
    serveClient: false, // file client nằm ở public/vendor/ (trong bản exe không có file thật để Socket.io tự đọc)
    maxHttpBufferSize: 8 * 1024 * 1024, // đủ cho các mảnh relay 256KB + ảnh xem trước
    pingInterval: 10000,
    pingTimeout: 20000,
  });
  attachSignaling(io);
  setupAutoExit(io);

  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !EXPLICIT_PORT && attempts < 10) {
      attempts++;
      PORT++;
      server.listen(PORT, '0.0.0.0');
    } else if (err.code === 'EADDRINUSE') {
      fatal(`\n  Cổng ${PORT} đang được dùng. Thử: PORT=${PORT + 1} npm start (hoặc --port ${PORT + 1})\n`);
    } else if (err.code === 'EACCES') {
      fatal(`\n  Không đủ quyền mở cổng ${PORT}. Hãy dùng cổng >= 1024 hoặc chạy với quyền quản trị.\n`);
    } else {
      fatal(String(err && err.stack || err));
    }
  });

  server.on('listening', printBanner);
  server.listen(PORT, '0.0.0.0');
})().catch((err) => fatal(String(err && err.stack || err)));
