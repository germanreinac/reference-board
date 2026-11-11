// The offline helper (a "service worker"). It lets the app open with no internet,
// and lets Chrome install it as an app, and makes it start quickly.
//
// The app's code files have a fingerprint of their contents in their address (?v=…, see
// tools/stamp-version.py), so a given address never changes: those are kept and reused
// straight away, with no trip to the website. The page itself (which lists the current
// fingerprints) always asks the website first, so you get the newest version whenever
// you're online; only when that fails (offline) is the kept copy used.
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
    const fixed = url.search.includes('v=');
    if (fixed) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        // (Kept in the background: the page doesn't wait for it.)
        e.waitUntil((async () => {
          await cache.put(req, res.clone());
          // A new fingerprint: drop older copies of the same file.
          if (fixed) {
            for (const old of await cache.keys()) {
              const o = new URL(old.url);
              if (o.pathname === url.pathname && o.search !== url.search) cache.delete(old);
            }
          }
        })());
      }
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === 'navigate' && await cache.match(new URL('./', self.location).href));
      if (hit) return hit;
      throw err;
    }
  })());
});
