# livesociya — working notes

**What it is.** An app for things happening *right now* — open to
everyone, made first for college students: somebody starts an event,
everyone nearby sees it instantly, it vanishes when it ends. Plus
direct messages, memories, stories and a social graph. Live at
livesociya.com. Firestore, vanilla ES modules, no framework; esbuild
bundles `js/` into `dist/app.js` (`build.mjs`).

**Start here — don't read the codebase.** This file is loaded into every
session, so it holds only the RULES and pointers. To find code, open
**`docs/map.md`** ("I want to change X → open file Y, function Z"), then
read only that file. Each rule below names the `docs/` file with its
story; read that one before changing the area, and no others.

| For | Read |
|---|---|
| Where code lives | `docs/map.md` |
| What is built, what the USER still has to do (Blaze day, App Check) | `docs/status.md` |
| Running the tests from here | `docs/testing.md` |
| What each feature costs in reads | `docs/cost.md` |
| Ceilings, rate limits, what could fall over | `docs/scale.md` |
| Rules/attack model | `SECURITY.md` |

---

## How to work here

- The repo lives on the user's machine. Edit it there (`device_bash`);
  tests run in the cloud container (`docs/testing.md` — the device has
  no browser).
- **`node --check` every changed .js; `npm run build` after any change
  under `js/`** (the browser loads `dist/app.js`; the suite fails if stale).
- **Run `test/smoke.mjs`** before saying something works, and add a case
  for whatever you changed.
- **Commit when done and tested** (`git add -A`). The user only runs
  `git push`. End commits with the Co-Authored-By / Claude-Session lines.
- **After changing `firestore.rules`, tell the user to publish them** —
  they paste the file into Firebase console → Firestore → Rules →
  Publish (no terminal), BEFORE pushing.
- `.vercelignore` keeps `package.json`/`build.mjs` off Vercel (it would try
  to build and deploys stop). `_backup_pre_uid/` is STALE — never read it.
- A new `window.x` used by an inline `onclick` must be added to the
  `Object.assign(window, …)` block in `js/app.js`.
- **Adding to these notes costs every future session.** A rule is one
  line here; its story goes in the `docs/` file.

**Waiting on the user — remind them when it's relevant:** App Check (they
will do it on Blaze day), budget alert, the Blaze-day photo checklist,
publishing rules after every rules change. Full list: `docs/status.md`.

## The rules

Each line is the whole rule. The file after it is the argument for it.

**Identity and the database** → `docs/data.md`

- uid is the only identity the database trusts; `username` is a display
  handle, never a key and never an ownership field.
- Everything user-typed goes through `escapeHtml`, and inline `onclick`
  handlers take ids only (`safeId`), never text.
- Pair documents are one doc with a sorted composite id (`a_b`) — blocks,
  chats, orbit.
- `allow get` and `allow list` are different; a list rule must mirror the
  query's own constraint.
- What you may still do to a message you sent is `messageRules.js`: an
  EDIT (15 minutes, always leaves "edited") or a RETRACTION (a tombstone,
  never a real delete). The 15 minutes is mirrored in `firestore.rules`.
- A stamp that means "now" is `serverTimestamp()`. The exceptions are
  the three the UI has to order by before a round trip — a message's
  `time`, `chats.lastUpdated`, and an event's `startTime`/`expiresAt`,
  which are chosen rather than now — and every one of those is BOUNDED
  in `firestore.rules`. An unbounded one is a way to own a feed, an
  inbox or a thread.
- A message carries TWO stamps: `time`, the client's number, which the
  thread is ordered by; and `sentAt`, the server's, which anything that
  must not be gameable is measured against. Stamps are read through
  `msOf()` / `sentMs()`, never `new Date(x)`.
- An event carries `ttlAt`, a real Timestamp, only because a Firestore
  TTL policy needs one and it cannot be backfilled. Nothing sweeps yet
  and turning it on is unsafe until deletes cascade — `recapRules.js`
  says why.
- A bubble is identified by its document id, never by when it was sent.
- Reactions are a map keyed by uid, from a fixed list, written one dotted
  path at a time.
- The pinned message lives in `events/{id}/pinned/current` and holds a
  COPY of the text, not an id.
- The receipt folds events already in the cache and queries nothing. It
  is READ when Recap opens (`primeReceipt`), and the card paints
  nothing until it has: "not read yet" is not "nothing to show".
- How long Recap keeps an event is `recapRules.js`. Change the numbers
  there and in the smoke cases, nowhere else.
- Blocking is total: filter `isBlocked` everywhere, lists and counts alike.
- The inbox preview (`lastText`/`lastMsgId`/`lastSenderUid`) rides in the
  chat write every send already makes; the writer must name themselves
  as sender. Text is `messageRules.previewOf`.
- The inbox listens to the newest 20 chats only; older pages are one
  `get()` each ("Show older chats"). `unreadCount` counts up only while
  the other side hasn't read, back to 0 on read; rules allow +1 at most.
- Active now is `presence/{uid}`: a heartbeat while on screen, one-off
  cached gets for people on screen, never a listener. Hidden = the doc
  holds no time. `presenceService.js` has the numbers.
- Every clock time on screen goes through `clockTime()` (en-IN gave "0:58").
- The icebreaker is for STRANGERS: people who follow each other have no
  first-message limit, on a new thread or an old one.
- A locked profile fetches nothing and paints nothing — `isProfileLocked`
  is asked in the painter, not applied over the top afterwards.
- An ended event is not live — check `expiresAt`, not `startTime`.
- Events are TAGGED with a circle always; the feed only FILTERS on it
  when `feedIsScoped()` says so, which is off while there is one
  college. Turning it on needs the circleId+expiresAt index built
  first, and no migration. The social graph is never scoped.
- A circle's point is set on `circles/{id}` (console, no deploy) or in
  `FALLBACK_GEO`. Never from the device — nothing asks for a location
  until the feed is actually geographic.
- A circle carries a point, and every event copies it into `geo`.
  Nothing queries it yet — it is there so the switch to "near me" is a
  query and an index, never a migration. `geoRules.js` says what is
  left to do.
- Follow first, orbit later; a private profile you don't follow shows
  counts and a way in, nothing else.
- A follower is a DOCUMENT (`users/{uid}/followers/{uid}`), `following`
  is still an array on your own profile, and `followerCount` may only
  move in the same write as the document it counts.

**The look** → `docs/design.md`

- The canvas is never white, cards sit LIGHTER on it, and nothing casts a
  shadow except what genuinely floats.
- Three voices: `--font-display` for titles and names, `--font` for
  everything functional, `--font-mono` for metadata. Nothing in the wrong one.
- Ember means right-now and nothing else may use it. `--ember` is the
  fill, `--ember-ink` is what you read.
- A card is a poster and a recap card is its torn-off stub. The band is
  TWO COLUMNS — type left, halftone right — because siblings cannot
  overlap and coordinates can always be out-grown. `.poster-type` keeps
  `min-width: max-content`.
- A band stat reads TOP TO BOTTOM — label, number + small unit, detail
  ("STARTS IN / 45 min / at 6:40 pm"); label, value and detail are all
  volatile. A stub keeps the compact side-by-side layout (fixed --tear).
- A stub keeps its vibe colour. Taking the colour out takes the
  information out.
- Dark mode is tokens, not overrides. Never write a literal colour; add a
  role token with a value in both blocks, then run `test/contrast.mjs`.
- There is no `--violet`, `--aubergine`, `--periwinkle`, `--lavender` or
  `--plum`. If you find one in a branch, it is stale — including in a
  class name. `.accent-lavender` outlived the palette by a whole
  redesign.
- A surface is held by its BORDER, not by its shadow. `--lift-1` is
  nearly nothing and `--paper` is only 1.13:1 from the canvas, so a
  card without a hairline is barely on the page at all.

**Layout, widths and scrolling** → `docs/layout.md`

- One gutter, `--gut`, and three things must agree on it: the container's
  padding, the rail's negative margin, the rail's inner padding.
- A poster band needs a 308px card, measured. Under 350px the band drops
  its second stat.
- The card's action row WRAPS, and must keep wrapping; the primary is
  held right by `margin-left: auto`, never a `flex:1` spacer. Below
  560px it is two rows instead: Hype and Chat paired at the left, Share
  at the right, primary full width beneath.
- A transparent button at the end of a row is pulled out by its own
  padding, so its GLYPH lands on the text column rather than 14px
  inside it. Filled and outlined buttons align by their border.
- The card actions carry NO button chrome — no hover fill, no focus
  glow, no box squash. Colour is the only feedback, and on touch
  `:hover` sticks after a tap, so a fill there stays lit.
- `overscroll-behavior-y: none` killed the browser's pull-to-refresh
  along with the bounce, so `interactions/pullRefresh.js` is ours.
  Passive listeners only; it arms at the top of the feed and nowhere
  else.
- Nothing on screen may be sliced or reach past its column. The smoke
  group "nothing is cut off" holds this at 320, 390 and 1280.
- No `overflow: auto` box may be taller than the window with nothing to
  scroll. A dead scroll container is worse than no scroller at all.
- Scroll chaining behind an open layer cannot be fixed with
  `overscroll-behavior`. Left alone on purpose — don't try.
- One screen at a time, at every width. A conversation replaces the feed
  the way the profile does; the sidebar is the way out. The old
  two-pane layout gave the feed 360px on a 1280px laptop — narrower
  than a phone — and is gone. Don't bring it back.
- `button { display: flex; padding: 13px 24px; width: 100% }` is in the
  base sheet, and specificity beats source order. Anything you turn into
  a button must shed all three.
- There is no icon font. Every `bx-*` class is drawn in style.css (ICONS:
  a 24px line drawing as a mask over currentColor); a new name needs a
  new rule there, and the smoke suite fails on one that has none.
  Icon-only buttons (hype, share, emoji) are inline SVG.
- No scrollbar is ever drawn (top of `style.css`); scrolling still works.
  A full-screen layer on a phone paints canvas round itself so the app
  never shows through while the keyboard settles.
- Zoom is off everywhere, on purpose. The keyboard is handled by the
  visual viewport, not `innerHeight`.
- Orbit faces start their counter-spin at `-var(--a)` (`faceSpin`), so a
  face travels round the ring but is never turned.
- Send, the emoji button and every emoji cell cancel their own mousedown, so the keyboard never drops; nothing
  inside a fixed layer may `scrollIntoView` (on iOS it scrolls the page).
- A layer never scrolls itself: `.full-screen-view` is `overflow: clip`,
  and focusing a field scrolls only its own panel (`revealInPanel`), never
  `scrollIntoView`. Pickers move nothing. That was the half-hidden Publish.
- Phones are portrait only. A web page cannot lock rotation, so a phone
  on its side gets `.rotate-cover` and the app behind it stops painting.

**Photos** → `docs/photos.md`

- Built and OFF until Blaze: `features.photos` (js/config/features.js);
  `.needs-photos` hides everything. The switch-on checklist is in the doc.
- A photo is stored as its download URL (it names its bucket), and only
  the owner's own upload is accepted or drawn — `isOurPhotoUrl`,
  mirrored as `okPhotoUrl` in firestore.rules. Avatars: `okAvatar`.
- Compressed on the device; publishing never waits for a photo
  (`commitTray` uploads behind it). Unused uploads are deleted.
- The cover sits UNDER the band at 16:9 (max 320px), never over it.
  The event page (`eventPage.js`) is where the rest is.
- A finished event is a MEMORY (`memoryService.js`): photos from who
  went (id `<uid>_<n>`, three each), one `social/likes` doc (likes AND
  the comment count, which moves in the comment's own batch), comments.
  Never listened to. Recap cards and journal cards like/comment in place.
- A profile's finished events are the JOURNAL: memory cards, like and
  comment inside. Hiding one is `hiddenEvents` on YOUR profile, nothing else.
- A story ends at the server's createdAt + `hours` (2/3/6/12/24). Rings
  are forest, never ember. A song is a LINK, never audio under a photo.
- A report carries a copy of what was reported (`excerpt`); the admin
  is `admins/{uid}`, made in the console. `notBanned()` guards publishing.

**Scale** → `docs/scale.md`

- Every query and listener has a ceiling; a new one without a limit is a
  bug. A profile loads 12 per tab and pages ("Show older").
- Anything people can repeat is rate limited IN THE RULES, stamped in
  `private/limits` in the same batch: comments, stories and reports
  4 s apart (`postAllowed`). The ledger's own rule allows only "now".
- An event holds at most 1000 going (`HARD_CAP`, `withinCapacity`).
- Lists of people (followers, following, orbit, blocked, requests) show
  20 at a time with a shimmer sentinel (`utils/pager.js`); names are
  fetched per page, never the whole list.

**Starting on a bad network** → `docs/boot.md`

- The Firebase SDK is `defer`; the app is one preloaded file,
  `dist/app.js`. Tests load `js/` in its place (see smoke.mjs top).
- The boot watchdog fails on a real failure only, retries once, and
  says "still loading" while it is merely slow. No fixed deadline.
- `sw.js` is network-first for our own files (a cached copy after 4s or
  on failure) and cache-first only for versioned CDN URLs. It never
  touches Firestore, Auth or `/__/`.

**The mark**

- The logo is the firefly: `logo.svg` (tile), `logo-mark.svg` (no tile), PNGs
  at 16/32/48/192/512 + maskable + apple-touch, and `og-image.png`. It is an
  identity: same drawing in both themes, used as an `<img>`, never recoloured.
- Redraw `og-image.png` → bump `?v=` on every og/twitter/JSON-LD image URL;
  WhatsApp and X cache previews by URL. Copy says "around you", never
  campus-only: the product is for everyone, college first.
- `document.title` has one owner, `ui.js` (`setPageTitle`, `setTitleUnread`).
  Signed out it is the full search title; nothing else writes it. A layer
  names the tab through `LAYER_TITLES` or `openOverlay(id, { title })`.

**Painting the feed** → `docs/feed.md`

- The feed is diffed, not rebuilt. Never reintroduce `innerHTML =` in
  `syncList`.
- Nothing time-dependent may go in a card's markup — it goes in a
  `data-vt` slot that `paintVolatile()` fills after the diff.
- Filters hide, they don't re-render.
- Social state is on screen in four places; everything that changes the
  graph goes through `refreshSocialUI()`.
- Optimistic first, then the network, then roll back on failure. That
  includes PUBLISHING and DELETING an event — neither waits on a server
  round trip before the screen moves.
- The feed's order is `feedRules.js`: time buckets first, then who you
  know inside a bucket. Never sort socially across buckets — urgency
  wins, that is the product.
- A feed that fails must leave a way back on screen. Skeletons that
  never resolve are the worst outcome.
- No `window.confirm` or `alert` anywhere: `askConfirm()` and `toast()`.
- Overlays go through `js/utils/overlays.js`, so Android back works.
- The thread scrolls ITSELF constantly (new message, history prepended,
  typing). Go through `scrollThread()`, so the floating date can tell
  a thumb from us.
- A screen change closes every overlay (`switchScreen`). A layer sits
  at z-index 1500 and every screen is far below it, so anything opened
  under one is invisible until the layer goes.

**Links, embeds and shared events** → `docs/sharing.md`

- A shared link is `?e=<id>`. There is no hosting rewrite, so a pretty
  path would 404. Don't "tidy" it.
- A link is ours only if the host is livesociya.com, a subdomain of it,
  localhost or 127.0.0.1, over http(s). Never `includes()`.
- In chat an event link becomes a card; links carry `data-href`, never
  `href`, so a laptop doesn't print the URL on hover (`utils/quietLinks.js`
  arms it for right-click, middle-click and keyboard).
- A finished event has THREE states: on, over but still in Recap, and
  gone. Ask `inRecap()` before swapping a tab; say so instead of
  travelling to an empty one.
- View closes the chat, opens the event's tab and leaves a `returnChip`.
  On a laptop it is the first row of the feed column (a floating one
  broke when the frame centred); on a phone it floats bottom-left,
  level with the + button, in the strip the feed's padding keeps clear.
- A cross-origin iframe's scrollbars are reachable only through
  `scrolling="no"`.
- Share is PICK, THEN SEND: ticking a person sends nothing. Every send
  goes through `sendDirectText` (chatService), the composer's icebreaker
  rules; note + link are ONE message, or a stranger's opener is refused.

**Search** → `docs/search.md`

- One scorer, `matchRules.js`, pure and testable. Events match from the
  cache for free; people cost at most two query batches.
- A swap counts as one edit, not two (Damerau), and an exact hit must
  always outrank a corrected one.


## Cost, security, tests — one line each

- Reads are the bill: a listener bills one read per CHANGED doc per
  watcher. Roughly 31.5k/day at 300 daily actives (free tier 50k).
  Table of every decision: `docs/cost.md`.
- Rules do the enforcing, never the client; rate limits are a stamp in
  `private/limits` written in the same batch and checked with
  `getAfter()`. `SECURITY.md`.
- Tests: no emulator, no network — `test/stub.js` fakes Firebase;
  `test/smoke.mjs` (one `group()` per area), `test/contrast.mjs`.
  `docs/testing.md`.
