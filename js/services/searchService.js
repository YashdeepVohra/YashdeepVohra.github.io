// ==========================================
// SEARCH
// ==========================================
//
// Two different problems, two different solutions:
//
//   People — a prefix query over the `usernames` collection, ordered by
//     document id. Firestore can serve `startAt(q) / endAt(q + )`
//     from the automatic id index ( is the highest code point,
//     so it bounds the range), so "ri" finds "riya" with no extra
//     index and no scan.
//
//   Events — filtered in memory. The feed already holds every event of
//     the last 24 hours in state.eventCache, so searching it is instant,
//     free, and can match on words in the middle of a title, which
//     Firestore cannot do without a third-party search service.
//
// Both halves are forgiving now: see matchRules.js for the scoring.
// What that costs, and what it cannot do:
//
//   Events cost nothing. They are already in memory, and fuzzy matching
//     a few dozen cached objects is free.
//
//   People are the awkward one, because a prefix query is the only
//     shape Firestore will serve without scanning the collection, and
//     a scan is exactly the thing that would make search expensive.
//     So there are three moves, in order of cost:
//       1. Everyone already in state.userCache is matched fuzzily and
//          on their DISPLAY NAME as well as their handle. This is free
//          — no reads at all — and it covers most real searches,
//          because you are usually looking for somebody you have
//          already seen in the feed, your orbit or a thread.
//       2. The prefix query, as before. One read-batch.
//       3. Only if that came back thin, ONE retry with the last
//          character or two dropped. This is what makes "sanchitt"
//          find sanchit. It is bounded to one extra query, and it only
//          happens when the first one nearly missed.
//     A typo in the FIRST letter of a handle still cannot be fixed on
//     the server — "ranchit" will not reach sanchit unless he is
//     already cached. Fixing that needs either a scan or a search
//     service, and neither is worth it yet.
// ==========================================

import { db, FieldPath } from '../config/firebase.js';
import { state } from '../state/store.js';
import { normalizeUsername, primeUsers, displayNameFor, usernameFor } from './userService.js';
import { isBlocked } from './blockService.js';
import { scoreMatch, rank, normalize } from './matchRules.js';

const PEOPLE_LIMIT = 12;
const EVENT_LIMIT = 12;
// Below this many hits from the exact prefix, it is worth one more
// query with a shorter prefix before giving up on the typist.
const THIN = 4;

/** Everyone we already hold, matched without touching the network. */
function peopleFromCache(rawQuery) {
  const cache = state.userCache || {};
  const uids = Object.keys(cache).filter(
    (uid) => uid && uid !== state.uid && !isBlocked(uid)
  );
  return rank(rawQuery, uids, (uid) => [usernameFor(uid), displayNameFor(uid)]);
}

/**
 * One prefix query. Returns { uid, handle } — the handle comes off the
 * document ID, which is free: the `usernames` collection is keyed by
 * it. That matters, because it means the whole list can be ranked
 * before deciding whose profile is worth a read.
 */
async function prefixQuery(prefix) {
  const snap = await db.collection("usernames")
    .orderBy(FieldPath.documentId())
    .startAt(prefix)
    .endAt(prefix + "")
    .limit(PEOPLE_LIMIT + 6)
    .get();

  return snap.docs
    .map((d) => ({ uid: (d.data() || {}).uid, handle: d.id }))
    .filter((r) => r.uid && r.uid !== state.uid && !isBlocked(r.uid));
}

/**
 * People search. Returns uids — never blocked people, never you —
 * best match first.
 */
export async function searchPeople(rawQuery) {
  const q = normalizeUsername(rawQuery);
  if (q.length < 2) return [];

  // Free first, so a cached match is on screen even if the network is
  // slow or the query below fails outright.
  const cached = peopleFromCache(rawQuery);

  let remote = [];
  try {
    remote = await prefixQuery(q);

    // Nearly nothing came back, and the query is long enough that a
    // trailing typo is the likely reason. One more go, one letter
    // shorter — two for a long handle, where a doubled letter and a
    // missed one can both be at the end.
    if (remote.length < THIN && q.length >= 4) {
      const shorter = q.slice(0, q.length >= 8 ? -2 : -1);
      if (shorter.length >= 2) {
        const second = await prefixQuery(shorter);
        const seen = new Set(remote.map((r) => r.uid));
        second.forEach((r) => { if (!seen.has(r.uid)) remote.push(r); });
      }
    }
  } catch (e) {
    console.error("People search failed:", e.code || e.message);
  }

  // Merge. Cached people are scored on handle AND the name you see;
  // remote ones on the handle alone, which is all that is known for
  // free at this point. Both go through the same scorer, so an exact
  // handle still outranks a fuzzy name.
  const scores = new Map();
  const keep = (uid, score) => {
    if (score === null) return;
    const had = scores.get(uid);
    if (had === undefined || score > had) scores.set(uid, score);
  };
  cached.forEach((r) => keep(r.item, r.score));
  remote.forEach(({ uid, handle }) => {
    // A row the prefix query returned belongs in the list even if the
    // scorer is unimpressed — it literally starts with what was typed.
    // The floor keeps it below anything that matched properly.
    const s = scoreMatch(rawQuery, handle);
    keep(uid, s === null ? 1 : s);
  });

  const best = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uid]) => uid)
    .slice(0, PEOPLE_LIMIT);

  // Only now, once the list is decided, is a profile worth reading —
  // so the read cost is the same as it was before any of this.
  await primeUsers(best);
  return best;
}

/**
 * Event search across title, place and vibe. Matches anywhere in the
 * text, matches the host's name so "riya" finds her events, and
 * tolerates a typo.
 *
 * Relevance leads, then how live it is. The other way round put a
 * finished event that was clearly the one you meant underneath three
 * live ones that merely shared a letter.
 */
export function searchEvents(rawQuery) {
  if (normalize(rawQuery).length < 2) return [];

  const now = Date.now();
  const order = state.eventOrder || [];
  const events = order
    .map((id) => state.eventCache[id])
    .filter((e) => e && !isBlocked(e.hostUid));

  const liveness = (e) => (e.expiresAt <= now ? 2 : now >= e.startTime ? 0 : 1);

  return rank(rawQuery, events, (e) => [e.title, e.place, e.tag, displayNameFor(e.hostUid)])
    .sort((a, b) =>
      b.score - a.score ||
      liveness(a.item) - liveness(b.item) ||
      a.item.startTime - b.item.startTime)
    .map((r) => r.item)
    .slice(0, EVENT_LIMIT);
}
