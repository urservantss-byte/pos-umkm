// POS UMKM service worker — offline-first app shell
const CACHE = 'pos-umkm-v1';
const SHELL = [
  './', './index.html',
  './style.css?v=1', './app.js?v=1', './manifest.json?v=1',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API: network-first (data harus segar), fallback gagal diam-diam
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(
      JSON.stringify({ error: 'offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }
  // Navigasi: network-first, fallback cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const c = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, c)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Aset statis: cache-first
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const c = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, c)); return r;
    }))
  );
});
