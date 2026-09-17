// ==========================================
// RECAP — how long a finished event stays
// ==========================================
//
// It used to be a flat 24 hours. That treated a thing nobody came to
// exactly like the party half the campus went to: the empty one sat in
// Recap for a whole day, and the big one was gone before the people who
// missed it had even heard about it.
//
// Now the time an event stays is earned. Every signal comes from the
// event document itself — no extra reads, and every client computes
// the same answer from the same data.
//
//   points  = guests + hype / 2          (showing up is worth more
//                                          than tapping a flame)
//           + 2   if it filled up        (a full event was a hit)
//           x 0.5 if it ran < 20 minutes (a blip, not an event)
//
//   window  = 6h + 8h x log2(1 + points), capped at 48h
//
// Logarithmic, so the first few people matter most and a huge event
// can't squat on Recap for a week:
//
//   nobody came ............ 6h      7 guests ........... 30h
//   1 guest ................ 14h     15 guests .......... 38h
//   3 guests ............... 22h     30+ guests ......... 46–48h
//
// Two personal exceptions, because Recap is also your memory of the
// day: an event you hosted or went to stays for you for at least 24h.
// And one called off before it started stays for the minimum only.
// ==========================================

const HOUR = 60 * 60 * 1000;

export const RECAP_MIN_MS = 6 * HOUR;
export const RECAP_MAX_MS = 48 * HOUR;
export const RECAP_STEP_MS = 8 * HOUR;
export const RECAP_MINE_MS = 24 * HOUR;

/** Engagement an event earned, from its own document. */
export function recapPoints(e) {
  if (!e) return 0;
  const going = (e.participantUids || []).filter((u) => u !== e.hostUid).length;
  const hype = (e.hypedUids || []).length;
  let points = going + hype / 2;

  const attendees = (e.participantUids || []).length;
  if (e.maxCapacity && attendees >= e.maxCapacity) points += 2;

  const ran = (e.expiresAt || 0) - (e.startTime || 0);
  if (ran > 0 && ran < 20 * 60 * 1000) points *= 0.5;

  return points;
}

/** True when the host ended it before it ever began. */
export function wasCalledOff(e) {
  return !!e && e.expiresAt <= e.startTime;
}

/** How long, after it ends, this event stays in Recap. */
export function recapWindow(e, viewerUid = "") {
  if (!e) return 0;
  if (wasCalledOff(e)) return RECAP_MIN_MS;

  const earned = RECAP_MIN_MS + RECAP_STEP_MS * Math.log2(1 + recapPoints(e));
  let ms = Math.min(RECAP_MAX_MS, earned);

  const mine = viewerUid && (e.hostUid === viewerUid || (e.participantUids || []).includes(viewerUid));
  if (mine) ms = Math.max(ms, RECAP_MINE_MS);

  return Math.round(ms);
}

/** The moment it leaves Recap. */
export function recapUntil(e, viewerUid = "") {
  return (e?.expiresAt || 0) + recapWindow(e, viewerUid);
}

/** Ended, and not yet aged out. */
export function inRecap(e, now = Date.now(), viewerUid = "") {
  return !!e && e.expiresAt <= now && recapUntil(e, viewerUid) > now;
}
