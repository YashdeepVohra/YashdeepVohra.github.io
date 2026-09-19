# livesociya — working notes

Read this first. It is here so a new session starts knowing what took the
last ones a while to work out.

**What it is.** A campus app for things happening *right now*: somebody
starts an event, everyone nearby sees it instantly, it vanishes when it
ends. Plus direct messages, and a social graph. Live at livesociya.com,
Firebase Hosting + Firestore, vanilla ES modules — no framework, no build
step. Open `index.html` over http (not `file://`, modules won't load).

---

## How to work here

- The repo lives on the user's machine. Edit it there; don't rebuild it
  in the cloud container.
- **Always `node --check` every changed .js** before committing. There is
  no build step to catch a typo.
- **Run `test/smoke.mjs`** before saying something works (see Testing).
- **Commit when a change is done and tested** (`git add -A`, so new files
  come along). The user only runs `git push` — don't leave work unstaged.
- The user pushes and deploys themselves. After changing `firestore.rules`,
  say so — the rules only do anything once redeployed, and until then
  every limit in them is decoration.
- Commits: end with the Co-Authored-By / Claude-Session lines the session
  reminder gives.

## The shape of it

```
index.html          one page, every screen is a div that hides
style.css           one sheet, tokens at the top (--vibe-*, --s-*, --lift-*)
js/app.js           entry: imports, window bindings, boot, back button
js/config/          firebase init + offline persistence
js/state/store.js   one mutable object, plus resetState() on logout
js/services/        auth, events, chat, profile, follow, orbit, block,
                    search, user, limits, receipt — plus the pure rule
                    files recapRules, aboutRules, messageRules,
                    receiptRules
js/utils/           ui (screens/toasts/repaint registry), confirm, overlays,
                    formatters, viewport
js/interactions/    search screen, message gestures (swipe, hold)
firestore.rules     ~700 lines, the real access control
test/               stub.js + smoke.mjs + contrast.mjs
```

## Things that must stay true

- **uid is the only identity the database trusts.** `username` is a display
  handle: never a key, never an ownership field. Rules check
  `request.auth.uid`, which is free; verifying a username would cost a read
  on every write.
- **Everything user-typed goes through `escapeHtml`**, and inline `onclick`
  handlers take ids only (`safeId`), never text.
- **Pair documents are one doc with a sorted composite id** — `blocks`,
  `chats`, `orbit` all use `a_b`. Symmetrical by construction, and the id
  itself proves membership, so rules need no lookup.
- **`allow get` and `allow list` are different.** A list rule is checked
  against the *query*, before documents are read, so it must mirror the
  query's own constraint. Splitting these is what fixed chats not appearing.
- **What you may still do to a message you sent is
  `js/services/messageRules.js`.** Two shapes, and only two: an EDIT,
  which has 15 minutes on it and always leaves "edited" on the bubble,
  and a RETRACTION, which has no clock but leaves the bubble in place
  reading "This message was deleted". The 15 minutes is mirrored in
  `firestore.rules` (`messageEditWindow`) — change it in both or the
  app will offer an edit the server then refuses. The rules enforce
  both shapes with `hasOnly()`, so `senderUid`, `time` and the quoted
  reply still cannot move, and `deleted` is one-way.

  A tombstone, not a real delete, because a message that can vanish is
  a way out of the icebreaker: send your one opening message, delete
  it, send another. `icebreakerUsed` is one-way so the rules refuse the
  second message anyway — but the client decides whether to lock the
  box by counting messages on screen, and a row that disappears makes
  that count lie. The host's delete on an event message is still a real
  delete: moderation is not the same act as taking back your own words,
  and a tombstone over a slur is a worse outcome than a gap.
- **Reactions are a map keyed by uid**, `{ uid: emoji }`, on the
  message. Keyed that way on purpose: "you may change your own key and
  nobody else's" is one `diff().affectedKeys()` check in the rules, the
  same idea as `selfToggleOnly()` for the arrays. One reaction per
  person, from a fixed list in `messageRules.js` that is mirrored in
  the rules — an open string field would be a second way to put
  arbitrary text in somebody's thread, one that skips every length and
  escaping rule the message body has. The client writes the dotted path
  `reactions.<uid>`, never the whole map, so two people reacting at the
  same moment don't overwrite each other.
- **The pinned message lives in `events/{id}/pinned/current`, not on
  the event.** Same reason typing moved off the event document: every
  user with the app open is listening to the feed, so a field there
  bills a read to the whole campus each time a host pins something.
  It stores a COPY of the text, not just the message id, because the
  pinned message is usually the first one ("meet by the north gate")
  and by then it has scrolled out of the 25-message live window — an id
  alone would cost a second read to display, on every open, forever.
- **The receipt is folded out of events already on screen.**
  `js/services/receiptRules.js` is the arithmetic, `receiptService.js`
  is when it loads, saves and paints. It never queries anything: every
  event it counts was already paid for by the feed or the recap, the
  fold is idempotent per event id, and saves are debounced so a recap
  page of twenty finished events is one write. It therefore cannot see
  an event that expired while the app was closed — the honest trade for
  a feature with no server, and why the card says "since you started
  using this" rather than claiming to be complete. It lives under
  `users/{uid}/private/`, which is already owner-only: how often
  somebody goes out is nobody else's business.
- **How long Recap keeps an event is `js/services/recapRules.js`.** Pure
  functions, no imports: 6h + 8h x log2(1 + guests + hype/2), capped at
  48h; your own events stay 24h for you. Change the numbers there and in
  the smoke cases, nowhere else.
- **The look is one system, and it has three rules.** `style.css`
  opens with them; this is the short version.

  1. *The canvas is never white.* The page is pale green paper
     (`--canvas`) and cards sit LIGHTER on it (`--paper`), held by a
     1.5px `--ash` hairline. Nothing casts a shadow except the things
     that genuinely float: modals, sheets, the toast, the bottom nav,
     the FAB. `--lift-1` and `--lift-2` are nearly nothing on purpose —
     if a new surface needs separating, give it a border, not a shadow.
  2. *Three voices, and nothing is set in the wrong one.*
     `--font-display` (Archivo 800) for screen titles, event titles and
     names; `--font` (Inter) for everything functional; `--font-mono`
     (the system mono, no download) for metadata — times, counts,
     states, form labels. A screen title is never Inter and a
     timestamp is never anything but mono. Screen titles are uppercase
     because they are OUR words; anything a student typed keeps the
     case they typed it in.
  3. *Ember means now, and nothing else may use it.* The greens are
     the whole interface, so a green "live" badge would say nothing.
     `--ember` is reserved for right-now: the live dot, the live ring,
     the LIVE chip, hype, the unread mark. Two embers exist because one
     colour cannot do both jobs — `--ember` is the FILL, `--ember-ink`
     is what you READ (the fill is only 3.3:1 on the chip's
     background). If you are about to use ember for anything that
     isn't happening this minute, use `--sage` or `--forest` instead.

  The spine is `--ink`, `--ink-deep`, `--forest`, `--sage`, `--moss`,
  `--fern`, `--wash` and `--ember`. There is no `--violet`,
  `--aubergine`, `--periwinkle`, `--lavender` or `--plum` — they were
  briefly kept as aliases during the redesign and are gone. If you find
  one in a branch, it is stale.
- **An event card is a poster, and a recap card is the stub you tore
  off it.** Both are built around one band across the top, and the band
  is TWO COLUMNS: all the type on the left, the halftone and the
  category glyph on the right.

  That two-column layout is not a style choice, it is the fix for a bug
  that came back three times. The halftone kept ending up under the
  band's own words — first as a background layer across the whole band,
  then as an absolutely positioned corner that a taller card simply
  grew into, then because the place sat top-right where the dots were.
  Averaged over the band the contrast looked fine every time; on the
  pixel where a dot met a letter it was 2.4:1. Coordinates can always
  be out-grown. Siblings cannot overlap.

  One catch that is easy to reintroduce: being siblings is not enough
  on its own. `.poster-type` needs `min-width: max-content`, or
  flexbox shrinks BOTH columns when they don't fit, the type column
  goes under its content, and the stats spill straight back over the
  halftone. The deco column yields all its width first; a very busy
  card simply loses its halftone, which is the right thing to lose.

  Inside the type column, up to two numbers at poster scale, because a
  card answers two questions and it used to answer one: WHEN
  (`timeStat()`) and how many are GOING — or, on a stub, the turnout.

  `--band-mix` differs by theme and that is also not a fudge. The band
  has to carry dark ink AND separate from the page behind it. In light
  mode the page is already pale, so 40% left every band at 1.25:1
  against the canvas and the cards looked glued to the background;
  60% fixes it. In dark mode the page is near-black so 40% already
  separates at 2.5:1, and going further would eat the ink contrast.
  `--band-dot` runs opposite ways for the same reason.
- **`test/contrast.mjs` checks the worst pixel, not the average.** It
  walks every vibe in both themes for three things that each broke
  once: text on the band, the band against the page, and text on a
  DOT. The third is the one that kept getting missed, because a
  halftone's average colour is not the colour under a letter. It caught
  a light-mode case I had not even noticed while fixing the dark one.
  The geometry half of that guarantee lives in `smoke.mjs` under "the
  poster band": it measures real rectangle overlap between the band's
  text and the halftone column, on both axes. A colour test cannot see
  a layout bug and a layout test cannot see a colour one; the halftone
  needed both.

  The stub's notches are a mask: two radial gradients, each opaque
  except for a circle at one edge, intersected. Where either circle
  falls nothing paints — including the border, which is what makes it
  read as punched through rather than drawn on. `--tear` has to match
  the band's height exactly, which is why `.stub .poster` is a fixed
  height; a notch a few pixels off the seam looks like a bug. A browser
  without mask support just gets straight sides.
- **Blocking is total.** Filter `isBlocked` everywhere — lists, counts,
  the feed, vouches. A count that disagrees with the list under it is a bug.

## Cost model

Firestore charges per document read. A snapshot listener bills **one read
per changed document per connected client**, so the shape is
`changes x people watching`. Roughly 31.5k reads/day at 300 daily actives,
inside the 50k free tier; ~₹170/month at launch-night intensity with 300
people watching at once.

Decisions already made, with the reason, so they don't get undone:

| | why |
|---|---|
| Feed capped at `LIVE_LIMIT = 60`, recap paged | the recap used to load with the feed and nobody opened it |
| Messages: 25 live + paged scrollback | full history on every chat open |
| Profiles cached in localStorage, 6h TTL | ~20 reads per open for data that changes twice a year |
| Firestore offline persistence on | resume tokens: only changed docs bill |
| Hype writes debounced 900ms | a misclick costs nothing; a burst is one write |
| Counts live as arrays on the profile | `followers.length` is free; a subcollection is a read per follower |
| Recap query spans 48h, filtered client-side, max 3 pages per load | retention is computed from three fields; no server to store it |
| Profile Hosted/Joined: two `get()`s, counts from the same docs | was a listener + two duplicate count queries |
| Pinned message in a subcollection, holding a copy of the text | a field on the event bills the whole campus a read; an id alone costs a read to display |
| Poster cards cost ~29% more DOM than the rows they replaced, and that was accepted | measured, not assumed: at 60 cards, style recalculation went 4.3ms -> 0.2ms because the old hover transitions on `.event::before` and the watermark are gone, while layout (1.8ms) and forced-reflow wall time (2.1ms) are unchanged. The nodes cost nothing that shows up in a frame; the transitions did |
| The receipt folds events already in the cache, debounced | a history collection would be a write per event and a query per open |

The remaining lever, if reads ever bite: drop `LIVE_LIMIT` to ~30. It cuts
fan-out on everything at once.

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

`contrast.mjs` reads the colour tokens straight out of `style.css` and
checks every text-on-surface pair in both themes against WCAG. The
palette is a family of greens, so every pair is close together and it
is easy to pick two that look fine on a laptop and vanish on a cheap
phone in daylight. It has already caught two.

Useful handles inside a page: `window.__m` (the modules), `window.__events`
+ `window.__fireEvents()`, `window.__orbit` + `window.__fireOrbit()`,
`window.__stubDocs['users/uid']`, `window.__authSingleton.currentUser`.

Every bug in the list below was found this way, so add a case when
something breaks.

## Gotchas found the hard way

- **`button { display: flex }` is in the base sheet.** Any element you turn
  into a button inherits it, plus `padding: 13px 24px` and `width: 100%`.
  This silently laid the profile stat boxes out sideways and squashed the
  avatar in the middle of the orbit.
- **`place-items: center` shrink-wraps the grid column**, so a child at
  `width: 100%` has nothing to resolve against and collapses to its
  intrinsic size. Emoji avatars hide it; a Google profile photo does not.
  Photo avatars are pinned with `position: absolute; inset: 0`.
- **Boxicons has no `bx-hot`** — only the solid `bxs-hot`. Check a class
  exists before using it. Anything load-bearing (the brand mark, the hype
  flame, arrows) is inline SVG now, because an icon font that fails to
  load leaves an invisible control.
- **Renaming a token renames its own definition too.** The sweep that
  retired the violet-era names turned `--aubergine: var(--ink)` into
  `--ink: var(--ink)` — a self-reference, which makes the token
  invalid and would have taken the text colour out of the entire app.
  It was caught because the alias block was deleted in the same pass
  and checked; if you ever do this again, grep for
  `^\s*--([a-z0-9-]+):\s*var\(--\1\)` afterwards.
- **A rename is provable, so prove it.** `node snap.mjs` style
  screenshots (fixed clock, animations off, both themes, every screen)
  taken before and after must be BYTE-identical — a pure rename cannot
  move a pixel. Run the snapshot twice against unchanged code first, to
  show the harness itself is deterministic; otherwise the comparison
  means nothing. That is how the 134-replacement rename was signed off.
- **Specificity beats source order.** `.empty-state p { margin: 0 }` quietly
  outranked a later `.starter-foot` rule. It bites from the other side
  too: `.modal-content { text-align: center }` and
  `.modal-content button { margin-bottom: 8px }` outrank a plain
  `.action-row` wherever you put it, which is why the message sheet is
  written as `.modal-content.action-sheet` and `.action-sheet
  .action-row`.
- **Zoom is switched off on purpose** (the user's call): viewport meta
  `maximum-scale=1, user-scalable=no`, `touch-action: pan-x pan-y` on
  `html`, and `lockZoom()` in `utils/viewport.js` for iOS, which ignores
  both. Inputs stay 16px on `(pointer: coarse)` anyway — belt and braces
  against iOS focus-zoom.
- **Messages are not quite immutable any more, and the live window is
  why that matters.** Only the newest 25 have a listener; older pages
  are fetched once with `get()` and never watched. So when you edit or
  retract a message that has scrolled out of that window,
  `patchLocalMessage` updates the copy on screen itself — there is no
  listener to do it. The other person sees the change the next time
  they open the chat. Widening the listener to fix that would re-read
  the whole thread on every change, which is the cost the window
  exists to avoid.
- **The feed is diffed, not rebuilt.** `syncList` replaces only cards whose
  markup changed. Rebuilding replayed the entry animation on every card,
  which read as the card vanishing. Don't reintroduce `innerHTML =` there.
- **Filters hide, they don't re-render.** Every card is in the DOM with a
  `data-tag`; a filter toggles a class.
- **Social state is on screen in four places** — feed chips, search rows,
  the open profile, the Orbit screen. `refreshSocialUI()` repaints all of
  them; painters are registered in `app.js`. Anything that changes the
  graph must go through it or the screens disagree.
- **Optimistic first, then the network, then roll back on failure.** Follow,
  hype, and every orbit action work this way. A button that waits for a
  round trip reads as broken.
- **No `window.confirm` or `alert` anywhere.** Use `askConfirm()` from
  `js/utils/confirm.js` and `toast()` from `js/utils/ui.js`.
- **An ended event is not live.** `now >= startTime` is also true after
  it ends; that put a Live chip on every Recap card. Check `expiresAt`.
- **The localStorage profile cache is partial.** It keeps names, counts,
  `private`, and whether YOU are in their request queue — nothing else.
  Leaving `private` and `followRequests` out made every private account
  look open after a reload and every sent request look cancelled.
- **A new follow decides from a fresh read, never the cache**
  (`refreshUser`), and every fresh read runs `onUserFetched` hooks —
  that's how an approved request becomes `following` on the asker's
  side, since only the asker can write their own list.
- **Follow first, orbit later.** `pullIn` needs you to be in their
  `followers` (client and rules). A private profile you don't follow is
  "locked" (`isProfileLocked`): counts, Follow, Message/Report/Block, and
  nothing else — no lists, vouches, events, or orbit. Public profiles
  show everything except the orbit button until you follow.
- **The keyboard is handled by the visual viewport, not `innerHeight`.**
  `utils/viewport.js` publishes `--vvt` / `--vvh`; full-screen layers sit
  at exactly that box while `html.kb-open`. A keyboard only counts with a
  text field focused. The smoke suite fakes a
  visual viewport to test this; a real phone is still the final word.
- **Bio and interests** are `bio` (160) and `interests` (≤5, fixed list
  in `js/services/aboutRules.js`, mirrored in the rules). They ride on
  the profile document, so they cost no extra reads.
- **Dark mode is tokens, not overrides.** Colours come from `:root` in
  `style.css`; `:root[data-theme="dark"]` swaps them. Never write a
  literal colour in CSS or a JS template — add a role token
  (`--on-accent` for text on the forest fill, `--on-danger` for a label
  on a delete button, `--ink-fill` for a strong neutral fill,
  `--glass`, `--ember-ink`...) with a value in both blocks. `--paper`
  is a surface, never a text colour. A role token whose value has to
  flip meaning between themes needs its OWN token: `--on-accent` is
  light in light mode and DARK in dark mode, because it sits on deep
  forest and then on pale moss — which is exactly why a delete button
  cannot borrow it. Run `node test/contrast.mjs` after touching any
  colour. The choice is per device
  (`livesociya.theme`: system/light/dark, `js/utils/theme.js`), painted
  before CSS by an inline script in `<head>`, and kept across logout.
- **Overlays go through `js/utils/overlays.js`**, which backs them with
  history so Android back works. Closing is async — `pendingPops` exists
  because close-then-open in one tick used to tear down the new layer.

## Where it is

Built and working: UID migration, full rules, responsive layout, blocking
and reporting, request-to-join, host moderation, search, Orbit (mutual
connections + vouches), follow/followers with private accounts and
approval, rate limits, the icebreaker, the day-one empty state, public /
private chosen at sign-up (and asked once of older accounts), remove a
follower, going public lets waiting requests in, dark mode, editing and
taking back a message (hold a bubble, or right-click on a desktop),
reactions, a host's pinned message in an event chat, the Recap
receipt, the sage-on-paper redesign, and the poster/stub cards.

Not built, roughly in the order I'd do them: push notifications (needs
Blaze — and it is the ceiling on everything else, since a live event
nobody is told about is a feed nobody opens), share links for an event,
report triage for the admin.

Considered and parked: voice notes. Everything above costs *reads*,
which have a 50k/day free tier. Voice notes cost storage and egress,
which is a different meter, needs Blaze, and grows on its own — the
first feature here whose bill goes up while nobody is using it.
