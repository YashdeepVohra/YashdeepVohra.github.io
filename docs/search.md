# Search

Read before touching `matchRules.js`, `searchService.js` or
`searchUI.js`.

Two halves, two different constraints, one shared scorer in
`matchRules.js` (pure — no DOM, no database, testable on its own).

Events are free: the feed already holds every event of the last 24
hours in `state.eventCache`, so matching a few dozen objects on every
keystroke costs nothing and can match mid-word, which Firestore cannot
do without a search service.

People are the awkward half, because a prefix query is the only shape
Firestore serves without scanning `usernames`, and a scan is exactly
the thing that would make search expensive. Three moves, in order of
cost:

1. Everyone already in `state.userCache` is matched fuzzily, on their
   display name as well as their handle. **No reads at all**, and it
   covers most real searches — you are usually looking for someone you
   have already seen in the feed, your orbit or a thread.
2. The prefix query, as before. One read-batch.
3. Only if that came back thin (< 4 hits), ONE retry with the last
   character or two dropped. This is what makes "sanchitt" find
   sanchit. Bounded to one extra query.

The handle comes off the document ID — `usernames` is keyed by it — so
the whole list is ranked *before* anything decides whose profile is
worth a read. `primeUsers` runs on the final twelve only, which is why
this costs the same as the strict version did.

What it still cannot do: a typo in the FIRST letter of a handle will
not reach the server ("ranchit" misses sanchit) unless he is already
cached. Fixing that needs a scan or a search service; neither is worth
it yet.

Two things about the scorer that are load-bearing:

- **A swap counts as one edit, not two.** Transposing two letters is
  the most common typo there is, and plain Levenshtein calls "chia" two
  edits from "chai" — far enough to miss at any sane threshold. The
  distance function is Damerau (optimal string alignment).
- **It gives up early.** It runs over every cached user on every
  keystroke on cheap phones, so it abandons a row the moment the whole
  row is past the budget, rather than filling the matrix.

The tiers matter more than the numbers: exact > starts with > a word
starts with > contains > all words present > a typo away > the letters
in the right order. An exact hit must always outrank a corrected one,
or searching a real handle starts putting strangers above the person
you meant.
