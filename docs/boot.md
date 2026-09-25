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
- The app is ONE file. `build.mjs` bundles `js/` with esbuild into
  `dist/app.js`: minified, lowered to what Safari 13 understands, with a
  source map that points back at `js/`. 466 KB in 33 requests became
  174 KB (53 KB gzipped) in one. `index.html` preloads it next to the SDK.
  `js/` is still the source and is what you edit. `dist/` is committed
  because the host serves the repo as it is, with no build step. The
  smoke suite rebuilds in memory and fails if `dist/app.js` differs.
  The tests themselves swap the bundle for `import "/js/app.js"` so that
  their own `import('/js/…')` reaches the same module instances. They
  check the real bundle separately: it boots, and it is the only app
  script fetched.
- There is no icon font any more. Boxicons came from unpkg after the
  first paint and a slow network left empty circles in the nav and the
  chat until it arrived. Every `bx-*` class is now drawn in style.css
  (ICONS: a mask over currentColor), and icon-only buttons are `.ico`
  inline SVG. Nothing icon-shaped is fetched.
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

With the app in one file, the old worry (one module from the cache and
its neighbour from the network, with exports that no longer match) is
mostly gone. What is left is index.html and dist/app.js arriving from
different versions. If that ever throws, the watchdog's "Try again"
fetches both fresh.
