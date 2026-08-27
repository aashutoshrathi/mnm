/**
 * sw.js - offline shell with automated cache busting.
 * Cache Version: marker-mayhem-v-0349657f25
 */

const CACHE = 'marker-mayhem-v-0349657f25';

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
  './src/p2p.js',
  './src/duo.js',
  './src/storage.js',
  './src/storage-web.js',
  './src/share.js',
  './src/sync.js',
  './src/joincode.js',
  './src/qr.js',
  './src/scan.js',
  './src/confetti.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
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
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: 'SW_UPDATED', cache: CACHE });
          }
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // For same-origin resources (HTML, JS, CSS, WebManifest):
  // Use NETWORK-FIRST when online so updates are applied instantly,
  // falling back to CACHE seamlessly when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(request).then((hit) => {
            if (hit) return hit;
            if (request.mode === 'navigate') {
              return caches.match('./index.html').then((r) => r || caches.match('./'));
            }
            return Response.error();
          })
        )
    );
    return;
  }

  // Cross-origin resources (e.g. Google Fonts): Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((hit) => {
      const fetchPromise = fetch(request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetchPromise;
    })
  );
});
