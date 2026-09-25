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

/**
 * Milliseconds out of a stamp, without importing anything — this file
 * stays a leaf on purpose. Same job as msOf() in utils/formatters.js.
 */
function ms(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return 0;
}

/**
 * When a message was really sent.
 *
 * `sentAt` is the server's own clock — firestore.rules requires it to
 * equal request.time, so it cannot be argued with. `time` is the
 * client's number, kept because the thread is ordered by it and
 * because a message written offline has to carry SOME stamp until it
 * commits. The window is measured against the server's whenever there
 * is one: otherwise a phone could buy itself an unlimited edit window
 * by lying about `time`, and `time` is the field a person controls.
 */
export function sentMs(msg) {
  if (!msg) return 0;
  return ms(msg.sentAt) || ms(msg.time);
}

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
  const sent = sentMs(msg);
  if (!sent) return 0;
  return Math.max(0, sent + EDIT_WINDOW_MS - now);
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

// ==========================================
// REACTIONS
// ==========================================
//
// Stored as a map on the message keyed by uid: { uid: emoji }. Keying
// it by uid rather than by emoji is what makes the rule cheap — "you
// may change your own key and nobody else's" is one diff check, the
// same shape as selfToggleOnly() for the arrays elsewhere.
//
// One reaction per person, so tapping a different emoji moves yours
// rather than adding a second. The list is fixed and mirrored in
// firestore.rules: an open string field here would be a second place
// to type anything into somebody else's thread.
//
// Cost: one write, and one read for each person watching that message
// — and only messages inside the live window are watched at all.

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

export function reactionOf(msg, uid) {
  return (msg && msg.reactions && msg.reactions[uid]) || "";
}

export function canReact(msg) {
  return !!msg && !isDeleted(msg);
}

/**
 * Tapping an emoji sets yours, or clears it if it was already that
 * one. Returns the emoji to store, or "" to remove the key.
 */
export function nextReaction(msg, uid, emoji) {
  if (!REACTIONS.includes(emoji)) return null;
  return reactionOf(msg, uid) === emoji ? "" : emoji;
}

/**
 * The chips under a bubble: biggest group first, ties broken by the
 * canonical order so they don't shuffle as counts change.
 */
export function reactionSummary(msg, uid) {
  const map = (msg && msg.reactions) || {};
  const counts = new Map();

  Object.keys(map).forEach((who) => {
    const emoji = map[who];
    if (!REACTIONS.includes(emoji)) return;   // ignore anything unexpected
    const row = counts.get(emoji) || { emoji, count: 0, mine: false };
    row.count++;
    if (who === uid) row.mine = true;
    counts.set(emoji, row);
  });

  return [...counts.values()].sort((a, b) =>
    b.count - a.count || REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji));
}

export function reactionCount(msg) {
  return reactionSummary(msg, "").reduce((n, r) => n + r.count, 0);
}

// ==========================================
// PINNING, IN AN EVENT CHAT
// ==========================================
//
// The host's actions are kept apart from messageActions() above
// because they answer a different question. messageActions asks "what
// may I do to something I wrote?"; this asks "what may I do to this
// thread?" — and the answer depends on who is hosting, not on who
// sent the message.

export function hostActions(msg, { isHost = false, pinnedId = "" } = {}) {
  if (!msg || isDeleted(msg) || !isHost) return [];
  return [pinnedId && pinnedId === msg.id ? "unpin" : "pin"];
}

/** The copy that goes in events/{id}/pinned/current. */
export function pinPayload(msg, byUid, now = Date.now()) {
  if (!msg || isDeleted(msg)) return null;
  const text = String(msg.text || "").trim();
  if (!text) return null;
  return {
    messageId: String(msg.id),
    // Capped because this is a copy, not the message: the bar shows
    // two lines, and the rules bound it at 300 anyway.
    text: text.slice(0, 300),
    senderUid: String(msg.senderUid || ""),
    byUid: String(byUid || ""),
    at: now
  };
}

// ---------------------------------------------------------------------
// THE INBOX PREVIEW
// ---------------------------------------------------------------------
// The line under a name in the chats list. It is a COPY on the chat
// document (lastText), written in the same write that already bumps
// lastUpdated on every send, so showing it costs no read at all.
//
// PREVIEW_MAX is mirrored in firestore.rules (the chat's lastText bound,
// which allows a little more so a trailing "…" always fits).
//
// A link to one of our events says "Shared an event" rather than
// printing a URL nobody can read at that size; any other bare link says
// "Shared a link". `isOurEvent` is passed in so this file keeps no
// imports.
export const PREVIEW_MAX = 90;

export function previewOf(text, { isOurEvent = () => false } = {}) {
  const raw = String(text || "");
  const urls = raw.match(/https?:\/\/[^\s<]+/g) || [];
  const sharedEvent = urls.some((u) => isOurEvent(u));
  let rest = raw;
  urls.forEach((u) => { if (isOurEvent(u)) rest = rest.split(u).join(" "); });
  rest = rest.replace(/\s+/g, " ").trim();

  let out;
  if (sharedEvent) out = rest ? `${rest} · shared an event` : "Shared an event";
  else if (!rest) out = "";
  else if (urls.length === 1 && rest === urls[0]) out = "Shared a link";
  else out = rest;

  if (out.length > PREVIEW_MAX) out = out.slice(0, PREVIEW_MAX - 1).trimEnd() + "…";
  return out;
}
