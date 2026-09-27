# Testing

No emulator, no network, no credentials. `test/stub.js` is a hand-written
stand-in for the Firebase compat SDK with working `orbit` and `events`
collections (events `get()` really applies where / orderBy / limit /
startAfter), batches that really apply, and counters on `window.__reads` /
`window.__writes`.

```
npm install                        # once: esbuild (and put playwright on the path)
python3 -m http.server 8111        # from the repo root
node test/smoke.mjs                # CHROME_PATH=... if playwright has no browser
node test/contrast.mjs             # no browser, no network — just the palette
```

Handles inside a page: `window.__m` (the modules), `window.__events` +
`window.__fireEvents()`, `window.__orbit` + `window.__fireOrbit()`,
`window.__stubDocs['users/uid']`, `window.__authSingleton.currentUser`.
Note `window.showTab` is app.js's `goToTab`, which closes an open chat on
its way; use `ui.showTab` when a test needs the chat to stay open.

The suite is green. It was red on two for a long time — the dead scroll
container on the laptop profile, and the claim screen on a short window
— and `docs/layout.md` had described the fix for both the whole time.
The CSS is in the sheet now.

Every rule above came from something that broke. Add a case when
something breaks again.


## Running it from a Cowork session (how it has actually been done)

The user's computer (the VM that `device_bash` reaches) has node and
esbuild but NO Playwright or browser, and its network cannot download
one. The cloud container has Chromium and Playwright. So:

1. On the device: `npm run build`, then
   `tar czf _sync.tgz --exclude=./node_modules --exclude=./.git --exclude='./Claude outputs' --exclude=./_backup_pre_uid --exclude=./_sync.tgz .`
   (`_sync.tgz` is git-ignored and Vercel-ignored.)
2. Stage `_sync.tgz` into the container, extract it into a working dir,
   `npm install esbuild@0.24.0`, and symlink the global Playwright:
   `ln -s $(npm root -g)/playwright node_modules/playwright` (and
   `playwright-core`).
3. `python3 -m http.server 8111 &` in that dir, then `node test/smoke.mjs`
   (~6 min) and `node test/contrast.mjs`.
4. Edits to `test/smoke.mjs` made in the container go back with
   `device_commit_files`; source edits are made on the device.

Test hooks worth knowing: `window.__stubDocs['path']` (seed or read any
document), `window.__lastBatch` (the last batch's ops), `window.__updates`,
`window.__uploads` / `window.__storageDeletes` (Storage stub),
`window.__m` (modules, after `seed()`), and in `limitsService`
`__resetPostGapForTest()` before any post in a test. Photos are off by
default: a test flips `features.photos` on and back off.

Screenshots for design checks: a small Playwright script that loads the
page with the stub, seeds `state`, and calls the screen's open function
— see any `shots*.mjs` pattern in past sessions; it is not committed.
