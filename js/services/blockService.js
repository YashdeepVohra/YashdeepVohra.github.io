// ==========================================
// BLOCKING & REPORTING
// ==========================================
//
// A block is ONE document per pair, at `blocks/{uidA_uidB}` with the
// uids sorted. That shape does real work:
//
//   - It is symmetrical by construction. There is no "A blocked B" row
//     to keep in sync with a "B blocked by A" row, so the two can never
//     disagree and nobody ends up half-unblocked.
//   - For a direct chat, the block key IS the chat id, so the rules can
//     reject a message with a single existence check and no lookup.
//   - Both sides can read it (they are in `pair`), which is what lets
//     each client filter the other out locally.
//
// Honest limitation: because both sides can read the document, a
// determined person could discover they were blocked by reading their
// own data. Hiding that completely needs server-side filtering (a Cloud
// Function). The UI never reveals it — blocked people simply disappear.
// ==========================================

import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId } from '../utils/formatters.js';

/** Canonical block key for two uids — the same shape as a chat id. */
export function pairKey(a, b) {
  return [a, b].sort().join("_");
}

/** True if this person is blocked in EITHER direction. */
export function isBlocked(uid) {
  return !!uid && state.blockedUids.includes(uid);
}

/** Strip blocked people out of any list of uids. */
export function withoutBlocked(uids) {
  return (uids || []).filter((u) => !isBlocked(u));
}

/**
 * Live list of everyone blocked in either direction.
 * `onChange` re-renders whatever is on screen so a block takes effect
 * immediately rather than on next load.
 */
export function loadBlocks(onChange) {
  if (state.blocksUnsubscribe) state.blocksUnsubscribe();

  state.blocksUnsubscribe = db
    .collection("blocks")
    .where("pair", "array-contains", state.uid)
    .onSnapshot(
      (snapshot) => {
        const blocked = [];
        snapshot.forEach((doc) => {
          const data = doc.data() || {};
          const other = (data.pair || []).find((u) => u !== state.uid);
          if (other) blocked.push(other);
        });
        state.blockedUids = blocked;
        if (typeof onChange === "function") onChange();
      },
      (error) => console.error("Blocks error:", error.code || error.message)
    );
}

/** Everyone this user blocked themselves — the only ones they can lift. */
export async function myBlockList() {
  try {
    const snap = await db.collection("blocks")
      .where("pair", "array-contains", state.uid)
      .get();
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => b.blockerUid === state.uid)
      .map((b) => (b.pair || []).find((u) => u !== state.uid))
      .filter(Boolean);
  } catch (e) {
    console.error("Block list failed:", e.code || e.message);
    return [];
  }
}

export async function blockUser(targetUid) {
  if (!safeId(targetUid) || targetUid === state.uid) return false;
  const pair = [state.uid, targetUid].sort();

  try {
    await db.collection("blocks").doc(pair.join("_")).set({
      pair,
      blockerUid: state.uid,
      createdAt: Date.now()
    });
    return true;
  } catch (e) {
    // Already blocked (by either side) reads as a create on an existing
    // document, which the rules refuse. The outcome the user wanted is
    // already true, so treat it as success.
    if (e.code === "permission-denied" && isBlocked(targetUid)) return true;
    console.error("Block failed:", e.code || e.message);
    return false;
  }
}

export async function unblockUser(targetUid) {
  if (!safeId(targetUid)) return false;
  try {
    await db.collection("blocks").doc(pairKey(state.uid, targetUid)).delete();
    return true;
  } catch (e) {
    console.error("Unblock failed:", e.code || e.message);
    return false;
  }
}

export async function submitReport({ targetUid, reason, note = "", targetType = "user", targetId = "" }) {
  if (!safeId(targetUid)) return false;
  try {
    await db.collection("reports").add({
      reporterUid: state.uid,
      targetUid,
      targetType,
      targetId: String(targetId).slice(0, 128),
      reason: String(reason).slice(0, 60),
      note: String(note).slice(0, 500),
      createdAt: Date.now()
    });
    return true;
  } catch (e) {
    console.error("Report failed:", e.code || e.message);
    return false;
  }
}
