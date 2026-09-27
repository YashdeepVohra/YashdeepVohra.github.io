# Status — what is built, what is waiting, what the user will do

## Built and working

Built and working: UID migration, full rules, responsive layout, blocking
and reporting, request-to-join, host moderation, search, Orbit (mutual connections
+ vouches), follow and followers with private accounts and approval
(going public lets waiting requests in), rate limits, the icebreaker,
the day-one empty state, public/private at sign-up, dark mode, editing and
retracting a message (hold a bubble, or right-click on a desktop),
reactions, a host's pinned message, the Recap
receipt, the sage-on-paper redesign, the poster/stub cards, and share
links for an event.

Built, switched off until Blaze (`docs/photos.md`): profile pictures,
event photos with a cover in the feed, photos in chat, memory photos,
stories with a song sticker. Built and on: the event page (two columns
on a laptop), likes and comments on finished events — in place on Recap
cards and profile journal cards, with a comment sheet, replies and
@mentions — the profile journal (memory cards, "remove from my
profile"), Report on everything, the admin's report screen, rate limits
on posting, profile history 12 at a time, lists of people 20 at a time,
and the 80-character location limit.

Not built: push notifications (the client half needs no Blaze; the
sender is a Cloud Function in asia-south1, the Firestore region).

Considered and parked: voice notes. Everything above costs *reads*, which
have a 50k/day free tier. Voice notes cost storage and egress — a
different meter, needs Blaze, and the first feature whose bill goes up
while nobody is using it.


## WAITING ON THE USER (remember these — they said they will do them)

The user has no terminal for Firebase: rules and indexes are published by
pasting into the Firebase console (Firestore → Rules → Publish; Indexes →
Composite → Create). After ANY change to `firestore.rules`, remind them
to publish before `git push`.

On **Blaze day** (card added — `docs/photos.md` has the details):
1. Upgrade to Blaze; **budget alert** (~₹200/month) in Google Cloud Billing.
2. Storage → Get started → **US-CENTRAL1**. Paste `storage.rules` → Publish.
3. Create the two `stories` composite indexes (in `firestore.indexes.json`).
4. Cloud Storage lifecycle rule: delete `stories/` objects older than 2 days.
5. `photos: true` in `js/config/features.js`, build, commit, push.
6. **App Check** — the user said "later, on Blaze". Console → App Check →
   register the web app with reCAPTCHA v3 → then add the activation code
   (needs `firebase-app-check-compat`, activated before any Firestore
   call) → monitor → Enforce. See `docs/scale.md`.
7. Push notifications: a Cloud Function in **asia-south1** (Firestore's
   region) sends; the client half (permission, token, `sw.js` handler)
   can be built before.

Admin: the user is the admin via `admins/{their uid}` (made in the console).

## Findable by name

`index.html` carries the title, description, canonical, Open Graph,
Twitter card and a JSON-LD graph; `robots.txt` and `sitemap.xml` sit at
the root. The part that is not boilerplate is `alternateName` in the
structured data: "livesociya" is a coined word, so it gets typed wrong,
and "live sociya" / "livesocia" have to resolve to the same thing.

`robots.txt` disallows `/*?e=` on purpose. A shared event link points
at a private feed and is meant for one person; letting it into an index
would turn a share into a publication.

Worth knowing before expecting much: this is a client-rendered app
behind a sign-in, so a crawler sees the shell and the metadata and
nothing else. The tags make the SITE findable by name. They cannot make
individual events findable, and should not.
