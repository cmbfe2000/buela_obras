/* Service worker: app shell precache + offline images. Content lives in IndexedDB. */
const VERSION = 'pb-v1.4.0';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'vendor/minisearch.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'fonts/eb-garamond-latin-400-normal.woff2', 'fonts/eb-garamond-latin-400-italic.woff2',
  'fonts/eb-garamond-latin-600-normal.woff2', 'fonts/eb-garamond-latin-600-italic.woff2',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-500-normal.woff2', 'fonts/inter-latin-600-normal.woff2'];
const IMG = 'pb-img-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(async c => {
    await c.addAll(SHELL);
    // optional bundled snapshot (only present if generated with scripts/snapshot.mjs)
    try { const r = await fetch('data/snapshot.json', { cache: 'no-cache' }); if (r.ok) await c.put('data/snapshot.json', r); } catch {}
  }));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMG).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/wp-json/')) return; // API: always network
  if (url.pathname.includes('/data/books/')) return; // books go to IndexedDB: always network
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') { e.respondWith(caches.match('index.html').then(r => r || fetch(req))); return; }
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
    return;
  }
  if (req.destination === 'image' || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url.pathname)) {
    e.respondWith(caches.open(IMG).then(async c => {
      const hit = await c.match(req.url); if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req.url, r.clone()); return r; } catch { return new Response('', { status: 504 }); }
    }));
  }
});
