/* Caches the shell so the app opens without network. Data is never cached —
 * a stale box listing is worse than an honest error. */

const CACHE = 'concordance-shell-v1';

// Relative so the worker is indifferent to the prefix it is mounted under.
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest',
               './icon.svg', './vendor/jsQR.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;      // always live

  // Navigations fall back to the cached shell when offline; hash routing means
  // one cached document serves every screen.
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    return;
  }

  e.respondWith(
    caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }))
  );
});
