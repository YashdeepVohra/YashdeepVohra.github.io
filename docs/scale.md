# Scale: what keeps the site up when it gets busy

Read before adding a query, a listener, or anything people can post.
The cost model in `CLAUDE.md` is the per-feature table; this is the
audit of what could fall over, what was done about it, and what is
left.

## Every read is bounded

| Where | Ceiling |
|---|---|
| Live feed | one listener, `LIVE_LIMIT` = 60 |
| Recap | 48 h window, paged, at most 3 pages per load |
| A profile's history | newest **12** per tab, "Show older" pages 12 more (was 30 + 30 on every open) |
| Inbox | 20 live, older a page at a time |
| A thread | 25 live, scrollback paged |
| Memories | 30 photos, newest 50 comments, one `social/likes` doc — gets, never listeners |
| Like/comment bar on a card | one doc, only once the card scrolls into view |
| Stories | one listener, newest 60 of the day; private accounts ≤ 10 gets per half hour |
| Blocks, orbit | listeners capped at 500 (were unbounded) |
| Follow requests | 200 |
| Admin reports | newest 50 |
| Names and faces (`primeUsers`) | 9 or more missing profiles are fetched thirty to a request (`in` on the document id), not one request each — same reads, a tenth of the round trips, never a burst of hundreds from one phone |

## Every write people can repeat is limited by the rules

| What | Limit | How |
|---|---|---|
| Starting an event | 90 s apart, 25 a day | `private/limits` stamp in the same batch |
| Follow / orbit asks | 3 s apart | same |
| Comments, stories, reports | **4 s apart** | same (`postAllowed()`); the app holds a second one and says "slow down" |
| Messages | the icebreaker for strangers; blocking | — |
| Joining an event | **1000 going at most**, 5000 hyped, 500 waiting, even with no cap | `withinCapacity()`; the app shows Full |

**The ledger itself was open.** Rules OR together, and
`users/{uid}/private/{docId}` allowed its owner any write — including to
`private/limits`, which meant the rate limits could be reset between
posts. That match now excludes `limits`, and the ledger's own rule only
lets a stamp say "now" (or stay put), the count go up by one, and the
day's window restart once it is a day old.

## Why a thousand

An event document goes to every phone watching the feed each time it
changes. Its arrays (`participantUids`, `hypedUids`) grow with the
crowd; at a few thousand the document is tens of kilobytes, sent on
every join and every hype to every watcher, and Firestore's hard limit
is 1 MB. A thousand is more than any campus event needs.

## What is left, in order

These need the Firebase or Google Cloud console, not code.

1. **App Check (the most important one).** Anyone can take the public
   config from the page and script reads against your database from
   their own machine; the rules stop them *changing* things, not from
   reading a lot. App Check makes Firestore accept only requests from
   your real site. Console → App Check → register the web app with
   reCAPTCHA v3 (or Enterprise) → then ask for the one-line code change
   to activate it → watch the metrics for a few days → **Enforce**.
2. **Budget alert** — Google Cloud → Billing → Budgets. Already on the
   Blaze checklist; worth doing the day you upgrade.
3. **Hot events.** Firestore sustains about one write a second to a
   single document. A very popular event taking many joins and hypes a
   second will see some retried writes (hype is already debounced to
   one write per burst). If that ever happens for real, the fix is to
   move hype counts off the event document the way the pinned message
   was moved — a bigger change, not needed yet.
4. **The feed's fan-out.** Every change to any of the 60 live events
   is one read for every phone watching the feed. That is the shape of
   the bill as the app grows (`changes × watchers`). The lever is
   already written down in `CLAUDE.md`: drop `LIVE_LIMIT` to ~30, and
   scope the feed by circle once there is more than one college.
5. **Typing in a big event chat** is a listener on the event's typing
   documents; in a chat of hundreds it is the busiest thing in it. Fine
   at campus size; if it ever shows up in the bill, drop typing for
   event chats over a size.
