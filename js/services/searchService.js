// ==========================================
// SEARCH
// ==========================================
//
// Two different problems, two different solutions:
//
//   People — a prefix query over the `usernames` collection, ordered by
//     document id. Firestore can serve `startAt(q) / endAt(q + \uf8ff)`
//     from the automatic id index (\uf8ff is the highest code point,
//     so it bounds the range), so "ri" finds "riya" with no extra
//     index and no scan.
//
//   Events — filtered in memory. The feed already holds every event of
//     the last 24 hours in state.eventCache, so searching it is instant,
//     free, and can match on words in the middle of a title, which
//     Firestore cannot do without a third-party search service.
// ==========================================

import { db, FieldPath } from '../config/firebase.js';
import { state } from '../state/store.js';
import { normalizeUsername, primeUsers, displayNameFor } from './userService.js';
import { isBlocked } from './blockService.js';

const PEOPLE_LIMIT = 12;
const EVENT_LIMIT = 12;

/** Handle prefix search. Returns uids, never blocked people or yourself. */
export async function searchPeople(rawQuery) {
  const q = normalizeUsername(rawQuery);
  if (q.length < 2) return [];

  try {
    const snap = await db.collection("usernames")
      .orderBy(FieldPath.documentId())
      .startAt(q)
      .endAt(q + "\uf8ff")
      .limit(PEOPLE_LIMIT + 6)
      .get();

    const uids = snap.docs
      .map((d) => (d.data() || {}).uid)
      .filter((uid) => uid && uid !== state.uid && !isBlocked(uid))
      .slice(0, PEOPLE_LIMIT);

    await primeUsers(uids);
    return uids;
  } catch (e) {
    console.error("People search failed:", e.code || e.message);
    return [];
  }
}

/**
 * Event search across title, place and vibe. Matches anywhere in the
 * text, and also matches the host's name so "riya" finds her events.
 */
export function searchEvents(rawQuery) {
  const q = String(rawQuery || "").trim().toLowerCase();
  if (q.length < 2) return [];

  const now = Date.now();
  const order = state.eventOrder || [];

  return order
    .map((id) => state.eventCache[id])
    .filter((e) => {
      if (!e || isBlocked(e.hostUid)) return false;
      const haystack = [
        e.title,
        e.place,
        e.tag,
        displayNameFor(e.hostUid)
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    })
    // Live first, then upcoming, then finished.
    .sort((a, b) => {
      const rank = (e) => (e.expiresAt <= now ? 2 : now >= e.startTime ? 0 : 1);
      return rank(a) - rank(b) || a.startTime - b.startTime;
    })
    .slice(0, EVENT_LIMIT);
}
