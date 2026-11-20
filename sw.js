// 名片夾 Service Worker：離線快取、Android 分享名片包到 App
const VERSION = 'mpj-v1.0.0';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/core.js', './js/crypto.js', './js/db.js', './js/ocr.js', './js/ui.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './tessdata/chi_tra.traineddata.gz', './tessdata/eng.traineddata.gz',
];
// 若部署時已放入本站版 Tesseract（見 README／GitHub Actions），一併快取
const OPTIONAL = [
  './vendor/tesseract/tesseract.min.js', './vendor/tesseract/worker.min.js',
  './vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js', './vendor/tesseract-core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core/tesseract-core-simd.wasm.js', './vendor/tesseract-core/tesseract-core.wasm.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(OPTIONAL.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'mpj-inbox' && k !== 'mpj-cdn') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Android：從其他 App「分享」名片包給名片夾
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const files = fd.getAll('pack').filter(f => f && typeof f === 'object');
        const inbox = await caches.open('mpj-inbox');
        let i = 0;
        for (const f of files) await inbox.put(new Request('./inbox/' + Date.now() + '-' + (i++)), new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || '名片包.json') } }));
      } catch { }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }) || (e.request.mode === 'navigate' ? await c.match('./index.html') : null);
      const net = fetch(e.request).then(r => { if (r.ok && !url.pathname.includes('/inbox/')) c.put(e.request, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response('離線中，找不到這個檔案', { status: 504 });
    })());
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // 未自架辨識元件時，從 CDN 下載後保存，之後可離線使用
    e.respondWith((async () => {
      const c = await caches.open('mpj-cdn');
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    })());
  }
});
