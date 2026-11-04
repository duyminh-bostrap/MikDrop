'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { inflateRawSync } = require('node:zlib');
const source = fs.readFileSync('public/app.js', 'utf8');
const zipCode = source.slice(source.indexOf('  const CRC_TABLE'), source.indexOf('  // Nhận thư mục'));
const ctx = vm.createContext({ Blob, Response, CompressionStream, TextEncoder, Uint32Array, Uint8Array, DataView, ArrayBuffer, Date, READ_BLOCK: 1024 });
vm.runInContext(zipCode + '\nthis.buildZip = buildZip;', ctx);
(async () => {
  const content = 'hello '.repeat(10000);
  const zip = Buffer.from(await (await ctx.buildZip([
    { path: 'folder/ảnh.txt', blob: new Blob([content]) },
    { path: 'folder/empty', blob: new Blob([]) },
  ])).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const method = zip.readUInt16LE(8);
  const size = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), 'folder/ảnh.txt');
  const payload = zip.subarray(30 + nameLength, 30 + nameLength + size);
  assert.equal((method === 8 ? inflateRawSync(payload) : payload).toString(), content);
  assert.equal(zip.readUInt32LE(22), Buffer.byteLength(content));
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  const central = zip.readUInt32LE(zip.length - 6);
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  let crc = -1;
  for (const byte of Buffer.from(content)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  assert.equal(zip.readUInt32LE(central + 16), (crc ^ -1) >>> 0);
  // Multiple read blocks must wait for receiver credit before proceeding.
  const transfer = { files: [new Blob(['x'.repeat(3000)])], sent: 0, flow: true };
  let checkpoints = 0;
  let sent = 0;
  const sendContext = vm.createContext({
    performance, READ_BLOCK: 1024, TERMINAL: new Set(['done', 'error']),
    upsertCard() {}, relPathOf() { return ''; }, tick() {}, setTimeout, clearTimeout,
    fail(t, reason) { throw new Error(reason); },
  });
  const sendCode = source.slice(source.indexOf('  async function runSend'), source.indexOf('  function onSenderCtrl'));
  vm.runInContext(sendCode + '\nthis.runSend = runSend;', sendContext);
  await sendContext.runSend(transfer, {
    chunk: 256, inflight: () => 0,
    async sendBin(buf) { sent += buf.byteLength; },
    async sendCtrl(msg) {
      if (msg.t === 'checkpoint') {
        checkpoints++;
        const before = sent;
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(sent, before);
        transfer.credit();
      }
    },
  });
  assert.equal(sent, 3000);
  assert.equal(checkpoints, 3);
  assert.equal(transfer.status, 'finishing');
  ctx.CompressionStream = undefined;
  const stored = Buffer.from(await (await ctx.buildZip([{ path: 'plain.txt', blob: new Blob(['123456789']) }])).arrayBuffer());
  assert.equal(stored.readUInt16LE(8), 0);
  assert.equal(stored.readUInt32LE(14), 0xcbf43926);
  assert.equal(stored.subarray(39, 48).toString(), '123456789');
  console.log('ZIP compression/store, Unicode, CRC, and transfer backpressure passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
