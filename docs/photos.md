# Photos

Read before touching anything that stores, uploads or draws a photo.
`CLAUDE.md` carries the rules in one line each; this is why.

### Built, and switched off

Photos need Cloud Storage, and since late 2024 a Firebase project's
default bucket needs the Blaze plan. Everything is in the app already
and hidden behind one flag, `features.photos` in `js/config/features.js`.
While it is off, `body` has no `photos-on` class and every `.needs-photos`
element is `display: none`, so nobody can tell. The Storage SDK is not
loaded at boot either way — it is fetched the first time somebody picks
a photo (`loadStorage()`), so the boot path in `boot.md` is untouched.

What ships with the flag off, because none of it needs Storage: the
event page, likes and comments on a finished event, Report on events,
messages and comments, the admin's report screen, the location limit,
and the tightened avatar rule.

Behind the flag: profile pictures, event photos and the cover, photos
in chat, memory photos, and stories.

### Switching it on

1. Upgrade to Blaze (card country: India, Visa/Mastercard — RuPay is
   usually refused). Set a budget alert at about ₹200/month.
2. Firebase console → Storage → Get started → **US-CENTRAL1**. Only
   `us-central1`, `us-east1` and `us-west1` get the no-cost allowance
   (5 GB stored, 100 GB/month out). The choice is permanent for that bucket.
3. `firebase deploy --only storage,firestore:rules,firestore:indexes`
   (stories need two new indexes; they take a few minutes to build).
4. Google Cloud console → Cloud Storage → the bucket → Lifecycle → add a
   rule: **Delete** objects with prefix `stories/` older than **2 days**.
   Stories vanish from the app on their own; this is what deletes the
   files. It costs nothing and needs no function.
5. `photos: true` in `features.js`, `npm run build`, commit, push.

Firestore itself stays in asia-south1; a bucket does not have to match it.

### A photo is stored as its download URL — and the URL names its bucket

That is the whole reason for storing the URL rather than a bare file
name. Photos from a US bucket are ~200–300 ms slower on first load in
India. If that ever matters, make a second bucket in asia-south1 and
upload NEW photos there: every stored record still says where its own
file lives, so nothing moves and nothing is migrated. `isOurPhotoUrl`
(and `okPhotoUrl` in the rules) accept any bucket named
`livesociyaweb…` for exactly this.

### Only the owner's own upload is accepted, and only that is drawn

`firestore.rules` accepts a photo URL only if it points into the
writer's own folder (`events/<uid>/…`, `avatars/<uid>/…`) of one of this
project's buckets; `storage.rules` only lets you write under your own
uid, only JPEG, never overwrite. The client checks the same pattern
before drawing (`eventPhotos()`), so a document edited by hand still
cannot put a stranger's picture — or a tracking pixel — on a card.

The avatar field used to accept ANY string under 300 characters, which
meant any https address at all, fetched by every browser that drew the
profile. It is now an emoji, the Google photo from sign-in, or your own
upload (`okAvatar`).

### Squeezed on the device

`compressImage` redraws every photo on a canvas and re-encodes it as
JPEG at 0.82: events at 1600px on the long edge, profile pictures cut to
a centred 512px square. A 4 MB phone photo becomes ~200 KB, which is the
difference between a second and a minute on campus wifi, and makes the
free allowance last twenty times longer. Re-encoding also drops EXIF,
including the GPS position nobody meant to publish.

### Publishing never waits for a photo

The feed rule (`feed.md`, optimistic first) holds: the event is
published exactly as before, then `commitTray` compresses and uploads
behind it and writes `photos` in one update. A photo that fails costs
that photo and one toast, never the event. A photo taken off an event,
or an upload that ended up unused (a profile photo you replaced before
saving), is deleted from Storage — a profile costs one file, not one
per try. Deleting an event deletes its photos.

### The cover: under the band, never over it

The band is the poster's headline — the vibe colour, the category,
WHEN — so the cover goes UNDER it, inside the card's gutter, held by the
same hairline as every surface, at a fixed 16:9 capped at 320px tall.
A tall phone photo cannot turn one card into a wall, and a feed of
mixed photos keeps one rhythm. No text on the photo, no shadow, no
overlay. "1/3" in mono says there is more.

### The event page

Tapping a card's title, place or cover opens it. The card clips; the
page does not: the whole place, the whole note, start to end, who is
going, the same action row (`cardActions`, shared, so the two can
never offer different things), every photo uncropped — the cover under
the band, the rest after the details — and Report. It reads nothing:
it paints from `state.eventCache` and `renderEvents()` repaints it, so
it cannot disagree with the card. It is rebuilt only when its markup
changed, so the minute tick never reloads its photos; times go through
the same `data-vt` slots as the feed (the page carries `data-eid`,
because it cannot reuse the card's element id).

A report from the page is filed with `targetType: "event"` and the
event id, against the host. The rules allow `user` and `event` for now;
photos, stories and comments join that list as they arrive.


### Photos in a thread

A message may carry `photo` (the sender's own upload in `chats/<uid>/`),
with its `text` as the caption, possibly empty. The rules take a photo
only in a thread that is UNLOCKED — the one opening line to a stranger
stays words — and taking a message back removes the photo from the
message and deletes the file. The inbox preview says "📷".

Chat photo URLs are unguessable but not secret: anybody given the link
can open it, as with every download URL. That is the same trade every
photo here makes; a photo that must never leave a conversation is not
something this app can promise.

### Memories: what a finished event becomes

On the page of any event that is over: photos from the people who went
(three each, enforced by the id `<uid>_<0|1|2>`, not by counting),
likes, and comments. A profile's Hosted and Joined rows for finished
events open that page, with the event's cover as their thumbnail — so a
profile reads as a journal of what they went to, for as long as the
event exists, not just while it sits in Recap.

- `events/{id}/memories/{uid_n}` — only people who went, only after it ended
- `events/{id}/social/likes` — ONE doc of uids: one read answers "how
  many" and "have I"; you may only add or remove yourself (like hype)
- `events/{id}/comments/{cid}` — 300 characters, server-stamped, never
  edited; the author, the host or the admin deletes; somebody the host
  blocked cannot comment

Read with three gets when the page opens, never a listener: a finished
event is not busy enough to be worth one on every phone. Likes and
comments work with the flag off; adding photos needs it.

**The journal.** On a profile, what is live or coming up stays a row
(it is about getting there). What is over becomes a grid of memory
cards — the cover, or the vibe colour and its glyph; the title; when
and how many went — with the like and comment buttons INSIDE the card.
Anyone who hosted or went can take an event off THEIR OWN profile (the
card's ⋯, or "Remove from my profile" on the event page). The event,
its memories and everyone else's profile are untouched; the ids go in
`hiddenEvents` on your profile document, which the profile already
reads, so hiding is one write and no reads. Only you see "n hidden from
your profile", and can put any of them back.

**Like and comment in the card's own voice.** The buttons are `.act`
glyphs, like a live card's Hype and Chat — no pills. On a Recap card
they ARE the card's action row (same dotted rule, same padding), with
View at the right; on a phone that row never becomes the two-row layout
a live card uses, because it has no primary to press.

**Like and comment without opening anything.** Having to open an event
to react to it is a step people skip. So every Recap card and every
finished event on a profile carries its own heart and comment button:
the heart works in place, the comment button opens a SHEET over what
you were looking at (with "Open event" if you want the rest). The bar
needs one document — `social/likes` holds the likes AND the comment
count — read only when the card scrolls into view (IntersectionObserver),
once per session. Its slot is empty in the card's markup and filled
after the diff, like a `data-vt` slot, so a like never rebuilds a card.

**The count moves with the comment, in one batch.** A comment's create
rule requires `social/likes.lastCommentId` to name it after the batch,
and the count may only move by one, towards a comment that is really
appearing or really going. So the number on a card cannot be inflated
and does not drift. A delete (by the author, the host or the admin)
goes the same way (`deleteCommentBatch`).

**Replies and tags.** Reply puts `@handle ` at the front of your box.
Typing `@` suggests people already on the event (host, who went, who
commented) — no reads. An `@handle` in a comment is a tap to that
profile, looked up only when tapped. Nobody is NOTIFIED of a tag yet:
that arrives with push notifications.

### The event page, on a phone and on a laptop

On a phone it is ONE card: the event, then — after a dotted tear, like
a card's action row — the people, the actions and the comments. Labels
sit tight on the line they label.


Past 1100px every full-screen view centres a 640px column; the event
page is the exception. It is two columns, 1060px across: the event on
the left, and on the right the people, the actions and — on a finished
event — the memories and comments, with the comment box at the bottom
of that column (the column is sticky and scrolls its own comments, never
taller than the window). On a phone the two stack, and the box sticks
to the bottom of the screen while the comments are on it.

The comment box lives OUTSIDE the painted page body. The page is
repainted whenever the event changes, and a box you are typing in must
never be rebuilt under you.

### Stories

`stories/{id}`: `{ uid, photo, caption, hours, audience, song, createdAt }`.
`hours` is one of 2, 3, 6, 12, 24; when it ends is the SERVER's createdAt
plus that, so nobody can date one to stay up for a week. A private
account's stories are `audience: "followers"`, and the rules refuse a
public one from it.

Rings go at the head of the live rail, before the live events, in
FOREST: ember means happening this minute, and a story is not. Seen
stories go grey (kept in this browser). One listener brings public
stories (newest 60 of the last day); private accounts you follow are one
get each, at most ten, every half hour.

**The song sticker, and why it cannot play by itself.** Instagram pays
record labels for the right to play music under a photo; a small app
cannot get that licence, uploading songs is infringement, and Spotify's
developer terms forbid syncing their music with images. So a story
carries a LINK to the song on Spotify, YouTube Music, JioSaavn, Apple
Music, Gaana or Wynk, plus "Song — Artist". Tapping it plays Spotify in
Spotify's own player (started by the person, never under the photo on
its own) and opens anything else on its own site. The allowed hosts are
in `storyRules.js` and `okSong` in the rules — change both.

### Reports, and the admin

Anything can be reported: a person, an event, a message, a comment, a
memory photo, a story. A report carries the type, an id that says where
the thing is, and a COPY of what was said or shown (`excerpt`) — so a
direct message can be judged without the admin being able to read
anybody's conversation.

What you reported disappears from YOUR screen at once (`hiddenService`,
this browser only). It cannot disappear for everybody until the admin
has looked: counting reports would mean telling somebody who reported
what, and reports are anonymous.

**Making someone the admin:** Firebase console → Firestore → start a
collection `admins`, document id = their uid, any field. Nobody can do
this from the app. The admin then sees "Reports to review" in Settings:
each open report, with **Remove** (events, comments, memory photos,
stories — not a direct message, which nobody outside the conversation
can touch), **Ban** (the account can still read but can no longer
publish events, stories, memories or comments, and is signed out with a
notice) and **Dismiss**. Each outcome is recorded on the report.

Bans are enforced by `notBanned()` in the rules on those writes. It is
not on messages: that would be one extra read on every message sent,
and blocking already covers a thread.
