// ==========================================
// WHAT YOU MAY STILL DO TO A MESSAGE YOU SENT
// ==========================================
//
// Pure functions, no imports — the same shape as recapRules.js, and
// for the same reason: these rules ARE the feature, so they live in
// one small file that can be tested without a browser or a database.
//
// EDIT_WINDOW_MS is mirrored in firestore.rules (messageEditWindow).
// Change it in both places or the app will offer an edit the server
// then refuses, which reads as the app being broken.
//
// Two shapes of change, and only these two:
//
//   EDIT       rewrite the text inside 15 minutes. It always leaves
//              "edited" on the bubble — an edit is never silent, which
//              is the whole reason a window this short is safe.
//
//   RETRACT    take it back, at any time. The bubble stays and reads
//              "This message was deleted".
//
// Why a tombstone and not a real delete: a message that can vanish is
// a way around the icebreaker (send your one opening message, delete
// it, send another). The rules already refuse the second message
// because `icebreakerUsed` is one-way, but the client decides whether
// to lock the box by counting messages on screen — and a row that
// disappears makes that count lie. A tombstone keeps it honest, and
// it is also the kinder thing to read: a gap in a thread looks like
// tampering, "this message was deleted" looks like a person changing
// their mind.
// ==========================================

export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export function isDeleted(msg) {
  return !!(msg && msg.deleted === true);
}

export function isEdited(msg) {
  return !!(msg && msg.editedAt && !isDeleted(msg));
}

export function isMine(msg, uid) {
  return !!(msg && uid && msg.senderUid === uid);
}

/** Milliseconds left on the edit window. 0 once it has closed. */
export function editTimeLeft(msg, now = Date.now()) {
  if (!msg || typeof msg.time !== "number") return 0;
  return Math.max(0, msg.time + EDIT_WINDOW_MS - now);
}

export function canEdit(msg, uid, now = Date.now()) {
  return isMine(msg, uid) && !isDeleted(msg) && editTimeLeft(msg, now) > 0;
}

/** Taking something back has no clock on it — only rewriting does. */
export function canRetract(msg, uid) {
  return isMine(msg, uid) && !isDeleted(msg);
}

export function canReply(msg) {
  return !!msg && !isDeleted(msg);
}

/**
 * The action sheet, as a list of keys. Order matters: the harmless
 * things first, the irreversible one last.
 */
export function messageActions(msg, uid, now = Date.now()) {
  if (!msg || isDeleted(msg)) return [];
  const actions = ["reply", "copy"];
  if (canEdit(msg, uid, now)) actions.push("edit");
  if (canRetract(msg, uid)) actions.push("delete");
  return actions;
}

/**
 * "12 min left". The sheet says how long is left so the Edit option
 * disappearing later doesn't come as a surprise.
 */
export function editWindowLabel(msg, now = Date.now()) {
  const left = editTimeLeft(msg, now);
  if (left <= 0) return "";
  const mins = Math.ceil(left / 60000);
  return mins <= 1 ? "under a minute left" : mins + " min left";
}
