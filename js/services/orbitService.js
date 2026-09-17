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
import { toast, refreshSocialUI } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { stampAsk, msUntilAskAllowed, limitMessage } from './limitsService.js';
import { isFollowing, onUnfollow } from './followService.js';

// Unfollowing someone takes back an orbit request that's still waiting.
// Somebody already in your orbit stays there — that was agreed by both.
onUnfollow((uid) => {
  if (orbitStatus(uid) === "outgoing") removeOrbit(uid, true);
});

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
        if (typeof onOrbitChange === "function") onOrbitChange();
        if (isOrbitOpen()) renderOrbit();

        // Names for the orbit screen, fetched once and then cached.
        // Only the second paint waits on the network.
        primeUsers(linked.concat(incoming, outgoing)).then(() => {
          if (isOrbitOpen()) renderOrbit();
        });
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

/**
 * Who in your orbit is at something live, right now. Read straight out
 * of the event cache the feed already holds, so it costs nothing and
 * updates the moment the feed does.
 *
 * This is the bit that ties Orbit back to what the app is for: a
 * connection here is not a number on a profile, it is a person you
 * might go and find in the next twenty minutes.
 */
export function orbitOutNow() {
  const now = Date.now();
  const out = new Set();
  Object.keys(state.eventCache || {}).forEach((id) => {
    const e = state.eventCache[id];
    if (!e || e.expiresAt <= now || e.startTime > now) return;
    (e.participantUids || []).forEach((u) => {
      if (u !== state.uid && state.orbitUids.includes(u)) out.add(u);
    });
  });
  return [...out];
}

/** How many of the people who vouched for them are in YOUR orbit. */
export function vouchersYouKnow(uid) {
  const u = state.userCache[uid];
  if (!u || !Array.isArray(u.vouchedBy)) return [];
  return u.vouchedBy.filter(
    (v) => v !== state.uid && state.orbitUids.includes(v) && !isBlocked(v)
  );
}

export function vouchCount(uid) {
  const u = state.userCache[uid];
  if (!u) return 0;
  // Same rule as the follower counts: somebody you have blocked does
  // not vouch for anybody, as far as you are concerned.
  if (Array.isArray(u.vouchedBy)) return u.vouchedBy.filter((v) => !isBlocked(v)).length;
  return typeof u.vouchCount === "number" ? u.vouchCount : 0;
}

/* ---------------------------------------------------------------------
   Writing
   ------------------------------------------------------------------- */

/**
 * Put the three lists into a given shape and repaint at once, before
 * the network has said anything.
 *
 * The snapshot listener is the source of truth and will correct this
 * within a moment, but "within a moment" is not the same as "in the
 * frame the finger came up". Without this, tapping Pull in left the
 * button saying Pull in until the round trip landed, which reads as a
 * dead button and gets tapped twice.
 */
function setLocalOrbit(uid, where) {
  state.orbitUids = state.orbitUids.filter((u) => u !== uid);
  state.orbitIncoming = state.orbitIncoming.filter((u) => u !== uid);
  state.orbitOutgoing = state.orbitOutgoing.filter((u) => u !== uid);
  if (where === "linked") state.orbitUids = state.orbitUids.concat([uid]);
  if (where === "incoming") state.orbitIncoming = state.orbitIncoming.concat([uid]);
  if (where === "outgoing") state.orbitOutgoing = state.orbitOutgoing.concat([uid]);

  updateOrbitBadge();
  refreshSocialUI();
  if (isOrbitOpen()) renderOrbit();
}

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
  if (orbitStatus(uid) !== "none") return;        // already asked, or already in

  // Orbit comes after following, for public and private accounts alike.
  // The rules check this too; this just says why instead of failing.
  if (!isFollowing(uid)) return toast("Follow " + displayNameFor(uid) + " first, then pull them into your orbit.");

  const before = orbitStatus(uid);
  setLocalOrbit(uid, "outgoing");

  // Shares a gap with follow requests: asking to follow someone and
  // then pulling them into orbit straight away used to fail the second.
  const gap = msUntilAskAllowed();
  if (gap) await new Promise((r) => setTimeout(r, gap));

  try {
    // Batched with the rate-limit stamp, which the rule checks for.
    const batch = db.batch();
    stampAsk(batch);
    batch.set(db.collection("orbit").doc(pairKey(state.uid, uid)), {
      pair: [state.uid, uid].sort(),
      fromUid: state.uid,
      status: "pending",
      at: Date.now()
    });
    await batch.commit();
    toast("Request sent to " + displayNameFor(uid));
  } catch (e) {
    console.error("Orbit request failed:", e.code || e.message);
    setLocalOrbit(uid, before);
    toast(e.code === "permission-denied" ? limitMessage("ask") : "Couldn't send that request. Try again.");
  }
}

/** Accept — the only edit a pair document ever gets. */
export async function acceptRequest(targetUid) {
  const uid = safeId(targetUid);
  if (!uid) return;

  const before = orbitStatus(uid);
  setLocalOrbit(uid, "linked");

  try {
    await db.collection("orbit").doc(pairKey(state.uid, uid)).update({ status: "linked" });
    toast(displayNameFor(uid) + " is in your orbit");
  } catch (e) {
    console.error("Accept failed:", e.code || e.message);
    setLocalOrbit(uid, before);
    toast("Couldn't accept that. Try again.");
  }
}

/**
 * Decline, withdraw, or leave an orbit. All three are the same delete —
 * there is only ever one document between two people — but they are
 * three different things to the person tapping, so they are told
 * three different things.
 */
export async function removeOrbit(targetUid, quietly) {
  const uid = safeId(targetUid);
  if (!uid) return;

  const before = orbitStatus(uid);
  const said = {
    incoming: "Request ignored",
    outgoing: "Request withdrawn",
    linked: "Removed from your orbit"
  }[before] || "Done";

  setLocalOrbit(uid, "none");

  try {
    await db.collection("orbit").doc(pairKey(state.uid, uid)).delete();
    if (!quietly) toast(said);
  } catch (e) {
    console.error("Orbit remove failed:", e.code || e.message);
    setLocalOrbit(uid, before);
    toast("Couldn't do that right now.");
  }
}

/** Confirmed version, for leaving an orbit you are actually in. */
export async function confirmLeaveOrbit(targetUid) {
  const name = displayNameFor(targetUid);
  const yes = await askConfirm({
    title: "Remove " + name + " from your orbit?",
    body: "They are never told. You can pull them back in later.",
    confirm: "Remove",
    danger: true
  });
  if (yes) removeOrbit(targetUid);
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
    // The feed, search and any open profile — and the Orbit screen
    // itself, which is where the button that was just tapped lives.
    refreshSocialUI();
    if (isOrbitOpen()) renderOrbit();
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

/**
 * The number on the nav. It counts everything waiting on YOU, not just
 * orbit requests — somebody asking to follow a private account is the
 * same kind of thing and belongs behind the same badge, or it goes
 * unnoticed until they happen to open their own profile.
 */
export function updateOrbitBadge() {
  const waiting = state.orbitIncoming.concat(state.followRequests || []);
  const n = waiting.filter((u) => !isBlocked(u)).length;
  document.querySelectorAll(".orbit-badge").forEach((el) => {
    el.innerText = n > 9 ? "9+" : String(n);
    el.classList.toggle("hidden", n === 0);
  });
}

function personRow(uid, kind, outNow) {
  const id = safeId(uid);
  if (!id) return "";

  const isOut = outNow && outNow.includes(uid);

  let actions;
  if (kind === "incoming") {
    actions = `
      <button class="act primary" onclick="event.stopPropagation(); window.acceptOrbit('${id}')">Accept</button>
      <button class="act" onclick="event.stopPropagation(); window.declineOrbit('${id}')">Ignore</button>`;
  } else if (kind === "outgoing") {
    actions = `<button class="act requested" title="Withdraw the request" onclick="event.stopPropagation(); window.declineOrbit('${id}')"><i class='bx bx-time-five'></i><span class="act-label">Asked</span></button>`;
  } else {
    // Both labels collapse to their icon on a narrow screen — two
    // words of housekeeping should not squeeze somebody's name out.
    const vouched = hasVouched(uid);
    actions = `
      <button class="act ${vouched ? "hyped" : ""}" title="${vouched ? "You vouched for them" : "Vouch for them"}" onclick="event.stopPropagation(); window.toggleVouch('${id}')"><i class='bx ${vouched ? "bxs-badge-check" : "bx-badge-check"}'></i><span class="act-label">${vouched ? "Vouched" : "Vouch"}</span></button>
      <button class="act" title="Remove from your orbit" onclick="event.stopPropagation(); window.confirmLeaveOrbit('${id}')"><i class='bx bx-user-minus'></i><span class="act-label">Remove</span></button>`;
  }

  return `
    <div class="orbit-row" onclick="window.openProfileScreen('${id}')">
      <div class="chat-avatar" style="width:44px;height:44px;font-size:19px;">${renderAvatar(avatarFor(uid))}</div>
      <div class="result-text">
        <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
        <div class="result-sub">${isOut
          ? `<span class="out-now"><span class="live-dot"></span> Out right now</span>`
          : "@" + escapeHtml(usernameFor(uid))}</div>
      </div>
      <div class="orbit-row-actions">${actions}</div>
    </div>`;
}

export function renderOrbit() {
  const box = document.getElementById("orbitBody");
  if (!box) return;

  const incoming = state.orbitIncoming.filter((u) => !isBlocked(u));
  const outgoing = state.orbitOutgoing.filter((u) => !isBlocked(u));
  const outNow = orbitOutNow();

  // Anyone who is actually at something comes first — the whole point
  // of the list is deciding where to go next.
  const linked = state.orbitUids
    .filter((u) => !isBlocked(u))
    .sort((a, b) => {
      const d = (outNow.includes(b) ? 1 : 0) - (outNow.includes(a) ? 1 : 0);
      return d || displayNameFor(a).localeCompare(displayNameFor(b));
    });

  // Follow requests are read straight from the store rather than
  // imported, which keeps this module and followService from importing
  // each other in a circle. The handler is already on window.
  const wantToFollow = (state.followRequests || []).filter((u) => !isBlocked(u));

  let html = "";

  if (wantToFollow.length) {
    html += `<h3 class="orbit-heading">Want to follow you <span class="orbit-count">${wantToFollow.length}</span></h3>`;
    html += wantToFollow.map((uid) => {
      const id = safeId(uid);
      if (!id) return "";
      return `
        <div class="orbit-row" onclick="window.openProfileScreen('${id}')">
          <div class="chat-avatar" style="width:44px;height:44px;font-size:19px;">${renderAvatar(avatarFor(uid))}</div>
          <div class="result-text">
            <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
            <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
          </div>
          <div class="orbit-row-actions">
            <button class="act primary" onclick="event.stopPropagation(); window.answerFollowRequest('${id}', true)">Approve</button>
            <button class="act" onclick="event.stopPropagation(); window.answerFollowRequest('${id}', false)">Decline</button>
          </div>
        </div>`;
    }).join("");
  }

  if (incoming.length) {
    html += `<h3 class="orbit-heading">Waiting on you <span class="orbit-count">${incoming.length}</span></h3>`;
    html += incoming.map((u) => personRow(u, "incoming", outNow)).join("");
  }

  if (linked.length) {
    const outCount = linked.filter((u) => outNow.includes(u)).length;
    html += `<h3 class="orbit-heading">In your orbit <span class="orbit-count">${linked.length}</span>${
      outCount ? `<span class="orbit-out-tag"><span class="live-dot"></span> ${outCount} out now</span>` : ""
    }</h3>`;
    html += linked.map((u) => personRow(u, "linked", outNow)).join("");
  }

  if (outgoing.length) {
    html += `<h3 class="orbit-heading">Asked</h3>`;
    html += outgoing.map((u) => personRow(u, "outgoing", outNow)).join("");
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

/** The little system drawn for an empty orbit. */
function orbitArt() {
  return `<svg viewBox="0 0 120 120" width="86" height="86" fill="none" aria-hidden="true">
    <circle cx="60" cy="60" r="52" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
    <circle cx="60" cy="60" r="34" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.5"/>
    <circle cx="60" cy="60" r="9" fill="currentColor" fill-opacity="0.5"/>
    <circle cx="60" cy="8" r="4.5" fill="currentColor" fill-opacity="0.35"/>
    <circle cx="94" cy="60" r="4" fill="currentColor" fill-opacity="0.25"/>
  </svg>`;
}

/* ---------------------------------------------------------------------
   The rings, at any size
   ---------------------------------------------------------------------
   Four people and four hundred have to look right in the same 300px,
   so the system grows in rings rather than in radius: each ring holds
   roughly as many faces as its circumference allows, and once five
   rings are full the rest become a "+N" in the middle. Faces shrink
   and fade as they go outwards, which reads as depth rather than as
   clutter, and every ring turns at its own speed in the opposite
   direction to its neighbour.
   ------------------------------------------------------------------- */

// Faces a ring can hold, innermost first — roughly its circumference
// divided by a face, so nothing ever overlaps its neighbour.
//
// Three rings, not five. Seventy faces was technically fine and
// visually a mess: past about twenty there is no reading it, just
// texture. Everyone beyond the third ring becomes a "+N" on your own
// avatar, which is both calmer and a good deal cheaper, since every
// face on screen is one more running animation.
const RING_CAPS = [5, 8, 11];
const RING_FACE = [36, 31, 27];           // px, shrinking outwards
const RING_SPIN = [30, 42, 58];           // seconds — outer rings drift
const MAX_SHOWN = RING_CAPS.reduce((a, b) => a + b, 0);

// Where the rings sit for each possible ring count, so two rings are
// spaced like two rings rather than like the first and last of three.
const RING_LAYOUT = [
  [124],
  [112, 206],
  [104, 180, 256]
];

/**
 * Weak phones get the same picture, standing still.
 *
 * Even three rings means a dozen-odd elements each running their own
 * infinite transform. That is cheap on anything recent — but "cheap on
 * anything recent" is exactly the assumption that makes an app feel
 * broken on the ₹8,000 phone half a campus actually owns. So on a
 * device reporting few cores or little memory, and for anyone who has
 * asked their system for less motion, the orbit is laid out exactly
 * the same way and simply does not turn. Nothing is lost: it was never
 * the spinning that carried the meaning.
 */
const WEAK_DEVICE = (() => {
  try {
    const cores = navigator.hardwareConcurrency || 8;
    const memory = navigator.deviceMemory || 4;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reduced || cores <= 4 || memory <= 2;
  } catch (e) {
    return false;
  }
})();


/**
 * Spread `n` faces over `k` rings in proportion to what each ring can
 * hold. Filling greedily instead would leave the outermost ring with
 * three faces rattling around it while the inner one is packed.
 */
function spreadOverRings(n, k) {
  const caps = RING_CAPS.slice(0, k);
  const room = caps.reduce((a, b) => a + b, 0);
  const counts = caps.map((cap) => Math.floor((n * cap) / room));
  let left = n - counts.reduce((a, b) => a + b, 0);
  // Remainders go outwards, where there is the most room for them.
  for (let i = counts.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(left, caps[i] - counts[i]);
    counts[i] += take;
    left -= take;
  }
  return counts;
}

/**
 * Render the orbit around `hostEl`. People who are out right now are
 * placed first, so they land on the innermost, largest, brightest ring.
 */
export function renderOrbitRings(hostEl, uids, total) {
  if (!hostEl) return;

  const outNow = orbitOutNow();
  const people = (uids || [])
    .filter((u) => !isBlocked(u))
    .sort((a, b) => (outNow.includes(b) ? 1 : 0) - (outNow.includes(a) ? 1 : 0));

  // The rings are rebuilt from scratch, which restarts every rotation
  // from zero. That is fine once; doing it on every repaint made the
  // whole system visibly jump back to its start position each time
  // somebody was followed. Rebuild only when the people really changed.
  const signature = people.join(",") + "|" + outNow.join(",") + "|" + total;
  // ...but only if what it drew is still there. Opening somebody else's
  // profile empties this element, and the signature alone did not know
  // that — so coming back to your own profile matched the signature,
  // returned early, and left the orbit blank until a reload.
  if (hostEl.dataset.signature === signature && hostEl.children.length) return;
  hostEl.dataset.signature = signature;

  if (!people.length) {
    hostEl.innerHTML = "";
    hostEl.classList.add("hidden");
    return;
  }

  hostEl.classList.remove("hidden");

  const shown = people.slice(0, MAX_SHOWN);
  const hidden = people.length - shown.length;

  // Open only as many rings as the orbit actually needs, then fill them
  // evenly rather than packing the inner one and stranding the outer.
  let ringCount = 1;
  let room = RING_CAPS[0];
  while (room < shown.length && ringCount < RING_CAPS.length) {
    room += RING_CAPS[ringCount];
    ringCount++;
  }

  const counts = spreadOverRings(shown.length, ringCount);
  const layout = RING_LAYOUT[ringCount - 1];
  const rings = [];
  let cursor = 0;
  counts.forEach((c) => { rings.push(shown.slice(cursor, cursor + c)); cursor += c; });

  // A single ring does not need the room three rings need, and an
  // almost-empty 300px square under a small orbit just looks broken.
  const BOX = rings.length === 1 ? 200 : 300;

  const html = rings.filter((list) => list.length).map((list, i) => {
    const diameter = layout[i];
    const size = RING_FACE[i];
    const spin = RING_SPIN[i];
    const dir = i % 2 === 0 ? "cw" : "ccw";
    const fade = (0.42 - i * 0.06).toFixed(2);
    const slotStep = 360 / list.length;

    const faces = list.map((u, n) => {
      const id = safeId(u);
      // Only the innermost ring pulses. Six green rings blinking at
      // once stops reading as "these people are out" and starts
      // reading as decoration.
      const out = outNow.includes(u) && i === 0;
      return `
        <span class="orbit-slot" style="--a:${(n * slotStep).toFixed(1)}deg">
          <span class="orbit-face${out ? " is-out" : ""}"
                style="--s:${size}"
                title="${escapeHtml(displayNameFor(u))}"
                ${id ? `onclick="event.stopPropagation(); window.openProfileScreen('${id}')"` : ""}>
            ${renderAvatar(avatarFor(u))}
          </span>
        </span>`;
    }).join("");

    return `<span class="orbit-ring ${dir}" style="--d:${diameter}; --dur:${spin}s; --fade:${fade}">${faces}</span>`;
  }).join("");

  const outCount = outNow.length;
  const count = typeof total === "number" ? total : people.length;

  hostEl.innerHTML = `
    <div class="orbit-system${WEAK_DEVICE ? " still" : ""}" style="--box:${BOX}">
      <button class="orbit-core" onclick="window.openOrbitScreen()" title="Open your orbit">
        ${renderAvatar(state.userAvatar)}
        ${hidden ? `<span class="orbit-more">+${hidden}</span>` : ""}
      </button>
      ${html}
    </div>
    <div class="orbit-system-label">
      <b>${count}</b> ${count === 1 ? "person" : "people"} in your orbit${
        outCount ? ` · <span class="out-now"><span class="live-dot"></span> ${outCount} out right now</span>` : ""
      }
    </div>`;
}
