'use strict';
/**
 * Đóng gói MikDrop thành một file chạy độc lập (không cần cài Node.js trên máy chạy).
 *
 *   npm run build:exe     (trên Windows)  ->   dist/MikDrop.exe
 *   npm run build:linux   (trên Linux)    ->   dist/mikdrop-linux-x64  (hoặc -arm64)
 *
 * Cách làm: esbuild gộp server.js + thư viện thành 1 file, Node SEA nhúng file đó cùng thư mục
 * public/ vào bản sao của node. Cần Node.js >= 20 (bản chính thức từ nodejs.org) trên máy build,
 * và phải build trên đúng hệ điều hành đích (file node được sao chép nguyên văn).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const isWin = process.platform === 'win32';
const exeName = isWin ? 'MikDrop.exe' : `mikdrop-linux-${process.arch}`;
const exe = path.join(dist, exeName);

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(full) : [full];
  });
}

(async () => {
  if (!isWin && process.platform !== 'linux') throw new Error('Chỉ hỗ trợ build trên Windows (MikDrop.exe) hoặc Linux.');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  console.log('1/4 Gộp mã nguồn bằng esbuild...');
  await require('esbuild').build({
    entryPoints: [path.join(root, 'server.js')],
    outfile: path.join(dist, 'server.bundle.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['bufferutil', 'utf-8-validate'], // tuỳ chọn của ws, có thì nhanh hơn, không có vẫn chạy
    logLevel: 'warning',
  });

  console.log('2/4 Nhúng giao diện (public/) và tạo blob SEA...');
  const assets = {};
  for (const f of listFiles(path.join(root, 'public'))) {
    assets[path.relative(root, f).split(path.sep).join('/')] = path.relative(root, f);
  }
  const seaConfig = path.join(dist, 'sea-config.json');
  fs.writeFileSync(
    seaConfig,
    JSON.stringify({
      main: path.relative(root, path.join(dist, 'server.bundle.js')),
      output: path.relative(root, path.join(dist, 'sea-prep.blob')),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets,
    })
  );
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: root, stdio: 'inherit' });

  console.log(`3/4 Tạo ${exeName} từ bản sao của node${isWin ? ' + đặt biểu tượng' : ''}...`);
  fs.copyFileSync(process.execPath, exe);
  if (isWin) {
    try {
      await require('rcedit').rcedit(exe, {
        icon: path.join(__dirname, 'MikDrop.ico'),
        'version-string': {
          ProductName: 'MikDrop',
          FileDescription: 'MikDrop - chia sẻ tệp ngang hàng qua Wi-Fi',
          OriginalFilename: 'MikDrop.exe',
        },
      });
    } catch (err) {
      console.warn('   (Bỏ qua đặt biểu tượng: ' + err.message + ')');
    }
  }

  console.log('4/4 Chèn blob vào exe bằng postject...');
  await require('postject').inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(dist, 'sea-prep.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  // Đổi subsystem của exe từ Console (3) sang Windows GUI (2): chạy không hiện cửa sổ terminal.
  // Đặt MIKDROP_CONSOLE=1 khi build nếu muốn giữ cửa sổ terminal để gỡ lỗi.
  if (isWin && !process.env.MIKDROP_CONSOLE) {
    const buf = fs.readFileSync(exe);
    const pe = buf.readUInt32LE(0x3c); // vị trí chữ ký "PE\0\0"
    if (buf.readUInt32LE(pe) !== 0x4550) throw new Error('Không nhận ra định dạng PE của exe.');
    buf.writeUInt16LE(2, pe + 24 + 68); // OptionalHeader.Subsystem
    fs.writeFileSync(exe, buf);
  }

  if (!isWin) fs.chmodSync(exe, 0o755);
  fs.rmSync(path.join(dist, 'sea-prep.blob'), { force: true });
  const mb = (fs.statSync(exe).size / 1048576).toFixed(0);
  console.log(`\nXong: ${path.relative(root, exe)} (${mb} MB)`);
})().catch((err) => {
  console.error('\nBuild thất bại:', err.message);
  process.exit(1);
});
