# The look

Read before changing a colour, a band, a card or a token. `CLAUDE.md`
carries each rule in one line; this is why each one is the way it is.

### The look is one system, and it has three rules

`style.css`
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

### An event card is a poster, and a recap card is the stub you tore off it

Both are built around one band across the top, and the band
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

### A surface is held by its border, not by its shadow

The rail's "Jump to a vibe" card was filled with `--wash`, which sits
**1.096:1** from the canvas in light mode — below even the `--bone`
case recorded below as a bug, and darker than the page, which inverts
this system's own first rule that cards sit LIGHTER than what they are
on. `.rail-card` carried no border at all, only `--lift-1`, which these
notes describe as nearly nothing on purpose. So in light mode the card
was not subtly wrong, it was not there.

Two things hid it. Dark mode had an inset hairline bolted onto
`.rail-card` specifically, so it only ever looked wrong in light mode.
And the class was called `accent-lavender` — a name from the retired
violet palette, which these notes already say is stale wherever it
turns up.

Every rail card now carries the same 1.5px `--ash` edge that `.card`
does, in both themes, and the tint is gone. Worth noting the plain
cards were barely better off: `--paper` is only 1.132:1 from the
canvas, so they were held against the page by that same almost-nothing
shadow. The border is what holds them now.

The vibe pills went with it. They were a near-white fill with no
border, which only read because the card behind them was darker than
the page — the very tint that made the card vanish. They are ordinary
outline pills now, the same form the feed's filter row uses.

`test/contrast.mjs` gained "a card surface against the page", and the
smoke group "desktop columns" asserts every rail card has a real edge.
A colour test cannot see a missing border and a layout test cannot see
a colour that is too close; this needed both, same as the halftone did.

### Taking the colour out takes the information out

The recap stub
used to drain its band to flat `--bone`. Two complaints, one root:
every stub in the Recap was the same colour, so the category
vanished, and `--bone` sits 1.1:1 from the canvas, so they all sank
into the page. A stub keeps the vibe at the same mix as a live card
now; being OVER is carried by the notches, the dashed tear line, the
faded halftone and a stat that counts people instead of minutes. You
never see the two side by side — different tabs.

### `test/contrast.mjs` checks the worst pixel, not the average

It reads the colour tokens straight out of `style.css` and checks every
text-on-surface pair in both themes against WCAG. The palette is a family
of greens, so every pair sits close together and it is easy to pick two
that look fine on a laptop and vanish on a cheap phone in daylight. It
has already caught two.

It
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

### Dark mode is tokens, not overrides

Colours come from `:root` in
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

### Renaming a token renames its own definition too

The sweep that
retired the violet-era names turned `--aubergine: var(--ink)` into
`--ink: var(--ink)` — a self-reference, which makes the token
invalid and would have taken the text colour out of the entire app.
It was caught because the alias block was deleted in the same pass
and checked; if you ever do this again, grep for
`^\s*--([a-z0-9-]+):\s*var\(--\1\)` afterwards.

### A rename is provable, so prove it

`node snap.mjs` style
screenshots (fixed clock, animations off, both themes, every screen)
taken before and after must be BYTE-identical — a pure rename cannot
move a pixel. Run the snapshot twice against unchanged code first, to
show the harness itself is deterministic; otherwise the comparison
means nothing. That is how the 134-replacement rename was signed off.
