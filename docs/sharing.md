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

### Opening a shared event is one path, at every width

There is no detail view for an event — the card in the feed IS the
event — so View goes to the feed. It closes the conversation, opens the
tab the event lives in, lands on its card, and leaves a `returnChip`:
one tap back to the person, cleared by `switchScreen` so it can never
point at a conversation you are no longer coming from.

THE CHIP IS IN THE COLUMN, NOT OVER IT, and that took two goes. It was
appended to `<body>` and positioned fixed at the bottom left, which was
wrong in two ways that were both reported from the running app. It
covered whatever sat beneath it, which was reliably a card's ACTION
ROW, since that is what lives at the bottom of a card. And its desktop
offset was arithmetic — sidebar width plus a gutter — which only held
while the app frame started at x=0; past about 1400px the frame is
centred, the sidebar begins at 40px, and the chip landed inside it.

As the first child of `#home` it covers nothing at any width and needs
no coordinates at all, because the column already has them. It sits
outside `#eventsTab` and `#recapTab` so switching tabs cannot strand it
in the hidden one. The nine-second timer went with the move: an element
in the FLOW that removes itself on a clock yanks the feed up under a
thumb that is already moving.

Two consequences of being in the flow, both deliberate. It is created
BEFORE `land()`, because it takes real height and adding it after
`focusEvent` had scrolled would push the card back down by exactly the
chip. And `focusEvent` no longer scrolls a card that is already fully
on screen — centring would scroll the top of the column away, taking
the way back with it, and a shared event is usually near the top of a
feed that is newest-first anyway. When the card really is far down, the
chip does scroll out of view; the sidebar and the bottom nav still
offer Chats, so it is a convenience rather than the only route.

It used to fork on width. A laptop kept the thread open and flashed the
card in a 360px column beside it, on the theory that closing the
conversation threw away the place you were reading. What it actually
threw away was the card: 360px is NARROWER THAN A PHONE gives the feed,
so the poster was cramped and the action row wrapped inside a 1280px
window. The split is gone, the fork with it, and the event now gets the
whole column everywhere. The chip was `display: none` above 1100px for
as long as the laptop kept the conversation open; it is the only way
back now, so it is on screen at every width and sits at the foot of the
feed column rather than in the sidebar.

`closeChat({ silent: true })` deliberately does NOT swap screens, so
the `switchScreen("home")` that follows it is not optional — without it
the tab changes underneath a thread that is still covering it, and View
looks like it did nothing at all. That was true on a phone before and
it is true everywhere now.

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

### The share sheet is pick, then Send

It used to be the eight people you last messaged, and tapping a face
sent the event there and then: one person per open, nobody you had not
already talked to, and a misplaced thumb was a message you could not
take back. People expected the sheet every other app has, so it is that
now: conversations first, then everyone you follow, a search box that
also asks the people search after two letters, ticks, an optional line,
and a Send button that says how many. Below the list, when nothing is
ticked, the ways out: copy the link, WhatsApp (`wa.me/?text=`), and the
phone's own sheet where `navigator.share` exists.

The old path also wrote every NEW chat as an icebreaker and never flipped
`icebreakerUsed` on an existing one, so a share to a friend could be
refused by the rules for no reason on screen. Every send goes through
`sendDirectText` in chatService now, which makes the same decisions as
the composer: mutual follows and crossed paths are unlocked, a stranger's
opener flips the flag in the same batch, and an opener already spent is
refused before anything is written. The note and the link go in ONE
message, because to a stranger a second message would be refused.

The stub's batch used to drop `{ merge: true }` and overwrite; it passes
it through now, which is what caught the icebreaker case in the smoke
group "sharing an event to several people".

### The preview card on other apps

`og-image.png` is one branded card for every link, event links
included. A per-event card would need a server reading the event, and
events are sign-in only; that was considered and not built. WhatsApp,
Telegram and X cache a preview by the IMAGE URL, so every redraw bumps
the `?v=` on the og, twitter and JSON-LD image URLs in `index.html`.

### The way back moved to the bottom — on a phone only

At the top of the feed column the chip was out of thumb reach on a phone,
and that is where people use this. On a phone it now floats bottom-left,
level with the + button and above the tab bar. That strip is already
kept clear by the feed's bottom padding (it is where the + button
lives), so any card can be scrolled out from under it — the old floating
chip's crime was sitting over an action row that could NOT be moved
clear. A phone has no sidebar, so there is no offset arithmetic to go
wrong. On a laptop it is still the first row of the feed column.

### No URL in the corner when you hover a link

A laptop browser prints the address of anything with an `href` in the
bottom-left corner while the pointer is over it. No stylesheet can stop
it. So links in the app carry `data-href` instead, and
`utils/quietLinks.js` puts the real `href` back only for the moments the
browser's link behaviour is wanted — right-click (copy / open in new
tab), middle-click, and keyboard focus — and takes it away again when
the pointer or focus leaves. A plain click on an event card is handled
by its own onclick; any other quiet link opens in a new tab.
