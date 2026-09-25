// ==========================================
// ACTIVE NOW
// ==========================================
//
// "Active now" under a name, and a green dot on a face in the chats
// list. Built to cost as little as a Firestore feature can, because
// presence is the classic way to burn a read budget: a live listener on
// everybody's status bills one read per heartbeat per person watching.
// So there is NO listener here. Instead:
//
//   YOU  write presence/{uid} = { visible: true, at: serverTimestamp }
//        once when the app opens and then at most every HEARTBEAT_MS
//        while the tab is actually on screen. A hidden tab writes
//        nothing. ~8 writes in a half-hour session.
//
//   THEM are read with a one-off get(), only for people on screen (the
//        top MAX_FETCH conversations in the list, or the one chat you
//        have open), and each answer is kept for CACHE_MS. Opening the
//        inbox five times in two minutes costs the same as once.
//
// Someone counts as active for ACTIVE_MS after their last heartbeat;
// after that it reads "Active 12m ago", up to a day, then nothing.
//
// THE SETTING. "Show when you're active" is `visible` on your own
// presence document. Turned off, the document is rewritten as
// { visible: false } with NO timestamp at all, so there is nothing for
// anyone to read — that half is enforced by what is stored, not by the
// app. The other half, the fair part ("and you won't see theirs"), is
// the app not asking: enforcing it in firestore.rules would mean the
// rule reading your own presence document on every lookup, which
// doubles what presence costs. See docs/data.md.
// ==========================================

import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { msOf, safeId } from '../utils/formatters.js';
import { isBlocked } from './blockService.js';
import { toast } from '../utils/ui.js';

export const ACTIVE_MS = 5 * 60 * 1000;
export const HEARTBEAT_MS = 4 * 60 * 1000;
export const CACHE_MS = 3 * 60 * 1000;
export const MAX_FETCH = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

let visible = true;          // my setting; true until my document says otherwise
let lastBeat = 0;
let timer = 0;
const cache = new Map();     // uid -> { at: ms (0 = hidden / never), fetched: ms }
const inFlight = new Map();
const listeners = [];

/** Repaint hooks — the inbox and the chat header register here. */
export function onPresenceChange(fn) {
  if (typeof fn === "function") listeners.push(fn);
}
function changed() {
  listeners.forEach((fn) => { try { fn(); } catch (e) {} });
}

export function showsActivity() {
  return visible;
}

/** Pure: what to say about a last-seen stamp. */
export function activityLabel(atMs, now = Date.now()) {
  if (!atMs) return { active: false, label: "" };
  const age = Math.max(0, now - atMs);
  if (age < ACTIVE_MS) return { active: true, label: "Active now" };
  if (age >= DAY_MS) return { active: false, label: "" };
  const mins = Math.round(age / 60000);
  if (mins < 60) return { active: false, label: `Active ${mins}m ago` };
  return { active: false, label: `Active ${Math.round(mins / 60)}h ago` };
}

/** What we know about `uid` right now, without asking anybody. */
export function activityOf(uid, now = Date.now()) {
  if (!visible || !uid || isBlocked(uid)) return { active: false, label: "" };
  const hit = cache.get(uid);
  return activityLabel(hit ? hit.at : 0, now);
}

function myRef() {
  return state.uid ? db.collection("presence").doc(state.uid) : null;
}

async function beat(force = false) {
  const ref = myRef();
  if (!ref || !visible) return;
  if (typeof document !== "undefined" && document.hidden) return;
  const now = Date.now();
  if (!force && now - lastBeat < HEARTBEAT_MS - 5000) return;
  lastBeat = now;
  try {
    await ref.set({ visible: true, at: FieldValue.serverTimestamp() });
  } catch (e) {
    lastBeat = 0;   // try again next tick
    console.error("Presence write failed:", e.code || e.message);
  }
}

/** Signed in: learn my setting (one read), then keep my heartbeat. */
export async function startPresence() {
  const ref = myRef();
  if (!ref) return;
  try {
    const doc = await ref.get();
    visible = !doc.exists || (doc.data() || {}).visible !== false;
  } catch (e) {
    visible = true;
  }
  syncActivityUI();
  beat(true);
  clearInterval(timer);
  timer = setInterval(() => { beat(); refreshVisible(); }, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { beat(); refreshVisible(); }
  });
}

export function stopPresence() {
  clearInterval(timer);
  timer = 0;
  cache.clear();
  lastBeat = 0;
}

/**
 * Make sure we know about these people, reading only the ones whose
 * answer is missing or older than CACHE_MS, at most MAX_FETCH of them.
 */
export function primePresence(uids) {
  if (!visible || !state.uid) return Promise.resolve(false);
  const now = Date.now();
  const want = [...new Set(uids || [])]
    .filter((u) => safeId(u) && u !== state.uid && !isBlocked(u))
    .slice(0, MAX_FETCH)
    .filter((u) => {
      const hit = cache.get(u);
      return (!hit || now - hit.fetched > CACHE_MS) && !inFlight.has(u);
    });
  if (!want.length) return Promise.resolve(false);

  const jobs = want.map((u) => {
    const p = db.collection("presence").doc(u).get()
      .then((doc) => {
        const d = doc.exists ? (doc.data() || {}) : {};
        cache.set(u, { at: d.visible === false ? 0 : msOf(d.at), fetched: Date.now() });
      })
      .catch(() => { cache.set(u, { at: 0, fetched: Date.now() }); })
      .finally(() => inFlight.delete(u));
    inFlight.set(u, p);
    return p;
  });
  return Promise.all(jobs).then(() => { changed(); return true; });
}

// Who is on screen right now, registered by the painters so the minute
// tick can keep them current without knowing anything about the DOM.
let visibleProvider = () => [];
export function setPresenceTargets(fn) {
  if (typeof fn === "function") visibleProvider = fn;
}
function refreshVisible() {
  // A tab in the background asks about nobody: nobody is looking.
  if (!visible || (typeof document !== "undefined" && document.hidden)) return;
  primePresence(visibleProvider()).then((fetched) => { if (!fetched) changed(); });
}

/** The Settings switch. Off hides yours AND stops showing theirs. */
export async function setShowActivity(on) {
  const ref = myRef();
  const next = !!on;
  const before = visible;
  visible = next;
  if (!next) cache.clear();
  syncActivityUI();
  changed();
  if (!ref) return;
  try {
    if (next) {
      lastBeat = Date.now();
      await ref.set({ visible: true, at: FieldValue.serverTimestamp() });
      refreshVisible();
    } else {
      await ref.set({ visible: false });
    }
  } catch (e) {
    console.error("Presence setting failed:", e.code || e.message);
    visible = before;
    syncActivityUI();
    changed();
    toast("Couldn't change that. Try again.");
  }
}

export function toggleShowActivity() {
  return setShowActivity(!visible);
}

export function syncActivityUI() {
  const sw = document.getElementById("activitySwitch");
  const label = document.getElementById("activityState");
  if (sw) sw.classList.toggle("on", visible);
  document.getElementById("activityToggle")?.setAttribute("aria-checked", visible ? "true" : "false");
  if (label) {
    label.innerText = visible
      ? "People you chat with can see when you're active"
      : "Hidden — and you won't see anyone else's";
  }
}

/** For tests: forget everything. */
export function __resetPresence() {
  stopPresence();
  visible = true;
  inFlight.clear();
}
