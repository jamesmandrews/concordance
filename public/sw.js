/* Offline shell cache.
 *
 * Network-first for anything that is actually the app, cache-first only for
 * immutable vendor code. A cache-first shell is the wrong default here: it
 * will happily serve a build whose API calls no longer exist, and the symptom
 * -- a 404 from an endpoint that was removed -- looks like a server fault
 * rather than a stale client. Trading a little speed for always running the
 * deployed code is the right way round.
 *
 * Data is never cached. A stale box listing is worse than an honest error. */

const CACHE = 'concordance-shell-v2';

// Relative, so the worker is indifferent to the prefix it is mounted under.
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest',
               './icon.svg', './vendor/jsQR.js'];

const IMMUTABLE = /\/vendor\//;

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

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  } catch {
    const hit = await caches.match(request);
    if (hit) return hit;
    // A navigation offline still gets the shell; hash routing means one
    // cached document serves every screen.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(request) {
  return (await caches.match(request)) ?? fetch(request);
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;      // always live

  e.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(request) : networkFirst(request));
});
