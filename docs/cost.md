# Cost model — what each feature costs in reads

Firestore charges per document read. A snapshot listener bills **one read
per changed document per connected client**, so the shape is
`changes x people watching`. Roughly 31.5k reads/day at 300 daily actives,
inside the 50k free tier; ~₹170/month at launch-night intensity.

Decisions already made, with the reason, so they don't get undone:

| | why |
|---|---|
| Feed capped at `LIVE_LIMIT = 60`, recap paged | the recap used to load with the feed and nobody opened it |
| Events tagged with `circleId`, filtering off for now | 60 is plenty for one campus and meaningless across many — but filtering on one value removes nothing and costs an index, so it waits for the second circle |
| Messages: 25 live + paged scrollback | full history on every chat open |
| Profiles cached in localStorage, 6h TTL | ~20 reads per open for data that changes twice a year |
| Firestore offline persistence on | resume tokens: only changed docs bill |
| Hype writes debounced 900ms | a misclick costs nothing; a burst is one write |
| `following` stays an array on your own profile | one read gives your whole list, which is what answers "am I following them?" on every card |
| `followers` is a subcollection + a `followerCount` field | the array was capped at 5000, rewrote a whole document per follow, and shipped a private account's follower list to anyone signed in. The count costs nothing to read; the list is queried only when somebody opens it |
| Recap query spans 48h, filtered client-side, max 3 pages per load | retention is computed from three fields; no server to store it |
| Profile Hosted/Joined: two `get()`s, counts from the same docs | was a listener + two duplicate count queries |
| Pinned message in a subcollection, holding a copy of the text | a field on the event bills the whole campus a read |
| Poster cards cost ~29% more DOM than the rows they replaced | measured: style recalc went 4.3ms -> 0.2ms, layout unchanged. The nodes cost nothing in a frame; the old transitions did |
| A shared event card reads the event once, cached and de-duplicated | ten copies of one link in a thread are one read |
| The receipt folds events already in the cache, debounced | a history collection would be a write per event |
| Inbox: 20 chats live, older pages read once on request | a change to an old thread bills nobody; a long inbox costs what is on screen |
| Inbox preview is a copy on the chat doc | the chat doc is already written on every send and already read by the inbox listener: 0 extra reads, 0 extra writes |
| Active now: no listener, gets for the top 8 on screen, cached 3 min; heartbeat every 4 min while visible | a listener bills every watcher per heartbeat. This way ~8 reads per inbox look (≈ +7–9k/day at 300 DAU) and ~8 writes per half-hour session |

The remaining lever, if reads ever bite: drop `LIVE_LIMIT` to ~30.


The scale audit (ceilings on every query, rate limits, what is left) is `docs/scale.md`.
