# livesociya — working notes

**What it is.** A campus app for things happening *right now*: somebody
starts an event, everyone nearby sees it instantly, it vanishes when it
ends. Plus direct messages, and a social graph. Live at livesociya.com,
Firebase Hosting + Firestore, vanilla ES modules — no framework, no build
step. Open `index.html` over http (not `file://`, modules won't load).

This file is loaded into every session before anything is typed, so it is
kept short on purpose. It holds the RULES. The reason behind each one —
the bug it came from, the three things that were tried first — lives in
`docs/`, and each rule below names the file that explains it. Read the
matching file before changing that area; don't read them all.

---

## How to work here

- The repo lives on the user's machine. Edit it there; don't rebuild it
  in the cloud container.
- **Always `node --check` every changed .js** before committing. There is
  no build step to catch a typo.
- **Run `test/smoke.mjs`** before saying something works (see Testing).
- **Commit when a change is done and tested** (`git add -A`, so new files
  come along). The user only runs `git push` — don't leave work unstaged.
- After changing `firestore.rules`, say so — they do nothing until the
  user redeploys, and until then every limit in them is decoration.
- Commits: end with the Co-Authored-By / Claude-Session lines the session
  reminder gives.
- **Adding to these notes costs the user on every future session.** A new
  rule goes here as one line; its story goes in the `docs/` file.

## The shape of it

```
index.html          one page, every screen is a div that hides
style.css           one sheet, tokens at the top (--vibe-*, --s-*, --lift-*)
js/app.js           entry: imports, window bindings, boot, back button
js/config/          firebase init + offline persistence
js/state/store.js   one mutable object, plus resetState() on logout
js/services/        auth, events, chat, profile, follow, orbit, block,
                    search, user, limits, receipt, circle — plus the
                    pure rule files recapRules, aboutRules,
                    messageRules, receiptRules, shareRules, matchRules,
                    geoRules, feedRules
js/utils/           ui (screens/toasts/repaint registry), confirm, overlays,
                    formatters, theme, viewport
js/interactions/    search screen, message gestures (swipe, hold)
firestore.rules     ~700 lines, the real access control
test/               stub.js + smoke.mjs + contrast.mjs
docs/               why each rule below exists — read the one you need
_backup_pre_uid/    a pre-UID copy of the whole app. STALE. Never read it.
```

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
- Boxicons has no `bx-hot`. Check a class exists; anything load-bearing
  is inline SVG — and a button with an icon and NO label (hype, share)
  must be drawn, or a font that fails to load leaves nothing there.
- Zoom is off everywhere, on purpose. The keyboard is handled by the
  visual viewport, not `innerHeight`.
- Send cancels its own mousedown, so the keyboard never drops; nothing
  inside a fixed layer may `scrollIntoView` (on iOS it scrolls the page).
- Phones are portrait only. A web page cannot lock rotation, so a phone
  on its side gets `.rotate-cover` and the app behind it stops painting.

**Starting on a bad network** → `docs/boot.md`

- The Firebase SDK is `defer` and every module is a `modulepreload`;
  the smoke suite fails if the list and the import graph disagree.
- The boot watchdog fails on a real failure only, retries once, and
  says "still loading" while it is merely slow. No fixed deadline.
- `sw.js` is network-first for our own files (a cached copy after 4s or
  on failure) and cache-first only for versioned CDN URLs. It never
  touches Firestore, Auth or `/__/`.

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
- In chat an event link becomes a card but stays a real `<a href>`.
- A finished event has THREE states: on, over but still in Recap, and
  gone. Ask `inRecap()` before swapping a tab; say so instead of
  travelling to an empty one.
- View closes the chat, opens the event's tab and leaves a `returnChip`
  — the same at every width. The chip is a row at the TOP of the feed
  column, never a floating overlay: floating covered the card action
  row, and its desktop offset broke as soon as the frame centred.
- A cross-origin iframe's scrollbars are reachable only through
  `scrolling="no"`.

**Search** → `docs/search.md`

- One scorer, `matchRules.js`, pure and testable. Events match from the
  cache for free; people cost at most two query batches.
- A swap counts as one edit, not two (Damerau), and an exact hit must
  always outrank a corrected one.

## Cost model

Firestore charges per document read. A snapshot listener bills **one read
per changed document per connected client**, so the shape is
`changes x people watching`. Roughly 31.5k reads/day at 300 daily actives,
inside the 50k free tier; ~₹170/month at launch-night intensity.

Decisions already made, with the reason, so they don't get undone:

| | why |
|---|---|
| Feed capped at `LIVE_LIMIT = 60`, recap paged | the recap used to load with the feed and nobody opened it |
| Events tagged with `circleId`, filtering off for now | 60 is plenty for one campus and meaningless across many — but filtering on one value removes nothing and costs an index, so it waits for the second circle |
| Messages: 25 live + paged scrollback | full history on every chat open |
| Profiles cached in localStorage, 6h TTL | ~20 reads per open for data that changes twice a year |
| Firestore offline persistence on | resume tokens: only changed docs bill |
| Hype writes debounced 900ms | a misclick costs nothing; a burst is one write |
| `following` stays an array on your own profile | one read gives your whole list, which is what answers "am I following them?" on every card |
| `followers` is a subcollection + a `followerCount` field | the array was capped at 5000, rewrote a whole document per follow, and shipped a private account's follower list to anyone signed in. The count costs nothing to read; the list is queried only when somebody opens it |
| Recap query spans 48h, filtered client-side, max 3 pages per load | retention is computed from three fields; no server to store it |
| Profile Hosted/Joined: two `get()`s, counts from the same docs | was a listener + two duplicate count queries |
| Pinned message in a subcollection, holding a copy of the text | a field on the event bills the whole campus a read |
| Poster cards cost ~29% more DOM than the rows they replaced | measured: style recalc went 4.3ms -> 0.2ms, layout unchanged. The nodes cost nothing in a frame; the old transitions did |
| A shared event card reads the event once, cached and de-duplicated | ten copies of one link in a thread are one read |
| The receipt folds events already in the cache, debounced | a history collection would be a write per event |

The remaining lever, if reads ever bite: drop `LIVE_LIMIT` to ~30.

## Security model in one paragraph

Rules do the enforcing, never the client. `followers` can only be written
by the follower adding their own uid — so a follower count cannot be
inflated by its owner. On a private account that write is refused and the
uid goes to `followRequests`; only the owner can move one name across, and
the rule bounds it so approving can't smuggle in somebody who never asked.
Rate limits use `users/{uid}/private/limits`, whose own rule pins every
timestamp to `request.time` — it can only say "now". The action and the
stamp go in one batch and the action's rule uses `getAfter()` to check the
stamp landed, so skipping it just gets the action refused. The icebreaker
(one opening message to a stranger until they reply) works the same way:
the message only commits if the same batch flips `icebreakerUsed` false to
true, and it can never go back.

## Findable by name

`index.html` carries the title, description, canonical, Open Graph,
Twitter card and a JSON-LD graph; `robots.txt` and `sitemap.xml` sit at
the root. The part that is not boilerplate is `alternateName` in the
structured data: "livesociya" is a coined word, so it gets typed wrong,
and "live sociya" / "livesocia" have to resolve to the same thing.

`robots.txt` disallows `/*?e=` on purpose. A shared event link points
at a private feed and is meant for one person; letting it into an index
would turn a share into a publication.

Worth knowing before expecting much: this is a client-rendered app
behind a sign-in, so a crawler sees the shell and the metadata and
nothing else. The tags make the SITE findable by name. They cannot make
individual events findable, and should not.

## Testing

No emulator, no network, no credentials. `test/stub.js` is a hand-written
stand-in for the Firebase compat SDK with working `orbit` and `events`
collections (events `get()` really applies where / orderBy / limit /
startAfter), batches that really apply, and counters on `window.__reads` /
`window.__writes`.

```
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

## Where it is

Built and working: UID migration, full rules, responsive layout, blocking
and reporting, request-to-join, host moderation, search, Orbit (mutual connections
+ vouches), follow and followers with private accounts and approval
(going public lets waiting requests in), rate limits, the icebreaker,
the day-one empty state, public/private at sign-up, dark mode, editing and
retracting a message (hold a bubble, or right-click on a desktop),
reactions, a host's pinned message, the Recap
receipt, the sage-on-paper redesign, the poster/stub cards, and share
links for an event.

Not built, roughly in the order I'd do them: push notifications (needs
Blaze — and it is the ceiling on everything else, since a live event
nobody is told about is a feed nobody opens), report triage for the admin.

Considered and parked: voice notes. Everything above costs *reads*, which
have a 50k/day free tier. Voice notes cost storage and egress — a
different meter, needs Blaze, and the first feature whose bill goes up
while nobody is using it.
