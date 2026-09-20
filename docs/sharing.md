# Links, embeds and shared events

Read before touching `shareRules.js`, `shareService.js`, the chat embeds
in `formatters.js`, or what happens when somebody taps a shared card.

### A shared link is `?e=<id>`, and that is not cosmetic

`firebase.json`
has no `hosting` block, so there is no rewrite: a pretty `/e/<id>` would
404 on the static host before any JavaScript ran. `shareRules.js` still
*parses* the path form, so links keep working the day a rewrite is added,
but `eventLink()` only ever emits the query form. Don't "tidy" it.

A link only counts as ours if its host is `livesociya.com`, a subdomain
of it, `localhost` or `127.0.0.1`, and its protocol is http(s). That
guard is what stops `livesociya.com.evil.tld/?e=x` from rendering as a
trusted in-app card, and `javascript:?e=x` from rendering at all. The
smoke group "sharing an event" has a case for each; both fire if the
check is loosened to `includes("livesociya.com")`.

In chat, an event link becomes a card but stays a real `<a href>`
underneath, so it still works for anyone whose JavaScript failed, and
still copies as a link. The card paints from `state.eventCache` when the
event is already known — **no read** — and otherwise costs exactly one
read per unseen event, de-duplicated through `pendingFetches` so ten
copies of the same link in a thread are one read, not ten.

### Opening a shared event: two layouts, two right answers

There is
no detail view for an event — the card in the feed IS the event — so
View has always gone to the feed. What it also did, at every width,
was close the conversation. On a laptop the thread and the feed are
different COLUMNS, so that threw away the place you were reading for
nothing: the wide branch now leaves the chat open and flashes the
card beside it. On a phone the chat does have to go, and it leaves a
`returnChip` behind — one tap back to the person, gone after nine
seconds, and cleared by `switchScreen` so it can never point at a
conversation you are no longer coming from.

The phone branch also has to call `switchScreen("home")` itself.
`closeChat({ silent: true })` deliberately does NOT swap screens, and
the thread is a full-screen layer on a phone — so before this, View
changed the tab underneath a conversation that was still covering it,
and looked like it did nothing at all.

### A finished event has THREE states in a chat, not two

It is still
on; it is over but still has a stub in Recap; or it is over and aged
out, and there is no card for it anywhere in the app. Tapping the
card used to swap the tab whatever it had become - and on a phone
that closed the conversation on the way - so the reward for a dead
event was an empty tab. An event missing from the cache entirely read
as `ended === false` and went to LIVE NOW, which is what it looked
like from the outside. `showSharedEvent` asks `inRecap()` first now
and toasts instead of travelling; the embed says View, Recap or
nothing to match, and a dead one carries `.dead` so it stops looking
tappable. It stays an `<a>` either way - the link still means
something pasted somewhere else.

One trap on the way: Recap is PAGED. `recapOrder` holds only what
`loadRecap` has walked back to, and `renderEvents` builds stubs from
that list, so an event well inside its window can still have no card.
The id is pushed into `recapOrder` before the tab swaps. It is
already in the cache and `inRecap` has just vouched for it, so this
costs no read.

And in a test, `window.showTab` is app.js's `goToTab`, which closes
any open chat on its way. Use `ui.showTab` when the point of the test
is that the chat stays open.

### A cross-origin iframe's scrollbars are reachable only through `scrolling="no"`

The YouTube and Spotify embeds sit in a wrapper
with `overflow: hidden`, which clips the FRAME'S box and does nothing
at all to the bars drawn inside it - no stylesheet of ours crosses
that boundary. A chat bubble is 76% of the thread, so Spotify's
player gets roughly 260px and lays itself out wider, and on Windows a
scrollbar takes real space: the horizontal bar ate into the 152px,
which brought a vertical bar, which narrowed the content again. Two
scrollbars around one song, invisible on a Mac because overlay
scrollbars float over the artwork. The attribute is deprecated in the
HTML spec and implemented by every engine; there is no replacement.
Their sizing lives in `.media-embed` in the stylesheet now rather
than in a `style` attribute, so there is one place to change it.
