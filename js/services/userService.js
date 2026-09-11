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
//
// WHY THERE IS A localStorage LAYER
// ---------------------------------
// Names and avatars are the most-read documents in the app: every
// event card, every chat row, every message bubble needs one. In a
// normal session the feed alone touches ~20 different people, and
// before this cache existed that was ~20 billed reads every single
// time the app was opened — for data that changes maybe twice a year.
//
// So profiles are written to localStorage with a timestamp and read
// back on the next open. Inside the TTL they cost nothing at all.
// Past it, the stale copy still paints instantly and a single refresh
// happens in the background, so the user never waits on the network
// for someone's name. Anything that must be current — opening a full
// profile screen — passes { force: true } and always hits the server.
// ==========================================

import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId } from '../utils/formatters.js';

const PLACEHOLDER = { username: "student", displayName: "Student", avatar: "\u{1F464}" };

const STORE_KEY = "livesociya.profiles.v1";
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;   // re-check a face twice a day, not twice a minute
const MAX_CACHED = 400;                       // keeps the entry well under the 5MB storage budget

// uid -> timestamp the copy in state.userCache was last read from the server.
const freshness = Object.create(null);
// uids we are already refreshing, so a busy feed does not fire the same read twice.
const inFlight = new Set();

/** localStorage is allowed to be missing, full, or locked down. Never throw. */
function readStore() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeStore(store) {
  try {
    const uids = Object.keys(store);
    if (uids.length > MAX_CACHED) {
      // Drop the least recently refreshed entries first.
      uids.sort((a, b) => (store[b].at || 0) - (store[a].at || 0))
          .slice(MAX_CACHED)
          .forEach((uid) => { delete store[uid]; });
    }
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    // Quota or private mode. The app works fine, it just pays for reads.
  }
}

/**
 * Persist one profile so the next session can paint it for free.
 * Called with data we know is authoritative, so it also counts as
 * "just refreshed" and keeps the background revalidation quiet.
 */
export function rememberUser(uid, data) {
  if (!safeId(uid) || !data) return;
  freshness[uid] = Date.now();
  const store = readStore();
  store[uid] = {
    at: Date.now(),
    u: {
      username: data.username || "",
      displayName: data.displayName || "",
      avatar: data.avatar || ""
    }
  };
  writeStore(store);
}

/**
 * Pull the saved profiles into the in-memory cache. Called once the
 * user is signed in, because signing out wipes state.userCache.
 */
export function hydrateProfileCache() {
  const store = readStore();
  const now = Date.now();
  Object.keys(store).forEach((uid) => {
    const entry = store[uid];
    if (!entry || !entry.u) return;
    state.userCache[uid] = { uid, ...PLACEHOLDER, ...entry.u };
    freshness[uid] = entry.at || 0;
    // A stale entry still paints instantly; fetchUser will refresh it.
    if (now - (entry.at || 0) > PROFILE_TTL_MS) freshness[uid] = 0;
  });
}

/** Forget everything we saved — used when the session ends. */
export function clearProfileCache() {
  try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
  Object.keys(freshness).forEach((uid) => { delete freshness[uid]; });
  inFlight.clear();
}

/** Normalise a typed handle to its canonical stored form. */
export function normalizeUsername(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

/** The one place that actually spends a read. */
async function readFromServer(uid) {
  const doc = await db.collection("users").doc(uid).get();
  const data = doc.exists ? { uid, ...doc.data() } : { uid, ...PLACEHOLDER };
  state.userCache[uid] = data;
  freshness[uid] = Date.now();
  if (doc.exists) rememberUser(uid, data);
  return data;
}

/** Fetch and cache one user profile by uid. */
export async function fetchUser(uid, { force = false } = {}) {
  if (!safeId(uid)) return { ...PLACEHOLDER };

  const cached = state.userCache[uid];
  if (!force && cached) {
    const age = Date.now() - (freshness[uid] || 0);
    if (age > PROFILE_TTL_MS && !inFlight.has(uid)) {
      // Stale-while-revalidate: hand back what we have, quietly catch up.
      inFlight.add(uid);
      readFromServer(uid)
        .catch(() => {})
        .finally(() => inFlight.delete(uid));
    }
    return cached;
  }

  try {
    return await readFromServer(uid);
  } catch (e) {
    console.error("User lookup failed:", uid, e.code || e.message);
    if (cached) return cached;              // offline: better a stale name than "Student"
    state.userCache[uid] = { uid, ...PLACEHOLDER };
    return state.userCache[uid];
  }
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
