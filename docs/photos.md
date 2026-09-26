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

What does ship with the flag off: the event page, Report on it, the
location limit, and the tightened avatar rule. None of them need Storage.

### Switching it on

1. Upgrade to Blaze (card country: India, Visa/Mastercard — RuPay is
   usually refused). Set a budget alert at about ₹200/month.
2. Firebase console → Storage → Get started → **US-CENTRAL1**. Only
   `us-central1`, `us-east1` and `us-west1` get the no-cost allowance
   (5 GB stored, 100 GB/month out). The choice is permanent for that bucket.
3. `firebase deploy --only storage,firestore:rules`
4. `photos: true` in `features.js`, `npm run build`, commit, push.

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
