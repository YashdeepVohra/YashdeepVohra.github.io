# Identity, documents and what the rules allow

Read before touching Firestore, `firestore.rules`, or anything that
decides who may write what. Several of these shapes exist purely to keep
a rule free of an extra read.

### uid is the only identity the database trusts

`username` is a display
handle: never a key, never an ownership field. Rules check
`request.auth.uid`, which is free; verifying a username would cost a read
on every write.

### Everything user-typed goes through `escapeHtml`

, and inline `onclick`
handlers take ids only (`safeId`), never text.

### Pair documents are one doc with a sorted composite id

— `blocks`,
`chats`, `orbit` all use `a_b`. Symmetrical by construction, and the id
itself proves membership, so rules need no lookup.

### `allow get` and `allow list` are different

A list rule is checked
against the *query*, before documents are read, so it must mirror the
query's own constraint. Splitting these is what fixed chats not appearing.

### What you may still do to a message you sent is `js/services/messageRules.js`

Two shapes, and only two: an EDIT,
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

### A message carries two stamps, and they do different jobs

`time` is the client's own `Date.now()`. The thread is ordered by it,
it paints the instant you hit send, and a message written with no
signal still carries one — which is why it cannot simply become a
server stamp: an unresolved `serverTimestamp()` reads as null until it
commits, so your own message would jump to the top of the thread, or
out of the 25-message window entirely, for the length of a round trip.

`sentAt` is `serverTimestamp()`, and `firestore.rules` requires it to
equal `request.time` on create. Anything that must not be gameable is
measured against that one. The edit window used to run off `time` —
the field the sender controls — so dating a message in the future
bought an unlimited window to rewrite it. `editedAt` and `deletedAt`
are server stamps too: "edited at" is shown to the other person, so it
is not the sender's to choose either.

`time` is still bounded (`sensibleTime` in the rules: no more than two
minutes ahead, no more than seven days behind, the second being the
allowance for a message written offline). That is what stops a message
dated 2099 pinning itself to the top of everyone's live window.

`chats.lastUpdated` is the same shape and for the same reason — the
inbox is ordered by it and has to reorder the moment you send — so it
stays a client number, bounded by `sensibleTime`. Before that bound,
one write of a number far in the future pinned a conversation to the
top of the other person's inbox permanently.

Read a stamp with `msOf()` (`js/utils/formatters.js`) or `sentMs()`
(`messageRules.js`, which stays import-free and has its own copy).
Never `new Date(x)` on a stored stamp: it is a number while the write
is in flight and a Firestore `Timestamp` afterwards.

### A bubble is identified by its document id

Not by `time`. Two messages written in the same millisecond used to
share a DOM id (`msg-${m.time}`), and `replyTo` stored the quoted
message's timestamp — so a reply to the second scrolled to the first.
Everything is keyed on the Firestore document id, which is already on
every bubble as `data-msg-id`.

### Reactions are a map keyed by uid

, `{ uid: emoji }`, on the
message. Keyed that way on purpose: "you may change your own key and
nobody else's" is one `diff().affectedKeys()` check in the rules, the
same idea as `selfToggleOnly()` for the arrays. One reaction per
person, from a fixed list in `messageRules.js` that is mirrored in
the rules — an open string field would be a second way to put
arbitrary text in somebody's thread, one that skips every length and
escaping rule the message body has. The client writes the dotted path
`reactions.<uid>`, never the whole map, so two people reacting at the
same moment don't overwrite each other.

### The pinned message lives in `events/{id}/pinned/current`, not on the event

Same reason typing moved off the event document: every
user with the app open is listening to the feed, so a field there
bills a read to the whole campus each time a host pins something.
It stores a COPY of the text, not just the message id, because the
pinned message is usually the first one ("meet by the north gate")
and by then it has scrolled out of the 25-message live window — an id
alone would cost a second read to display, on every open, forever.

### The receipt card used to lie, and reading it is gated on Recap

`load()` was only ever called from `harvestReceipt`, and
`harvestReceipt` returns early when nothing in the cache is countable —
which is the ordinary case for somebody coming back, since everything
finished has already been folded. So the document was never read, the
in-memory receipt stayed empty, and the card painted "Go to something
and this fills in" at a person with months behind them. It read as a
card that had failed to load, and in every sense it had.

`primeReceipt()` is called from `ensureRecapLoaded()` instead. That
keeps the cost story intact rather than loading on every feed repaint:
the card lives in Recap and nowhere else, so only somebody who opens
Recap pays the one read, once per session. And `renderReceipt()` now
paints NOTHING until the document has come back — "not read yet" is
not the same as "nothing to show", and painting the empty state in the
gap is what made the bug look like a bug in the data.

### The receipt is folded out of events already on screen

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

### How long Recap keeps an event is `js/services/recapRules.js`

Pure
functions, no imports: 6h + 8h x log2(1 + guests + hype/2), capped at
48h; your own events stay 24h for you. Change the numbers there and in
the smoke cases, nowhere else.

### Blocking is total

Filter `isBlocked` everywhere — lists, counts,
the feed, vouches. A count that disagrees with the list under it is a bug.

### Messages are not quite immutable any more, and the live window is why that matters

Only the newest 25 have a listener; older pages
are fetched once with `get()` and never watched. So when you edit or
retract a message that has scrolled out of that window,
`patchLocalMessage` updates the copy on screen itself — there is no
listener to do it. The other person sees the change the next time
they open the chat. Widening the listener to fix that would re-read
the whole thread on every change, which is the cost the window
exists to avoid.

### An ended event is not live

`now >= startTime` is also true after
it ends; that put a Live chip on every Recap card. Check `expiresAt`.

### A follower is a document; `following` is still an array

`users/{uid}/followers/{followerUid}` and
`users/{uid}/followRequests/{askerUid}`, each holding nothing but `at`.
They were arrays on the profile, capped at 5000 — a number nobody chose,
just where an array of uids starts threatening the 1 MiB a document
gets. The cap was the least of it: every follow rewrote the whole
document (and one document takes about one write a second), every read
of that profile dragged the entire list down the wire, and any signed-in
account could read a private account's whole follower list straight out
of it whatever the UI showed.

`following` deliberately did NOT move. Only you write your own, so
there is no contention, and one read gives the app the whole list —
which is what answers "am I following them?" on every card in the feed
for free. A subcollection there would cost a read per person you follow
on every cold start to answer something the array already answers.

`vouchedBy` stays an array too, capped at 500. It is only writable by
people already linked to you in orbit, so it has neither the contention
nor the open-ended growth.

### The follower count is a number that still cannot be forged

`followerCount` on the profile, and the rules only let it move in the
same write that provably creates or deletes the matching follower
document — `followerEdge` names whose, and `existsAfter()` checks it
landed. So it is still earned one real account at a time. Approving
works the same way: the create rule on the follower document checks with
`exists()` that a request was really there, so an owner cannot smuggle
in somebody who never asked.

The honest trade: a count cannot be filtered, so a follower you have
blocked is still inside it. The list under it is filtered and is the one
that has to be right.

### Whether you asked someone is kept on the device

A private account's request queue is readable only by its owner now, so
"have I asked them?" cannot be answered from their profile at all. The
localStorage record in `followService.js` is the answer, confirmed
against the server by `syncFollowState()` whenever a profile is actually
opened, and swept once per launch by `resolvePendingAsks()`.

That function replaced the `onUserFetched` hook. The hook was free when
the answer arrived inside the profile document; it is a read of its own
now, so it is spent deliberately — on a profile open, where a read is
being spent anyway — rather than on every cached glance at a name.

### The localStorage profile cache is partial

It keeps names, `followerCount`, `private` and a capped `vouchedBy` —
nothing else. Leaving `private` out made every private account look open
after a reload, and the button say Follow instead of Ask.

### Follow first, orbit later

`pullIn` needs a follower document at `users/{them}/followers/{you}`
(client and rules). A private profile you don't follow is "locked"
(`isProfileLocked`): counts, Follow, Message/Report/Block, and nothing
else — no lists, vouches, events, or orbit. The followers half of that
is a real wall now, enforced by the read rule on the subcollection;
`following` and `vouchedBy` are still arrays on a readable document, so
those two remain app-level. Public profiles show everything except the
orbit button until you follow.

### Bio and interests

are `bio` (160) and `interests` (≤5, fixed list
in `js/services/aboutRules.js`, mirrored in the rules). They ride on
the profile document, so they cost no extra reads.
