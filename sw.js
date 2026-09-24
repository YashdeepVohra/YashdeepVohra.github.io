/**
 * The service worker: installable, and a copy of the app for bad signal.
 *
 * It used to pass everything straight to the network, on purpose — a
 * caching worker on an app that ships as loose files is the classic way
 * to strand every user on last week's version. That is still true, so
 * this one is NETWORK FIRST for our own files: whenever the network
 * answers, you get the current file and the cache quietly keeps a copy.
 * The copy is only used when the network fails outright, or is so slow
 * that waiting would mean "The app didn't start" (TIMEOUT_MS). A stale
 * copy served that way is refreshed in the background, so the next open
 * is current.
 *
 * Third-party files are only cached when their URL carries a version
 * (the Firebase SDK at 9.23.0, boxicons@2.1.4, font files): those can
 * never change under the same address, so they are served from the
 * cache first and cost nothing after the first visit.
 *
 * Never touched: anything that isn't a GET, Firebase Auth's /__/auth/
 * handler, and every call to Firestore or Google APIs — the data has
 * its own offline cache (enablePersistence) and must never be stale.
 *
 * Bump VERSION only to throw every cached copy away; activate deletes
 * any cache whose name doesn't carry it.
 */
const VERSION = "v2";
const APP_CACHE = `livesociya-app-${VERSION}`;
const CDN_CACHE = `livesociya-cdn-${VERSION}`;
const TIMEOUT_MS = 4000;

const VERSIONED_CDN = [
  (u) => u.hostname === "www.gstatic.com" && u.pathname.startsWith("/firebasejs/"),
  (u) => u.hostname === "unpkg.com" && u.pathname.startsWith("/boxicons@"),
  (u) => u.hostname === "fonts.gstatic.com"
];
const isFontCss = (u) => u.hostname === "fonts.googleapis.com" && u.pathname.startsWith("/css");

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = [APP_CACHE, CDN_CACHE];
    for (const name of await caches.keys()) {
      if (!keep.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/__/")) return;          // auth handler
    if (url.pathname === "/sw.js") return;
    e.respondWith(networkFirst(e, req));
    return;
  }
  if (VERSIONED_CDN.some((test) => test(url))) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (isFontCss(url)) {
    e.respondWith(networkFirst(e, req));
    return;
  }
  // Everything else — Firestore, Auth, analytics — goes straight out.
});

/** A page is one copy whatever its ?e= says, so a shared link still opens offline. */
function cacheKey(req) {
  return req.mode === "navigate" ? new Request(new URL("/", self.location.origin).href) : req;
}

async function networkFirst(e, req) {
  const cache = await caches.open(APP_CACHE);
  const key = cacheKey(req);
  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === "opaque")) {
      const copy = res.clone();
      e.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  });
  // Keep the refresh alive even if the cached copy wins the race.
  e.waitUntil(network.catch(() => {}));

  const cached = await cache.match(key);
  if (!cached) return network;              // first visit: nothing to fall back to

  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(cached), TIMEOUT_MS); });
  try {
    return await Promise.race([network.catch(() => cached), slow]);
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
  return res;
}
