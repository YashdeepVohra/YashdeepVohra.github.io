# livesociya — Security & Launch Notes

Written for the UID-based rewrite. Read this before you put the link in
a college WhatsApp group.

---

## 1. Why the app moved from usernames to UIDs

The old schema identified people by their handle: `users/{email}` held a
`username`, a *second* `users/{username}` document held the profile, and
events, chats and messages all stored `user: "yash"`.

That is unfixable from a rules perspective. A rule can check
`request.auth.uid` for free, because the server already verified the
Google sign-in token. It cannot check a username without reading a
document to ask "who owns this handle?" — on **every single write**.
That is slow, costs a read per operation, and any gap in the lookup
chain is an impersonation bug.

Now:

| Thing | Old | New |
|---|---|---|
| Profile | `users/{email}` **and** `users/{username}` | `users/{uid}` — one doc |
| Handle | field on two docs | `usernames/{handle} -> { uid }`, create-once |
| Event host | `user: "yash"` | `hostUid` |
| Going / hype | `participants[]`, `hypedBy[]` of names | `participantUids[]`, `hypedUids[]` |
| Chat id | `"yash_riya"` | `"<uidA>_<uidB>"`, sorted |
| Message author | `sender: "yash"` | `senderUid` |
| Email | in a world-readable doc | `users/{uid}/private/contact`, owner only |

Every ownership rule is now a one-line comparison against
`request.auth.uid`, which is the whole reason the rules in
`firestore.rules` are short enough to actually audit.

---

## 2. About the Firebase API key

A Firebase Web `apiKey` **is not a secret**. It is a public project
identifier, like a URL. It ships inside the JavaScript of every Firebase
web app in existence, and anyone can read it from DevTools in seconds.

Moving it to an `.env` file, a build variable, or a private repo changes
nothing — the value still ends up in the bundle the browser downloads.
Anyone telling you otherwise is repeating a myth.

Keeping it in `js/config/firebase.js` is good **organisation**, and that
is the honest reason it lives there. The things that actually protect
your data are items 3–6 below.

---

## 3. Deploy the rules (do this first)

```bash
npm install -g firebase-tools
firebase login
firebase use livesociyaweb
firebase deploy --only firestore:rules,firestore:indexes
```

Until you run this, your database is running on whatever rules the
console has — very often `allow read, write: if true`, which means any
person on the internet can read every message in the app with a
ten-line script.

Check it: Firebase console → Firestore → Rules. The banner at the top
must not say your database is open.

### The composite index

`firestore.indexes.json` contains one index (`participantUids` +
`expiresAt`) used by the "have we crossed paths?" check that decides
whether a first DM is an icebreaker. Without it that query throws and
every first message falls back to icebreaker mode.

---

## 4. Turn on App Check

Rules answer "is this user allowed?". App Check answers "is this
request even coming from my app?" — it blocks someone hitting your
Firestore REST endpoint with a script.

Firebase console → App Check → register the web app with **reCAPTCHA
Enterprise**, add the site key to `index.html`, then set Firestore to
**Enforced** *after* you have confirmed the app still works in
monitoring mode.

---

## 5. Lock sign-in to your college

Two halves, and you want both:

**Client (convenience)** — in `js/services/authService.js`, uncomment:

```js
provider.setCustomParameters({ hd: "yourcollege.edu" });
```

**Rules (enforcement)** — in `firestore.rules`, edit `campusMember()`
to your real domain and swap `signedIn()` for `campusMember()` in the
`allow read` / `allow create` lines. The client half is only a hint;
the rules half is what actually stops a gmail account.

Also: Firebase console → Authentication → Settings → **Authorized
domains**. Remove anything you don't own, and make sure your Vercel
domain and the `CNAME` domain are both listed.

---

## 6. What the rules now guarantee

- A handle can be claimed exactly once, and **never changed**. The
  uniqueness comes from Firestore itself: `usernames/{handle}` is
  create-only, so the second person to try gets `permission-denied`.
  No race condition, no server code.
- One handle per account.
- Nobody can set `banned`, change their own `uid`, or edit another
  person's profile.
- Only the host can edit or delete an event.
- Everyone else can only add or remove **themselves** from
  `participantUids`, `hypedUids` and `typingUids` — so no signing
  classmates up for things, and no fake hype counts.
- **Capacity is enforced by the database**, not just greyed out in the
  UI. Joining a full event from the browser console now fails.
- Event chat is readable only by that event's participants; a DM is
  readable only by its two members.
- Messages are immutable; you can delete your own, and a host can
  moderate their event's chat.
- Email addresses are not in any publicly readable document.
- Everything not explicitly allowed is denied.

---

## 7. Known gaps — decide before launch

**Icebreaker limit is UI-only.** The "one message until they reply"
rule is enforced in `chatService.js`, but a rule cannot count documents,
so someone using the console could send more. Closing this needs a
message counter on the chat doc or a Cloud Function.

**No rate limiting.** Nothing stops a script creating a thousand events.
Firestore rules can't do time-window limits. If this becomes a problem,
a Cloud Function with a per-user counter is the usual fix.

**Blocking and reporting now exist.** A block is one document per pair
at `blocks/{uidA_uidB}`, uids sorted — not a row per direction, so the
two halves can never disagree. It is total: their events disappear from
your feed, they are scrubbed from attendee lists, the conversation
leaves your inbox, and neither of you can message or join the other.
Contact and join denial are enforced in the rules, not just the UI.
Because a direct chat's id IS the block key, a blocked message is
rejected by one existence check.

Searching a blocked handle returns the same "does not exist" message as
an unknown handle. That is deliberate — a different message confirms
the block, and on a small campus that is how a block becomes a
confrontation.

Reports go to a write-only `reports` collection: students can file,
nobody can read from the client. **Read them in the Firebase console —
nothing notifies you**, so check it during your first weeks.

Known limitation, accepted deliberately: both sides can read the block
document, so a technically capable person could infer they were blocked
from their own data. Hiding that needs server-side filtering (a Cloud
Function on the Blaze plan). The alternative — keeping the block
private to the blocker — would mean the blocked person still sees your
events and therefore your location, which is the worse risk of the two.
Every major platform lets a blocked user work it out.

**Banning is still manual.** `banned` exists on the profile but nothing
enforces it; the quickest real ban is Firebase console → Authentication
→ disable the account, which invalidates their token everywhere.

**No content moderation.** Worth at least a plan before launch day.

**XSS was fixed in this pass** — event titles, places, descriptions,
display names and messages were all being written straight into
`innerHTML`, so anyone could have run JavaScript in every other
student's browser by naming an event with a `<script>` tag. Everything
now goes through `escapeHtml()` in `js/utils/formatters.js`, and no
user-typed text is ever placed inside an inline `onclick` attribute —
handlers receive Firebase ids only. **If you add new rendering code,
keep that rule.**

---

## 8. Wiping the old data

The new code does not read the old username-keyed documents. Before you
launch, delete these collections in the Firebase console:

- `users` (both the email-keyed and username-keyed docs)
- `usernames`
- `events`
- `chats`
- `messages` (the old flat collection — messages now live in
  subcollections under `chats/` and `events/`)

Then sign in again: your account will be recreated as `users/{uid}` and
you will be asked to claim your handle once more.
