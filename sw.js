/**
 * A service worker that does nothing on purpose.
 *
 * A browser will not offer "add to home screen" unless a site has a
 * manifest, an icon of at least 192px, and a registered service worker
 * with a fetch handler. That is the only reason this file exists.
 *
 * It deliberately does NOT cache anything. A caching service worker on
 * an app that ships as loose files is the classic way to strand every
 * user on a version from last week — they reload, they get the cache,
 * and no amount of pushing fixes it. Firestore's own offline
 * persistence already handles being offline for the part that matters,
 * which is the data.
 *
 * If caching is ever added here, it must come with a version string and
 * a real activate handler that deletes the old caches. Until then, the
 * honest thing is to pass everything through.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* straight to the network */ });
