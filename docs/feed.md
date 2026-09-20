# Painting the feed, and the rest of the UI contract

Read before changing how anything on screen is drawn or re-drawn. The
feed is diffed, not rebuilt, and several rules exist only to keep that
diff honest.

### The feed is diffed, not rebuilt

`syncList` replaces only cards whose
markup changed. Rebuilding replayed the entry animation on every card,
which read as the card vanishing. Don't reintroduce `innerHTML =` there.

### Nothing time-dependent may go in a card's markup

The corollary
of the line above, and it bit hard. A card showed the clock — "45M",
"2H LEFT", "4h ago" — so on every minute tick every card's html
differed from what was on screen, `syncList` swapped all sixty for
fresh nodes, and the whole feed visibly blinked once a minute. No
animation was involved; it was sixty nodes being thrown away and
rebuilt, which is exactly why it looked like the page had refreshed.

Those spots are empty `data-vt` slots now, and `paintVolatile()`
fills them from `state.eventCache` straight after the diff, in the
same frame. A card's html is therefore independent of WHEN it was
built, so a quiet minute finds nothing to replace and writes a few
text nodes instead. Anything else you derive from `now` belongs in a
slot, not in the string.

The tick costs nothing on the network either, and the smoke test
asserts it: a snapshot listener bills per CHANGED document, so a
minute in which nothing happened is 0 reads and 0 writes.

### Filters hide, they don't re-render

Every card is in the DOM with a
`data-tag`; a filter toggles a class.

### Social state is on screen in four places

— feed chips, search rows,
the open profile, the Orbit screen. `refreshSocialUI()` repaints all of
them; painters are registered in `app.js`. Anything that changes the
graph must go through it or the screens disagree.

### Optimistic first, then the network, then roll back on failure

Follow,
hype, and every orbit action work this way. A button that waits for a
round trip reads as broken.

### The browser's overscroll is off at the root

(`overscroll-behavior-y:
none` on `html`). The lurch at the top and bottom of a feed is a page
behaviour and this reads as an app; it also disables pull-to-refresh,
deliberately, because a reload throws away the live listeners and
anything half-typed, and the feed is already live. Inner scrollers use
`contain`, so reaching the end of a chat doesn't start scrolling the
page behind it.

### No `window.confirm` or `alert` anywhere

Use `askConfirm()` from
`js/utils/confirm.js` and `toast()` from `js/utils/ui.js`.

### Overlays go through `js/utils/overlays.js`

, which backs them with
history so Android back works. Closing is async — `pendingPops` exists
because close-then-open in one tick used to tear down the new layer.
