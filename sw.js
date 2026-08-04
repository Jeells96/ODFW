// Oregon Hunt Planner — offline service worker.
//
// The whole point: hunters open this app in the field, where there is often no
// signal at all. The hunt data itself already survives offline (it's mirrored
// into localStorage), but without this the page shell, the unit maps, and the
// CDN libraries would fail to load and there'd be nothing to show it in.
//
// Strategy, per request type:
//   navigation (the HTML)  → network-first, fall back to the cached shell.
//                            Keeps the app self-updating when there IS signal.
//   same-origin assets     → cache-first (icons, unit maps — they never change
//                            without a filename change).
//   CDN libraries          → stale-while-revalidate, so a cold offline start
//                            still gets xlsx / pdf.js / firebase.
//   Firestore              → never touched. Live data must not be faked from a
//                            stale cache; the app has its own offline path.
//
// Bump CACHE when the shell changes — old caches are dropped on activate.
const CACHE = 'ohp-v7.9.0';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './map-base.png',
  './map-deer.png',
  './map-elk.png'
];

// Only what every visit needs. xlsx and pdf.js are ~1.2 MB and admin-only —
// they get cached by the runtime rule below the first time someone uploads a
// file, rather than costing every reader that download up front.
const CDN = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js'
];

// Live data — always straight to the network, never served from cache.
// generativelanguage = the Gemini AI calls; caching those would replay stale
// answers and silently skip the quota bookkeeping.
const NEVER_CACHE = /firestore\.googleapis\.com|firebaseinstallations|googleapis\.com\/identitytoolkit|firebaselogging|generativelanguage\.googleapis\.com/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // The shell must all land or the install fails (that's the point).
    await c.addAll(SHELL);
    // The CDN copies are best-effort — a blocked CDN shouldn't break install.
    await Promise.all(CDN.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NEVER_CACHE.test(url.href)) return;

  // The HTML: fresh when online, cached shell when not.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('./index.html', net.clone());
        return net;
      } catch (_) {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  // Same-origin assets: cache-first. Filenames are stable, so a hit is correct.
  if (sameOrigin) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const net = await fetch(req);
        if (net.ok) (await caches.open(CACHE)).put(req, net.clone());
        return net;
      } catch (_) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // CDN libraries: serve the cached copy immediately, refresh it in the
  // background. Offline cold starts get a working app; online ones stay current.
  if (/cdnjs\.cloudflare\.com|gstatic\.com/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      const net = fetch(req).then(r => {
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
        return r;
      }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});
