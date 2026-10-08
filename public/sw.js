/* MikDrop - service worker
 *
 * Chỉ làm một việc: nhận tệp từ nút "Chia sẻ" của Android (Web Share Target, xem share_target trong manifest).
 * Chrome gửi tệp bằng POST /share-target; ở đây ta cất tệp vào Cache Storage rồi chuyển về trang chủ,
 * nơi app.js lấy tệp ra và đưa vào danh sách chờ gửi. Không cache giao diện (luôn lấy bản mới từ server).
 */
const SHARE_CACHE = 'mikdrop-share';
const abs = (path) => new URL(path, self.location.href).href;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(takeShare(event.request));
  }
});

async function takeShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => typeof f !== 'string');
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    await Promise.all(files.map((f, i) => cache.put(
      new Request(abs(`/_shared/${i}`)),
      new Response(f, {
        headers: {
          'Content-Type': f.type || 'application/octet-stream',
          'X-Name': encodeURIComponent(f.name || `file-${i}`),
          'X-Modified': String(f.lastModified || Date.now()),
        },
      })
    )));
  } catch (err) {
    /* lỗi thì vẫn về trang chủ để người dùng tự chọn tệp */
  }
  return Response.redirect(abs('/?share=1'), 303);
}
