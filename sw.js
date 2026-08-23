/**
 * sw.js — offline shell.
 *
 * Multi-device play is meant for places with no signal, which means a guest
 * following the invite QR must be able to load the app with the network down.
 * Everything is precached on install; the font stylesheet is cached at runtime
 * because it is cross-origin and opaque.
 *
 * Bump CACHE when shipping. Old caches are dropped on activate.
 */

const CACHE = 'marker-mayhem-v2';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './src/styles.css',
  './src/game.js',
  './src/rng.js',
  './src/words.js',
  './src/tally.js',
  './src/feedback.js',
  './src/storage.js',
  './src/storage-web.js',
  './src/share.js',
  './src/sync.js',
  './src/joincode.js',
  './src/qr.js',
  './src/scan.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is all-or-nothing; a single 404 would leave the app uncached
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Navigations: network first so a deployed update is picked up, cache as
  // the fallback so an offline guest still gets in.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || Response.error()))
    );
    return;
  }

  // Everything else: cache first, since the shell is versioned by CACHE name.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((res) => {
            if (res.ok || res.type === 'opaque') {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => hit || Response.error())
    )
  );
});
