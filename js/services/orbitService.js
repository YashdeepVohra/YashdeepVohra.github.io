// ==========================================
// ORBIT — connections, and the vouches on top of them
// ==========================================
//
// WHY NOT FOLLOWERS
// -----------------
// A follow graph is about watching people. This app is about deciding
// whether to walk across campus for something, so a connection here
// means "I'd show up for this person" — mutual, deliberate, and small.
//
// THE SHAPE
// ---------
// One document per pair, at `orbit/{uidA_uidB}` with the uids sorted —
// the same shape as a block and a direct chat id:
//
//   { pair: [a, b], fromUid, status: 'pending' | 'linked', at }
//
// The request and the connection are the SAME document, so they cannot
// disagree. There is no "A asked B" row to reconcile with a "B accepted
// A" row, nobody can end up half-connected, and withdrawing a request
// and leaving an orbit are the same delete.
//
// It also means one query — `pair array-contains me` — returns your
// whole orbit AND every request waiting on you, in a single listener.
// That is one billed read per connection, once, and then nothing until
// something actually changes.
//
// VOUCHES
// -------
// A vouch is a public "I actually know this person", stored as your uid
// in their `users/{uid}.vouchedBy` array. You can only vouch for people
// already in your orbit, which is what keeps it from becoming a number
// anyone can farm. On an event card it answers the question the app
// really raises: should I go to a stranger's thing? "Vouched by 3
// people you know" is a much better answer than a follower count.
// ==========================================

import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId, escapeHtml, renderAvatar } from '../utils/formatters.js';
import { pairKey, isBlocked } from './blockService.js';
import { fetchUser, primeUsers, displayNameFor, usernameFor, avatarFor } from './userService.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { toast } from '../utils/ui.js';

const MAX_VOUCHES = 500;

/** Re-render whatever is on screen when the orbit changes. */
let onOrbitChange = null;

/* ---------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------- */

/**
 * One listener for the whole feature. Splits every pair document into
 * the three lists the UI actually asks about.
 */
export function loadOrbit(onChange) {
  if (typeof onChange === "function") onOrbitChange = onChange;
  if (state.orbitUnsubscribe) state.orbitUnsubscribe();

  state.orbitUnsubscribe = db
    .collection("orbit")
    .where("pair", "array-contains", state.uid)
    .onSnapshot(
      (snapshot) => {
        const linked = [];
        const incoming = [];
        const outgoing = [];

        snapshot.forEach((doc) => {
          const d = doc.data() || {};
          const other = (d.pair || []).find((u) => u !== state.uid);
          if (!other) return;
          if (d.status === "linked") linked.push(other);
          else if (d.fromUid === state.uid) outgoing.push(other);
          else incoming.push(other);
        });

        state.orbitUids = linked;
        state.orbitIncoming = incoming;
        state.orbitOutgoing = outgoing;

        updateOrbitBadge();
        // Names for the orbit screen, fetched once and then cached.
        primeUsers(linked.concat(incoming, outgoing)).then(() => {
          if (isOrbitOpen()) renderOrbit();
        });

        if (typeof onOrbitChange === "function") onOrbitChange();
        if (isOrbitOpen()) renderOrbit();
      },
      (error) => console.error("Orbit error:", error.code || error.message)
    );
}

/** Where you stand with someone, in one word. */
export function orbitStatus(uid) {
  if (!uid || uid === state.uid) return "self";
  if (state.orbitUids.includes(uid)) return "linked";
  if (state.orbitIncoming.includes(uid)) return "incoming";
  if (state.orbitOutgoing.includes(uid)) return "outgoing";
  return "none";
}

export function inOrbit(uid) {
  return state.orbitUids.includes(uid);
}

/** Have I vouched for them? Read from the cached profile, never the network. */
export function hasVouched(uid) {
  const u = state.userCache[uid];
  return !!(u && Array.isArray(u.vouchedBy) && u.vouchedBy.includes(state.uid));
}

/** How many of the people who vouched for them are in YOUR orbit. */
export function vouchersYouKnow(uid) {
  const u = state.userCache[uid];
  if (!u || !Array.isArray(u.vouchedBy)) return [];
  return u.vouchedBy.filter((v) => v !== state.uid && state.orbitUids.includes(v));
}

export function vouchCount(uid) {
  const u = state.userCache[uid];
  if (!u) return 0;
  if (typeof u.vouchCount === "number") return u.vouchCount;
  return Array.isArray(u.vouchedBy) ? u.vouchedBy.length : 0;
}

/* ---------------------------------------------------------------------
   Writing
   ------------------------------------------------------------------- */

/**
 * Ask someone to join your orbit. The document id is derived from the
 * two uids, so sending the same request twice is the same write, not a
 * duplicate — and if THEY already asked you, this accepts instead.
 */
export async function pullIn(targetUid) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  if (isBlocked(uid)) return toast("You can't do that with someone you've blocked.");

  if (orbitStatus(uid) === "incoming") return acceptRequest(uid);

  const pair = [state.uid, uid].sort();
  try {
    await db.collection("orbit").doc(pairKey(state.uid, uid)).set({
      pair,
      fromUid: state.uid,
      status: "pending",
      at: Date.now()
    });
    toast("Request sent to " + displayNameFor(uid));
  } catch (e) {
    console.error("Orbit request failed:", e.code || e.message);
    toast("Couldn't send that request. Try again.");
  }
}

/** Accept — the only edit a pair document ever gets. */
export async function acceptRequest(targetUid) {
  const uid = safeId(targetUid);
  if (!uid) return;
  try {
    await db.collection("orbit").doc(pairKey(state.uid, uid)).update({ status: "linked" });
    toast(displayNameFor(uid) + " is in your orbit");
  } catch (e) {
    console.error("Accept failed:", e.code || e.message);
    toast("Couldn't accept that. Try again.");
  }
}

/**
 * Decline, withdraw, or leave an orbit. All three are the same delete —
 * there is only ever one document between two people.
 */
export async function removeOrbit(targetUid, quietly) {
  const uid = safeId(targetUid);
  if (!uid) return;
  try {
    await db.collection("orbit").doc(pairKey(state.uid, uid)).delete();
    if (!quietly) toast("Done");
  } catch (e) {
    console.error("Orbit remove failed:", e.code || e.message);
    toast("Couldn't do that right now.");
  }
}

/** Confirmed version, for leaving an orbit you are actually in. */
export function confirmLeaveOrbit(targetUid) {
  const name = displayNameFor(targetUid);
  if (!window.confirm("Remove " + name + " from your orbit?\n\nThey are not told. You can pull them back in later.")) return;
  removeOrbit(targetUid);
}

/**
 * Vouch for someone in your orbit. Writes your uid into THEIR profile,
 * which the rules allow only for this one field, only for yourself, and
 * only when the two of you are already linked.
 */
export async function toggleVouch(targetUid) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  if (!inOrbit(uid)) return toast("You can vouch for people in your orbit.");

  const on = hasVouched(uid);
  const current = state.userCache[uid] && Array.isArray(state.userCache[uid].vouchedBy)
    ? state.userCache[uid].vouchedBy
    : [];
  if (!on && current.length >= MAX_VOUCHES) return toast("This profile has all the vouches it can hold.");

  try {
    await db.collection("users").doc(uid).update({
      vouchedBy: on ? FieldValue.arrayRemove(state.uid) : FieldValue.arrayUnion(state.uid)
    });
    // Re-read so the count and the button agree straight away.
    await fetchUser(uid, { force: true });
    toast(on ? "Vouch removed" : "You vouched for " + displayNameFor(uid));
    if (typeof onOrbitChange === "function") onOrbitChange();
  } catch (e) {
    console.error("Vouch failed:", e.code || e.message);
    toast("Couldn't save that vouch.");
  }
}

/* ---------------------------------------------------------------------
   The Orbit screen
   ------------------------------------------------------------------- */

function isOrbitOpen() {
  const el = document.getElementById("orbitScreen");
  return !!el && !el.classList.contains("hidden");
}

export function openOrbitScreen() {
  openOverlay("orbitScreen");
  primeUsers(state.orbitUids.concat(state.orbitIncoming, state.orbitOutgoing))
    .then(() => { if (isOrbitOpen()) renderOrbit(); });
  renderOrbit();
}

export function closeOrbitScreen() {
  closeOverlay("orbitScreen");
}

/** The number on the nav, so a request waiting on you is never missed. */
export function updateOrbitBadge() {
  const n = state.orbitIncoming.filter((u) => !isBlocked(u)).length;
  document.querySelectorAll(".orbit-badge").forEach((el) => {
    el.innerText = n > 9 ? "9+" : String(n);
    el.classList.toggle("hidden", n === 0);
  });
}

function personRow(uid, kind) {
  const id = safeId(uid);
  if (!id) return "";

  let actions;
  if (kind === "incoming") {
    actions = `
      <button class="act primary" onclick="event.stopPropagation(); window.acceptOrbit('${id}')">Accept</button>
      <button class="act" onclick="event.stopPropagation(); window.declineOrbit('${id}')">Ignore</button>`;
  } else if (kind === "outgoing") {
    actions = `<button class="act requested" onclick="event.stopPropagation(); window.declineOrbit('${id}')"><i class='bx bx-time-five'></i> Asked</button>`;
  } else {
    const vouched = hasVouched(uid);
    actions = `
      <button class="act ${vouched ? "hyped" : ""}" onclick="event.stopPropagation(); window.toggleVouch('${id}')"><i class='bx ${vouched ? "bxs-badge-check" : "bx-badge-check"}'></i> ${vouched ? "Vouched" : "Vouch"}</button>
      <button class="act" onclick="event.stopPropagation(); window.confirmLeaveOrbit('${id}')">Remove</button>`;
  }

  return `
    <div class="orbit-row" onclick="window.openProfileScreen('${id}')">
      <div class="chat-avatar" style="width:44px;height:44px;font-size:19px;">${renderAvatar(avatarFor(uid))}</div>
      <div class="result-text">
        <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
        <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
      </div>
      <div class="orbit-row-actions">${actions}</div>
    </div>`;
}

export function renderOrbit() {
  const box = document.getElementById("orbitBody");
  if (!box) return;

  const incoming = state.orbitIncoming.filter((u) => !isBlocked(u));
  const outgoing = state.orbitOutgoing.filter((u) => !isBlocked(u));
  const linked = state.orbitUids.filter((u) => !isBlocked(u));

  let html = "";

  if (incoming.length) {
    html += `<h3 class="orbit-heading">Waiting on you <span class="orbit-count">${incoming.length}</span></h3>`;
    html += incoming.map((u) => personRow(u, "incoming")).join("");
  }

  if (linked.length) {
    html += `<h3 class="orbit-heading">In your orbit <span class="orbit-count">${linked.length}</span></h3>`;
    html += linked.map((u) => personRow(u, "linked")).join("");
  }

  if (outgoing.length) {
    html += `<h3 class="orbit-heading">Asked</h3>`;
    html += outgoing.map((u) => personRow(u, "outgoing")).join("");
  }

  if (!html) {
    html = `
      <div class="empty-state">
        <div class="orbit-empty-art">${orbitArt()}</div>
        <h4>Your orbit is empty</h4>
        <p>Search someone's handle and pull them in. People in your orbit show up on their events, so you know who's really behind a plan.</p>
        <button class="btn-ghost" onclick="window.closeOrbitScreen(); window.openSearch();"><i class='bx bx-search'></i> Find people</button>
      </div>`;
  }

  box.innerHTML = html;
}

/* ---------------------------------------------------------------------
   The visual: you, with everyone else going round you
   ---------------------------------------------------------------------
   Three rings, one rotation each, all of it transform-only so it runs
   on the compositor and never touches layout or paint. The avatars
   counter-rotate at the same speed so faces stay upright.
   ------------------------------------------------------------------- */

function orbitArt() {
  return `<svg viewBox="0 0 120 120" width="86" height="86" fill="none" aria-hidden="true">
    <circle cx="60" cy="60" r="52" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
    <circle cx="60" cy="60" r="34" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.5"/>
    <circle cx="60" cy="60" r="9" fill="currentColor" fill-opacity="0.5"/>
    <circle cx="60" cy="8" r="4.5" fill="currentColor" fill-opacity="0.35"/>
    <circle cx="94" cy="60" r="4" fill="currentColor" fill-opacity="0.25"/>
  </svg>`;
}

/** Render the rings on a profile. `uids` is who to show, closest first. */
export function renderOrbitRings(hostEl, uids, total) {
  if (!hostEl) return;

  const people = (uids || []).filter((u) => !isBlocked(u)).slice(0, 8);
  if (!people.length) {
    hostEl.innerHTML = "";
    hostEl.classList.add("hidden");
    return;
  }
  hostEl.classList.remove("hidden");

  // Two rings: up to three close in, the rest further out.
  const inner = people.slice(0, 3);
  const outer = people.slice(3);

  const ring = (list, cls) => {
    if (!list.length) return "";
    const step = 360 / list.length;
    const faces = list.map((u, i) => `
      <span class="orbit-slot" style="--a:${(i * step).toFixed(1)}deg">
        <span class="orbit-face" title="${escapeHtml(displayNameFor(u))}">${renderAvatar(avatarFor(u))}</span>
      </span>`).join("");
    return `<span class="orbit-ring ${cls}">${faces}</span>`;
  };

  hostEl.innerHTML = `
    <div class="orbit-system">
      <span class="orbit-core">${renderAvatar(state.userAvatar)}</span>
      ${ring(inner, "ring-in")}
      ${ring(outer, "ring-out")}
    </div>
    <div class="orbit-system-label">${total} ${total === 1 ? "person" : "people"} in your orbit</div>`;
}
