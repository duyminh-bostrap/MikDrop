'use strict';
// Tạo biểu tượng PNG (nền đen tràn viền, iOS tự bo góc) từ logo MikDrop mà không cần thư viện ngoài:
//   node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Logo (cùng hình học với public/logo.svg; toạ độ hệ 1240x1240) --------------------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Mỗi hình: đa giác, bán kính bo góc, gradient (điểm đầu/cuối theo khung bao 0..1)
const SHAPES = [
  { pts: [[668, 513], [952, 325], [968, 342], [968, 703]], g: ['#ff5a17', '#f03509', [0, 0], [1, 1]] },
  { pts: [[661, 712], [905, 865], [695, 998], [680, 1003], [661, 982]], g: ['#e03309', '#ff5c1c', [0, 0], [1, 1]] },
  { pts: [[216, 462], [232, 440], [409, 548], [409, 800], [244, 918], [216, 900]], g: ['#e6400d', '#ff6e20', [1, 0], [0, 1]] },
  { pts: [[230, 438], [385, 348], [420, 355], [968, 703], [968, 805], [905, 865], [661, 712], [409, 545]], g: ['#ff8a3d', '#fb7330', [0, 0], [1, 1]] },
];
const ROUND = 7; // nửa độ dày nét bo góc
const DOT = { c: [1068, 345], r: 68, g: ['#ff4d12', '#ff8a3d', [0, 1], [1, 0]] };

const inPoly = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const distSeg = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const hit = (x, y, pts) =>
  inPoly(x, y, pts) || pts.some((p, i) => distSeg(x, y, p, pts[(i + 1) % pts.length]) <= ROUND);

const bbox = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - ROUND, Math.min(...ys) - ROUND, Math.max(...xs) + ROUND, Math.max(...ys) + ROUND];
};
const gradColor = ([c1, c2, s, e], [x0, y0, x1, y1], x, y) => {
  const px = s[0] + (e[0] - s[0]), py = s[1] + (e[1] - s[1]);
  const u = (x - x0) / (x1 - x0), v = (y - y0) / (y1 - y0);
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const t = Math.max(0, Math.min(1, ((u - s[0]) * dx + (v - s[1]) * dy) / (dx * dx + dy * dy || 1)));
  const a = hex(c1), b = hex(c2);
  return a.map((v0, i) => v0 + (b[i] - v0) * t);
};

// Điểm (x, y) trong hệ logo -> màu logo hoặc null
function logoAt(x, y) {
  if ((x - DOT.c[0]) ** 2 + (y - DOT.c[1]) ** 2 <= DOT.r ** 2) {
    const [cx, cy] = DOT.c;
    return gradColor(DOT.g, [cx - DOT.r, cy - DOT.r, cx + DOT.r, cy + DOT.r], x, y);
  }
  for (let i = SHAPES.length - 1; i >= 0; i--) {
    if (hit(x, y, SHAPES[i].pts)) return gradColor(SHAPES[i].g, bbox(SHAPES[i].pts), x, y);
  }
  return null;
}

const BG = hex('#0a0a0b');
// Khung logo: x 216-1136, y 277-1003 -> tâm (676, 640)
const CX = 676, CY = 640, LOGO_W = 920;

function render(size, fill) {
  const SS = 3;
  const scale = (size * fill) / LOGO_W; // px trên mỗi đơn vị logo
  return png(size, (px, py) => {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = CX + (px + (sx + 0.5) / SS - size / 2) / scale;
        const y = CY + (py + (sy + 0.5) / SS - size / 2) / scale;
        const c = logoAt(x, y) || BG;
        for (let k = 0; k < 3; k++) acc[k] += c[k];
      }
    }
    return acc.map((v) => Math.round(v / (SS * SS)));
  });
}

const out = path.join(__dirname, '..', 'public');
// Logo chiếm 56% ảnh: nằm trong vùng an toàn của biểu tượng "maskable"
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(path.join(out, name), render(size, 0.56));
  console.log('wrote', name);
}
