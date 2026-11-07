// The offline helper (a "service worker"). It lets the app open with no internet,
// and lets Chrome install it as an app.
//
// It always asks the website first, so you get the newest version whenever you're
// online. Only when that fails (offline) does it use the copy it kept last time.
// Your boards don't go through here: they live in Chrome's storage on your computer.

const CACHE = 'reference-board';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only the app's own files. Image searches and other websites pass straight through.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        await cache.put(req, res.clone());
        // Each update has new ?v= numbers: drop older copies of the same file.
        if (url.search.includes('v=')) {
          for (const old of await cache.keys()) {
            const o = new URL(old.url);
            if (o.pathname === url.pathname && o.search !== url.search) cache.delete(old);
          }
        }
      }
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === 'navigate' && await cache.match(new URL('./', self.location).href));
      if (hit) return hit;
      throw err;
    }
  })());
});
