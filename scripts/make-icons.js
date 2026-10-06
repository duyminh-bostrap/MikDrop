'use strict';
// Tạo biểu tượng PNG (tràn viền, iOS tự bo góc) mà không cần thư viện ngoài: node scripts/make-icons.js
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

// Khoảng cách từ điểm tới đoạn thẳng
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Mũi tên tải xuống (toạ độ trong hệ 0..1), nằm trong vùng an toàn 60% giữa ảnh
const SEGS = [
  [0.5, 0.26, 0.5, 0.58], [0.5, 0.58, 0.39, 0.47], [0.5, 0.58, 0.61, 0.47],
  [0.3, 0.7, 0.3, 0.74], [0.3, 0.74, 0.7, 0.74], [0.7, 0.74, 0.7, 0.7],
];
const WIDTH = 0.04;

function render(size) {
  const SS = 3; // siêu lấy mẫu để khử răng cưa
  return png(size, (x, y) => {
    let cover = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS) / size;
        const v = (y + (sy + 0.5) / SS) / size;
        if (SEGS.some((s) => distSeg(u, v, ...s) <= WIDTH / 2)) cover++;
      }
    }
    const a = cover / (SS * SS);
    const t = (x + y) / (2 * size); // gradient chéo #0a84ff -> #5e5ce6
    const bg = [10 + (94 - 10) * t, 132 + (92 - 132) * t, 255 + (230 - 255) * t];
    return bg.map((c) => Math.round(c * (1 - a) + 255 * a));
  });
}

const out = path.join(__dirname, '..', 'public');
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(path.join(out, name), render(size));
  console.log('wrote', name);
}
