// ==========================================
// RATE LIMITS — the client half
// ==========================================
//
// The rules decide; this only carries the paperwork. Every limited
// action writes a timestamp into users/{uid}/private/limits IN THE SAME
// BATCH as the action itself, and the rule for the action uses
// getAfter() to check that the stamp really landed.
//
// Two things follow from that. Skipping the stamp is not a way round
// the limit — without it the action is refused. And the stamp cannot
// lie, because the rule on the limits document itself requires every
// timestamp in it to equal request.time, so it can only ever say "now".
//
// serverTimestamp() is what makes that work: the value is filled in by
// the server, which is also what request.time is, so the two match. A
// clock set wrong on somebody's laptop changes nothing.
// ==========================================

import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** This user's ledger. */
export function limitsRef() {
  return db.collection("users").doc(state.uid).collection("private").doc("limits");
}

/**
 * Add the stamp for a "start something" action to a batch.
 *
 * The rolling daily ceiling is counted here and checked there: if the
 * window is more than a day old the rule expects the count to restart
 * at one, and otherwise to be exactly one more than it was.
 */
export function stampEvent(batch, current) {
  const now = Date.now();
  const openedAt = current && current.eventWindowAt && current.eventWindowAt.toMillis
    ? current.eventWindowAt.toMillis()
    : 0;
  const stillOpen = openedAt && now - openedAt < DAY_MS;

  batch.set(limitsRef(), stillOpen
    ? {
        eventAt: FieldValue.serverTimestamp(),
        eventCount: (current.eventCount || 0) + 1
      }
    : {
        eventAt: FieldValue.serverTimestamp(),
        eventWindowAt: FieldValue.serverTimestamp(),
        eventCount: 1
      }, { merge: true });
}

/**
 * The gap the rules insist on between two asks (follow requests and
 * orbit requests share it). Kept a little above the rule's 3 seconds so
 * the client never loses a race with the server's clock.
 */
export const ASK_GAP_MS = 3500;
let lastAskLocal = 0;

/** How long until another ask would be accepted. 0 means now. */
export function msUntilAskAllowed() {
  return Math.max(0, lastAskLocal + ASK_GAP_MS - Date.now());
}

/** Add the stamp for asking to follow, or asking into an orbit. */
export function stampAsk(batch) {
  lastAskLocal = Date.now();
  batch.set(limitsRef(), { askAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** Read the ledger. One read, and only when about to start an event. */
export async function readLimits() {
  try {
    const doc = await limitsRef().get();
    return doc.exists ? doc.data() : {};
  } catch (e) {
    return {};
  }
}

/**
 * Turn a refusal into something a person can act on. A rules rejection
 * arrives as a flat permission-denied, so the reason has to be inferred
 * from what we know we just tried to do.
 */
export function limitMessage(kind) {
  if (kind === "event") {
    return "Give it a minute before starting another one. You can start 25 in a day.";
  }
  return "Slow down a moment — try that again in a few seconds.";
}
