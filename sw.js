// Periscope Strategy service worker: versioned offline cache
const VERSION = 'ps-v4';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/ui-common.js', 'js/board.js', 'js/exports.js',
  'js/engine.js', 'js/engine.worker.js',
  'assets/brand/logo-horizontal.svg', 'assets/brand/logo-mono.svg', 'assets/brand/emblem.svg',
  'assets/brand/favicon.svg', 'assets/brand/favicon-32.png', 'assets/brand/icon-192.png',
  'assets/brand/icon-512.png', 'assets/brand/apple-touch-icon.png',
  'install.html', 'assets/brand/logo-stacked.svg',
];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !RUNTIME_HOSTS.includes(url.hostname)) return;
  if (req.mode === 'navigate') {
    // network first for the page, fall back to cached shell
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put('index.html', c)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  // stale-while-revalidate
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: same });
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
