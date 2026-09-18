// ==========================================
// THE RECAP RECEIPT
// ==========================================
//
// Pure functions, no imports — the third file of this kind, after
// recapRules and messageRules, and for the same reason: the numbers
// are the feature, so they live somewhere they can be tested without
// a browser or a database.
//
// WHAT THIS IS. The Recap shows what just happened on campus; the
// receipt shows what happened to YOU. "You showed up 11 times this
// month, mostly with these four people." Nothing else in the app
// remembers anything for longer than 48 hours, so this is the only
// place where turning up accumulates into something.
//
// WHERE THE DATA COMES FROM, AND WHY IT COSTS NOTHING. It is folded
// out of events the app has ALREADY loaded — the live feed and the
// recap pages, both of which are on screen anyway. No history
// collection, no query of your own past, no server job at the end of
// an event. The fold is idempotent (an event id is counted once, ever)
// so it can safely run on every repaint.
//
// WHAT IT THEREFORE CANNOT KNOW. An event is only countable while it
// is still inside the 48-hour recap window. Go a long weekend without
// opening the app and those events expire uncounted. That is the
// honest trade for a feature with no server and no extra reads, and it
// is the reason the card says "since you've been using this" rather
// than claiming to be complete.
//
// STORED AT users/{uid}/private/receipt — under private/ because it is
// nobody else's business how often you go out, and because that path
// is already owner-only in the rules.
// ==========================================

// Enough to cover the months a student is actually on campus, without
// letting one document grow forever.
export const MONTHS_KEPT = 8;
// Every id we have already folded. Comfortably more than 48 hours of
// campus events, which is all that can ever be foldable at once.
export const COUNTED_KEPT = 150;
// Per month. The tail of this list is all ones and nobody reads it.
export const PEOPLE_KEPT = 24;

export function emptyReceipt() {
  return { months: {}, counted: [] };
}

/** "2026-09" — the month an event belongs to, by when it started. */
export function monthKey(ms) {
  const d = new Date(ms || 0);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

export function monthLabel(key) {
  const [y, m] = String(key || "").split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  if (isNaN(d.getTime())) return "";
  const thisYear = new Date().getFullYear();
  return d.toLocaleDateString([], Number(y) === thisYear
    ? { month: "long" }
    : { month: "long", year: "numeric" });
}

/**
 * Countable when it is over, you were on the list, and it has not been
 * counted before. "Over" matters: an event you are at right now is not
 * yet a thing you showed up to.
 */
export function countable(receipt, event, uid, now = Date.now()) {
  if (!receipt || !event || !uid) return false;
  if (!event.id || typeof event.expiresAt !== "number") return false;
  if (event.expiresAt > now) return false;
  if (!(event.participantUids || []).includes(uid)) return false;
  return !(receipt.counted || []).includes(event.id);
}

function trimTop(map, keep) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, keep);
  return Object.fromEntries(entries);
}

/**
 * Fold one event in. Returns a NEW receipt, or the same one untouched
 * if there was nothing to count — so a caller can compare by identity
 * to decide whether a save is needed.
 */
export function foldEvent(receipt, event, uid, now = Date.now()) {
  if (!countable(receipt, event, uid, now)) return receipt;

  const key = monthKey(event.startTime || event.expiresAt);
  const months = { ...(receipt.months || {}) };
  const prev = months[key] || { went: 0, hosted: 0, tags: {}, people: {} };

  const tags = { ...(prev.tags || {}) };
  if (event.tag) tags[event.tag] = (tags[event.tag] || 0) + 1;

  const people = { ...(prev.people || {}) };
  (event.participantUids || []).forEach((who) => {
    if (who && who !== uid) people[who] = (people[who] || 0) + 1;
  });

  months[key] = {
    went: (prev.went || 0) + 1,
    hosted: (prev.hosted || 0) + (event.hostUid === uid ? 1 : 0),
    tags,
    people: trimTop(people, PEOPLE_KEPT)
  };

  // Newest months win when the cap bites.
  const kept = Object.keys(months).sort().slice(-MONTHS_KEPT);
  const trimmedMonths = {};
  kept.forEach((k) => { trimmedMonths[k] = months[k]; });

  return {
    months: trimmedMonths,
    counted: (receipt.counted || []).concat([event.id]).slice(-COUNTED_KEPT)
  };
}

/** Fold a whole batch, in time order so the cap drops the oldest. */
export function foldAll(receipt, events, uid, now = Date.now()) {
  return [...events]
    .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))
    .reduce((acc, e) => foldEvent(acc, e, uid, now), receipt || emptyReceipt());
}

/**
 * What the card shows. A separate function from the fold so the card
 * can be reasoned about — and tested — without any writing involved.
 */
export function summarise(receipt, key = monthKey(Date.now())) {
  const m = (receipt && receipt.months && receipt.months[key]) || null;
  const base = {
    key, label: monthLabel(key),
    went: 0, hosted: 0, topTag: "", people: [], total: 0, months: 0
  };
  if (!receipt) return base;

  const allMonths = Object.keys(receipt.months || {});
  base.total = allMonths.reduce((n, k) => n + (receipt.months[k].went || 0), 0);
  base.months = allMonths.length;
  if (!m) return base;

  const tags = Object.entries(m.tags || {}).sort((a, b) => b[1] - a[1]);
  return {
    ...base,
    went: m.went || 0,
    hosted: m.hosted || 0,
    topTag: tags.length ? tags[0][0] : "",
    // Only people you have actually run into more than once are
    // interesting. One shared event is a coincidence, not a pattern.
    people: Object.entries(m.people || {})
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([uid, count]) => ({ uid, count }))
  };
}
