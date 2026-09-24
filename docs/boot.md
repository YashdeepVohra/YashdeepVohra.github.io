# Starting on a bad network

Read before touching `index.html`'s head, the boot watchdog at the bottom
of it, or `sw.js`.

## What was wrong

On a phone with weak signal the app often showed "The app didn't start —
js/app.js failed to load". Usually nothing had failed. Three things
stacked up:

1. The three Firebase SDK files (well over 100 KB compressed) were plain
   blocking `<script>` tags in the head. Nothing painted until all three
   had arrived.
2. The app is ~33 ES modules with no bundler. A browser only learns about
   a module when it parses the one that imports it, so the graph was
   fetched about six round trips deep. On a 600 ms round trip that is
   seconds before a single line runs.
3. The watchdog gave up after a fixed 12 seconds and blamed app.js, even
   when the app was still arriving.

## What it does now

- The SDK tags are `defer`. Deferred classic scripts and module scripts
  run in document order, so `firebase` still exists before `js/app.js`
  runs, but the page paints first.
- Every module is a `<link rel="modulepreload">`, so all of them download
  at once. `test/smoke.mjs` walks the import graph and fails on a module
  missing from the list, or on a listed one nothing imports. Add a module
  and you add its line.
- boxicons loads with `media="print" onload="this.media='all'"`, so it
  never holds up the first paint. That is why every icon-only button is
  drawn (`.ico`, inline SVG). A slow unpkg used to leave empty circles.
- The watchdog only fails on something that FAILED: a script whose
  download errored (seen in the capture phase on window), or our own code
  throwing before boot. A network failure reloads once by itself
  (`sessionStorage` guards the loop), then shows "Try again". After 6 s
  it says "Slow connection — still loading…". After 40 s it offers the
  button but keeps waiting. Coming back online reloads.
- The watchdog registers the service worker, not app.js, so it gets
  installed even on a visit where the app never started.

## The service worker

It used to cache nothing, on purpose. With loose files and no hashes, a
cache-first worker strands everyone on an old version. So:

- Our own files are NETWORK FIRST. If the network answers, you get the
  current file and the cache keeps a copy. The copy is only used when the
  network fails, or takes longer than `TIMEOUT_MS` (4 s). Even then the
  fetch carries on and refreshes the cache for next time.
- Navigations are cached under `/`, so `?e=<id>` links open offline too.
- Cache-first is only for URLs that carry a version and so can never
  change: `firebasejs/9.23.0`, `boxicons@2.1.4`, font files.
- Firestore, Auth, `/__/` and anything that isn't a GET pass straight
  through. The data has its own offline cache (`enablePersistence`).
- Bumping `VERSION` throws every cached copy away on the next activate.

The known cost: on a slow line right after a deploy, one module can come
from the cache and its neighbour from the network. If their exports no
longer match, the app throws while starting, the watchdog shows "Try
again", and the retry gets consistent files. That is rare, and better
than never starting at all.
