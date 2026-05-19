// Sticky Note PWA — Service Worker (network-first for code, cache fallback for offline)
const CACHE = 'sticky-v6';
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never intercept cross-origin (API calls).
  if (url.origin !== self.location.origin) return;

  // Network-first with cache bypass: always fetch latest, fall back to cache when offline.
  // Bypassing HTTP cache via { cache: 'no-store' } avoids stale assets from GH Pages CDN.
  const networkReq = new Request(req.url, {
    method: 'GET',
    headers: req.headers,
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'follow',
  });
  e.respondWith(
    fetch(networkReq)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});
