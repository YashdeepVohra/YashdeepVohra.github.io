# Layout, widths and scrolling

Read before changing a width, a gutter, a flex row or anything that
scrolls. Most of these were invisible at laptop width and obvious on a
phone, which is why the smoke suite measures rather than eyeballs.

### One gutter, `--gut`, and three things that must agree on it

The
container's side padding, the live rail's negative margin (it runs
edge to edge, so it bleeds back out by exactly one gutter) and the
rail's own inner padding (so the first avatar lines up with the first
card). Those used to be three hard-coded 16s and 24s. The chat-open
layout changed one of them and left the rail hanging 7px past the
column, over the divider and into the conversation — and the same
mismatch was sitting on every tablet width unnoticed. Change the
number in `:root` and in the two media queries; never at a call site.

### A poster band needs a 308px card, measured

Below that the
halftone has already yielded all its width (that is what it is for)
and `.poster-type`, which is deliberately un-shrinkable, runs past
the card's `overflow: hidden` — so "GOING" gets sliced mid-word. Two
places were under it: a 320px phone (lost 21px) and the chat-open
middle column, which was 330px because it had been sized for the chat
LIST, not for a feed. The column is 360px now, and under 350px
viewport width the band drops its second stat. The second stat is the
one to drop because the body row below already names who is going;
the first stat — when it is — is said nowhere else on the card.

### The card's action row WRAPS, and it must keep wrapping

Five
things live there - hype, chat, share, the primary action - and
`.act` is deliberately un-shrinkable, so a host looking at their own
card asks for about 346px of row. A 320px phone gives the card 256px
and the chat-open middle column gives it 296px, and the card clips,
so Manage was sliced clean off its right edge; Going and "2 requests"
went the same way. It shipped the day Share joined the row.

Width media queries cannot fix this, and that is the part worth
remembering: the narrow case is not a narrow VIEWPORT. The feed
column beside an open chat is 360px on a 1280px laptop, where no
`max-width` query would ever fire. `flex-wrap: wrap` is the only
answer that holds at every container width.

The primary is held at the far end by `margin-left: auto` on the last
child, not by a `flex:1` spacer. A spacer is a flex ITEM: the moment
the row wraps it claims a whole line to itself. An auto margin just
stops mattering.

The smoke group "nothing is cut off" now seeds all six primaries -
Join, Manage, Going, requests, Request, Full - because it used to
seed six events hosted by somebody else and joined by nobody, which
is the NARROWEST row the app can draw. The bug lived in the three
rows the test never rendered.

### Nothing on screen may be sliced or reach past its column

The
smoke group "nothing is cut off" renders the app at 320, 390 and 1280
(that last one with a chat open beside the feed) and asks two
questions of every visible element: does anything reach past the box
that clips it, and does anything that clips hold content wider than
itself. Horizontal scrollers and one-line ellipsis are exempt, since
both are cut on purpose. It replaced four separate bugs that were all
invisible at laptop width, and all four were re-introduced one at a
time to prove it fires.

### A dead scroll container is worse than no scroller at all

The
profile's inner box is the scroller on a phone, where the profile is
a fixed full-screen layer. On a laptop the wrapper joins the grid
with `min-height: 100dvh` instead, so that box grows to its own
content: `scrollHeight === clientHeight`, 1086px tall inside an 860px
window, still a scroll container, still carrying
`overscroll-behavior: contain`. It could never move a pixel while
telling the browser not to pass the wheel on. Chromium hands the
gesture to the page anyway; a browser that takes `contain` at its
word strands the bottom of the profile. So at >=1100px that box is
`overflow: visible` and the page scrolls the column, exactly as it
does the feed.

The smoke group "everything scrolls to its bottom" holds the rule in
general: no `overflow: auto` box may be taller than the window while
having nothing to scroll. It tests the STRUCTURE, not the gesture, on
purpose — the symptom is browser-dependent and a wheel driven in
Chromium would never see it.

### Claiming a handle has no inner scroller, so the layer is one

`.onboarding-screen` is `.full-screen-view`, which sets
`overflow: hidden`; on a short window (landscape phone, half-height
laptop) the account-type cards and the Join button went off the
bottom with nothing to scroll. It is `overflow-y: auto` now with
`justify-content: safe center` — plain `center` on a flex column that
overflows pushes content off BOTH ends and the top one cannot be
scrolled back to. The smoke sweep includes an 820x460 window because
nothing shorter than that shows it.

### Scroll chaining behind an open layer cannot be fixed with `overscroll-behavior`, so don't try

Chaining begins at the nearest
container that can ACTUALLY scroll, so a panel whose content happens
to fit is skipped entirely and its `overscroll-behavior` is never
consulted — the wheel goes to the page behind it. Stopping that needs
the page itself to stop scrolling, and `overflow: hidden` on html is
exactly what broke sticky the last time. Left alone on purpose.

### The wordmark is a button now, so it must shed the button styling

`.brand-home` sits inside the topbar; the base `button` rule would give
it a moss fill, padding and a shadow. It resets all three. Same trap as
`.action-row` and `.card.poster-card` - see the specificity note below.

### A hidden tab has no geometry, and a test that measures one proves nothing

Every rect inside a `display: none` subtree is 0x0, so the
first version of the band's overlap check "passed" for recap stubs
while measuring literally nothing. It shows each tab before
measuring it now. Worth remembering for any future layout test.

### `button { display: flex }` is in the base sheet

Any element you turn
into a button inherits it, plus `padding: 13px 24px` and `width: 100%`.
This silently laid the profile stat boxes out sideways and squashed the
avatar in the middle of the orbit.

### `place-items: center` shrink-wraps the grid column

, so a child at
`width: 100%` has nothing to resolve against and collapses to its
intrinsic size. Emoji avatars hide it; a Google profile photo does not.
Photo avatars are pinned with `position: absolute; inset: 0`.

### Specificity beats source order

`.empty-state p { margin: 0 }` quietly
outranked a later `.starter-foot` rule. It bites from the other side
too: `.modal-content { text-align: center }` and
`.modal-content button { margin-bottom: 8px }` outrank a plain
`.action-row` wherever you put it, which is why the message sheet is
written as `.modal-content.action-sheet` and `.action-sheet
.action-row`.

### Two different things silently break `position: sticky`, and the desktop sidebar and rail hit BOTH at once

They are sticky at
>=1100px and they were scrolling away with the feed anyway.

First: `overflow-x: hidden` was on `html, body`. When one axis is
`hidden` and the other is `visible`, the visible one computes to
`auto` — so body became a scroll container. The page actually
scrolls on html, so body never scrolls, and everything sticky inside
it was sticking to a box that never moves. It belongs on `html`
alone, where the root element's overflow propagates to the viewport
and html itself is then treated as visible. (`test/` has a
horizontal-overflow sweep behind that change: it was there for a
reason once — date inputs sliding the create screen sideways — and
nothing scrolls sideways at any width without it now.)

Second: a much later rule, `.topbar, .sidebar, .rail, #home,
.container { position: relative; z-index: 1 }`, put them above the
ambient layer — and at equal specificity and later in the sheet,
that `position: relative` flattened the sticky. The z-index is all
they needed; a sticky box takes one perfectly well.

Either one alone is enough to break it, so the smoke test under
"desktop columns" measures the BEHAVIOUR — scroll the page, assert
the columns stayed at top 0 — rather than either cause. Fixing one
and leaving the other cannot fool it.

### Boxicons has no `bx-hot`

— only the solid `bxs-hot`. Check a class
exists before using it. Anything load-bearing (the brand mark, the hype
flame, arrows) is inline SVG now, because an icon font that fails to
load leaves an invisible control.

### Zoom is switched off on purpose

(the user's call): viewport meta
`maximum-scale=1, user-scalable=no`, `touch-action: pan-x pan-y` on
`html`, and `lockZoom()` in `utils/viewport.js` for iOS, which ignores
both. Inputs stay 16px on `(pointer: coarse)` anyway — belt and braces
against iOS focus-zoom.

### The keyboard is handled by the visual viewport, not `innerHeight`

`utils/viewport.js` publishes `--vvt` / `--vvh`; full-screen layers sit
at exactly that box while `html.kb-open`. A keyboard only counts with a
text field focused. The smoke suite fakes a
visual viewport to test this; a real phone is still the final word.
