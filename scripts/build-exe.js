'use strict';
/**
 * Đóng gói MikDrop thành một file .exe chạy độc lập trên Windows (không cần cài Node.js).
 *
 *   npm run build:exe   ->   dist/MikDrop.exe
 *
 * Cách làm: esbuild gộp server.js + thư viện thành 1 file, Node SEA nhúng file đó cùng thư mục
 * public/ vào bản sao của node.exe. Cần Node.js >= 20 trên máy build (máy chạy exe thì không cần).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const exe = path.join(dist, 'MikDrop.exe');

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(full) : [full];
  });
}

(async () => {
  if (process.platform !== 'win32') throw new Error('Script này tạo MikDrop.exe nên cần chạy trên Windows.');
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

  console.log('3/4 Tạo MikDrop.exe từ node.exe + đặt biểu tượng...');
  fs.copyFileSync(process.execPath, exe);
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

  console.log('4/4 Chèn blob vào exe bằng postject...');
  await require('postject').inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(dist, 'sea-prep.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  // Đổi subsystem của exe từ Console (3) sang Windows GUI (2): chạy không hiện cửa sổ terminal.
  // Đặt MIKDROP_CONSOLE=1 khi build nếu muốn giữ cửa sổ terminal để gỡ lỗi.
  if (!process.env.MIKDROP_CONSOLE) {
    const buf = fs.readFileSync(exe);
    const pe = buf.readUInt32LE(0x3c); // vị trí chữ ký "PE\0\0"
    if (buf.readUInt32LE(pe) !== 0x4550) throw new Error('Không nhận ra định dạng PE của exe.');
    buf.writeUInt16LE(2, pe + 24 + 68); // OptionalHeader.Subsystem
    fs.writeFileSync(exe, buf);
  }

  fs.rmSync(path.join(dist, 'sea-prep.blob'), { force: true });
  const mb = (fs.statSync(exe).size / 1048576).toFixed(0);
  console.log(`\nXong: ${path.relative(root, exe)} (${mb} MB)`);
})().catch((err) => {
  console.error('\nBuild thất bại:', err.message);
  process.exit(1);
});
