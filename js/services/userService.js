// ==========================================
// USER LOOKUPS & PROFILE CACHE (UID-KEYED)
// ==========================================
//
// One doc per person: users/{uid}. The handle lives in a separate
// lookup collection: usernames/{handle} -> { uid }.
//
// Nothing in the app resolves a person by username except the one
// "start a chat with @handle" search box, which goes through
// resolveUsernameToUid() below.
// ==========================================

import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId } from '../utils/formatters.js';

const PLACEHOLDER = { username: "student", displayName: "Student", avatar: "\u{1F464}" };

/** Normalise a typed handle to its canonical stored form. */
export function normalizeUsername(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

/** Fetch and cache one user profile by uid. */
export async function fetchUser(uid, { force = false } = {}) {
  if (!safeId(uid)) return { ...PLACEHOLDER };
  if (!force && state.userCache[uid]) return state.userCache[uid];

  try {
    const doc = await db.collection("users").doc(uid).get();
    state.userCache[uid] = doc.exists
      ? { uid, ...doc.data() }
      : { uid, ...PLACEHOLDER };
  } catch (e) {
    console.error("User lookup failed:", uid, e.code || e.message);
    state.userCache[uid] = { uid, ...PLACEHOLDER };
  }
  return state.userCache[uid];
}

/** Warm the cache for a batch of uids, skipping any already present. */
export async function primeUsers(uids) {
  const missing = [...new Set(uids)].filter((u) => safeId(u) && !state.userCache[u]);
  await Promise.all(missing.map((u) => fetchUser(u)));
}

/** Handle -> uid. Returns "" when the handle is unclaimed. */
export async function resolveUsernameToUid(rawUsername) {
  const handle = normalizeUsername(rawUsername);
  if (handle.length < 3) return "";
  try {
    const doc = await db.collection("usernames").doc(handle).get();
    return doc.exists ? (doc.data().uid || "") : "";
  } catch (e) {
    console.error("Handle lookup failed:", e.code || e.message);
    return "";
  }
}

// ---- Cache readers (never hit the network) ----
export function displayNameFor(uid) {
  const u = state.userCache[uid];
  return (u && (u.displayName || u.username)) || "Student";
}

export function usernameFor(uid) {
  const u = state.userCache[uid];
  return (u && u.username) || "student";
}

export function avatarFor(uid) {
  const u = state.userCache[uid];
  return (u && u.avatar) || "\u{1F464}";
}

/**
 * Deterministic chat id for a pair of users: both sides compute the
 * same string, and the id itself proves membership to the rules.
 */
export function directChatId(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}
