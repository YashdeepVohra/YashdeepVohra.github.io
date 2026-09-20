# Layout, widths and scrolling

Read before changing a width, a gutter, a flex row or anything that
scrolls. Most of these were invisible at laptop width and obvious on a
phone, which is why the smoke suite measures rather than eyeballs.

### One gutter, `--gut`, and three things that must agree on it

The
container's side padding, the live rail's negative margin (it runs
edge to edge, so it bleeds back out by exactly one gutter) and the
rail's own inner padding (so the first avatar lines up with the first
card). Those used to be three hard-coded 16s and 24s. A since-removed
two-column layout changed one of them and left the rail hanging 7px
past the column, over the divider and into the conversation — and the
same mismatch was sitting on every tablet width unnoticed. Change the
number in `:root` and in the two media queries; never at a call site.

### A poster band needs a 308px card, measured

Below that the
halftone has already yielded all its width (that is what it is for)
and `.poster-type`, which is deliberately un-shrinkable, runs past
the card's `overflow: hidden` — so "GOING" gets sliced mid-word. Two
places were under it: a 320px phone (lost 21px) and a 330px column that
a laptop used to put the feed in beside an open chat. That column is
gone entirely — see docs/sharing.md — so the card now tracks the
viewport at every width, and under 350px the band drops its second
stat. The second stat is the
one to drop because the body row below already names who is going;
the first stat — when it is — is said nowhere else on the card.

### The card's action row WRAPS, and the primary takes the line when it does

Five things could sit here — hype, chat, share, a spacer and the
primary — and `.act` is deliberately un-shrinkable, so a host looking
at their own card asked for about 346px of row. A 320px phone gives the
card 256px, and the card clips, so Manage was sliced clean off its
right edge; Going and "2 requests" went the same way. It shipped the
day Share joined the row.

`flex-wrap: wrap` is the guarantee, and it is deliberately NOT a media
query: a longer count or a larger text size can overflow the row at any
width, and wrapping catches every one of them. Nothing is ever sliced.

The primary is held at the far end by `margin-left: auto` on the last
child, not by a `flex:1` spacer. A spacer is a flex ITEM: the moment
the row wraps it claims a whole line to itself. An auto margin just
stops mattering.

On top of that, ON A PHONE THE ROW IS TWO ROWS, and that is a decision
rather than a fallback. Four controls in one line read as a jumble: the
three secondaries bunched at the left — and Chat, which only appears
once you are in, landed hard against Hype and made the bunch worse —
while the one control the card is actually asking you to press sat
squeezed at the other end.

So the secondaries get a line of their own: Hype and Chat as a PAIR at
the left, Share alone at the right. An auto margin on Share, not
`space-between` — spreading all three put Chat in the middle of
nowhere. The two that act on the event belong together; Share is a
different kind of verb, it leaves the app, so it gets the far edge to
itself. The primary then takes the full width below them: it is the
point of the card, and on a phone it should be the width of a thumb's
travel rather than whatever is left over.

### A ghost button at the end of a line is pulled out by its own padding

This is the spacing that was wrong, and it was wrong at EVERY width,
not just on a phone. `.act` carries `padding: 8px 14px` inside its box,
so the flame sat 30px from the card's edge while the title, the place
and the byline above it all start at 16. The row read as indented from
the card it belongs to, which is what made the whole thing look
unmanaged however the buttons were arranged.

Pulling the end button out by exactly its own horizontal padding puts
its GLYPH on the text column at 16px and leaves the tap target the size
it was. Only transparent buttons get this: a filled or outlined one is
aligned by its border, which already sits on the column, which is why
the primary is untouched. The smoke group measures the glyphs against
the TITLE rather than against the row's own padding box — measuring
against the box is what would hide this bug.

The breakpoint is 560px, and it is deliberately neither of the two
numbers already in the sheet. 390 is the measured point where the
single row stops FITTING, which is a different question from where it
stops reading well — it fits at 412 and still looked bunched. 768 is
where the app's chrome becomes a laptop (gutter, columns, bubble
width), which is a third question again. 560 is above every phone in
common use and below any tablet, and by then a card is wide enough
that one line is comfortable and a full-width button would just look
stretched.

The wrap above is still the guarantee and this is still only polish:
above 560 a row that overflows anyway is right-aligned, and never
sliced.

The smoke group "nothing is cut off" seeds all six primaries — Join,
Manage, Going, requests, Request, Full — because it used to seed six
events hosted by somebody else and joined by nobody, which is the
NARROWEST row the app can draw. The bug lived in the three rows the
test never rendered.

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

### The card actions carry no button chrome

Hype, Chat and Share are glyphs, not buttons: no fill on hover, no glow
on focus, no squash of the box on press. The glyph itself still dips,
which is feedback on the thing you pressed rather than on a box drawn
around it, and the only other feedback is colour — which is also the
state, ember once the hype is yours.

Two reasons, and the first only appeared once the row was aligned to
the text column. A fill behind a button whose box is pulled out by its
own padding reaches almost to the card's edge, so pressing Hype lit a
grey slab that looked like it was escaping the card. And on a touch
screen `:hover` STICKS after a tap — that slab stayed lit under your
thumb until you happened to tap somewhere else.

A keyboard still needs to see where it is, so `:focus-visible` keeps a
ring — with `outline-offset: -2px`, drawn INSIDE the box, so even that
cannot reach past the card. `:focus-visible` never fires for a tap or
a click, so nobody on a phone ever sees it.

### Pull to refresh is ours now

`overscroll-behavior-y: none` on html turns off the rubber-band jolt
AND the browser's pull-to-refresh, because they are one feature and
there is no value that keeps one without the other. Turning off the
jolt was right; losing the reload was not, and it was worse than it
looked: installed to a home screen there is no address bar and no
reload button either, so there was no way to reload at all.

`js/interactions/pullRefresh.js` is the replacement, and its whole
design is about not costing anything. Every listener is PASSIVE and
nothing is prevented, because nothing needs to be — at scroll position
0 with the bounce off, a downward drag already does nothing, so there
is no default to fight and no way for this to make scrolling janky. It
arms only at the top of the feed screen with nothing open over it, it
stands down for the rest of a touch the moment the drag goes up or
sideways, and it moves one element by transform.

Two things the smoke group holds, and the second matters more: that a
pull past the trigger reloads, and that a scrolled feed, an upward
drag and an inner scroller arm nothing at all.

### An icon-only button must not depend on the icon font

`bx-share-alt` on a button with no label means that if Boxicons fails
to load — a slow campus network, a blocked CDN — the control is not a
broken glyph, it is nothing at all. It sits at the far right of the
action row on a phone, which makes an invisible one worse still. It is
an inline `<svg class="act-glyph">` now, the same treatment the hype
flame already had, and the smoke group "the action bar on a phone"
asserts the element is there. Chat gets away with the font because it
carries a word; anything that does not needs drawing.

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
