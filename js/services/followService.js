// ==========================================
// FOLLOWING — the light, public half of the graph
// ==========================================
//
// Orbit is the deliberate, mutual tier: the people you'd actually show
// up for. Following is the cheap one — one tap, no permission asked,
// one way — and it exists mainly so a profile carries a number that
// means something to a stranger.
//
// WHY THE COUNTS LIVE IN ARRAYS ON THE PROFILE
// -------------------------------------------
// A follow writes the follower's uid into the TARGET's `followers`
// array, and the rules let a non-owner write that one field and only
// with their own uid. The owner of a profile cannot touch it at all.
// So `followers.length` is a number that could only have been earned
// one real account at a time — you cannot inflate your own.
//
// It is also free to read. It arrives with the profile document the
// app already fetches and caches, so showing a follower count costs
// zero extra reads, where a `followers` subcollection would have cost
// one read per follower every time somebody opened a profile.
//
// The honest caveat: `following` is your own list on your own
// document, so a determined person could add uids they do not really
// follow. That is why the FOLLOWER count is the one used as a signal
// anywhere it matters, and the following count is just context.
//
// PRIVATE ACCOUNTS
// ----------------
// With `private: true`, a follow does not land in `followers` at all —
// the rules forbid it — it lands in `followRequests`, and only the
// owner can move a name from that queue into their followers. One name
// at a time, and only a name that actually asked.
//
// What that does and does not mean is worth being straight about. It
// decides who is in your follower list, and it is enforced by the
// database rather than by the app. It does NOT hide your events: the
// campus feed is public by design, which was the deliberate choice
// made when private events were left out. Hiding those needs a second
// feed listener and an allow list on every event.
// ==========================================

import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId, escapeHtml, renderAvatar } from '../utils/formatters.js';
import { isBlocked } from './blockService.js';
import {
  fetchUser, refreshUser, onUserFetched, primeUsers, displayNameFor, usernameFor, avatarFor
} from './userService.js';
import { toast, refreshSocialUI } from '../utils/ui.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { askConfirm } from '../utils/confirm.js';
import { stampAsk, limitMessage, msUntilAskAllowed, ASK_GAP_MS } from './limitsService.js';

/**
 * A live view of your own profile document.
 *
 * Follow requests land in YOUR document, written by somebody else, so
 * without a listener the first you would know of one is the next time
 * the app was opened from cold. This is one read to start and one per
 * change after that, and it keeps the follower count, the following
 * list and the private switch honest across two devices at once.
 */
export function loadMyProfile(onChange) {
  if (state.myProfileUnsubscribe) state.myProfileUnsubscribe();

  state.myProfileUnsubscribe = db.collection("users").doc(state.uid).onSnapshot(
    (doc) => {
      const d = doc.data() || {};
      state.following = Array.isArray(d.following) ? d.following : [];
      state.followRequests = Array.isArray(d.followRequests) ? d.followRequests : [];
      state.isPrivate = d.private === true;
      state.privacyChosen = typeof d.private === "boolean";
      if (state.userCache[state.uid]) Object.assign(state.userCache[state.uid], d);
      syncPrivacyUI();
      if (typeof onChange === "function") onChange();
      resolvePendingAsks();
    },
    (error) => console.error("Own profile listener:", error.code || error.message)
  );
}

/** Am I following them? Read from my own list, never the network. */
export function isFollowing(uid) {
  return !!uid && state.following.includes(uid);
}

/** Does this account approve its followers? */
export function isPrivateAccount(uid) {
  if (uid === state.uid) return state.isPrivate === true;
  const u = state.userCache[uid];
  return !!(u && u.private === true);
}

/** Have I already asked to follow them? */
export function hasAskedToFollow(uid) {
  const u = state.userCache[uid];
  return !!(u && Array.isArray(u.followRequests) && u.followRequests.includes(state.uid));
}

/** People waiting on ME to let them follow. */
export function myFollowRequests() {
  return (state.followRequests || []).filter((u) => u && !isBlocked(u));
}

/**
 * Blocking is total everywhere else in the app — their events are gone,
 * their messages are gone, they are filtered out of every list. The
 * numbers above those lists were the one place they lingered, so
 * following somebody and then blocking them left a count that did not
 * match the list underneath it.
 *
 * Only the array can be filtered. The stored number is a fallback for a
 * profile whose full document has not been read this session, and by
 * the time anybody is looking at a count the profile has been read.
 */
function countOf(list, fallback) {
  if (Array.isArray(list)) return list.filter((u) => !isBlocked(u)).length;
  return typeof fallback === "number" ? fallback : 0;
}

export function followerCount(uid) {
  const u = state.userCache[uid];
  if (!u) return 0;
  return countOf(u.followers, u.followerCount);
}

export function followingCount(uid) {
  if (uid === state.uid) return countOf(state.following);
  const u = state.userCache[uid];
  if (!u) return 0;
  return countOf(u.following, u.followingCount);
}

/**
 * Move a cached follower count by one, so the number on screen changes
 * in the same frame as the button. Without this the button said
 * "Following" while the count still read the old value until the round
 * trip came back — which on a slow campus connection looks broken.
 */
function nudgeFollowers(uid, delta) {
  const u = state.userCache[uid];
  if (!u) return;
  if (Array.isArray(u.followers)) {
    u.followers = delta > 0
      ? u.followers.concat([state.uid])
      : u.followers.filter((x) => x !== state.uid);
  }
  if (typeof u.followerCount === "number") {
    u.followerCount = Math.max(0, u.followerCount + delta);
  }
}

/* ---------------------------------------------------------------------
   FOLLOW, ASK, UNFOLLOW, WITHDRAW
   ---------------------------------------------------------------------
   This used to decide between "follow" and "ask" from whatever copy of
   the profile happened to be cached — and the saved copy never had the
   `private` flag or the request queue in it. So after a reload:

     - a private account looked open, the button said Follow, and the
       app tried to follow it directly;
     - every request you had sent looked cancelled, because nothing
       said you were in the queue;
     - two taps in a row could fire two opposite writes.

   Now a NEW follow always asks the server first (one read — follows are
   rare, and getting it wrong is worse), and decides from that. The
   button still moves the moment it is tapped; the read happens behind
   it and corrects it if the guess was wrong. Anything that takes a
   relationship AWAY on a private account asks before doing it, because
   getting back in means asking again.
   ------------------------------------------------------------------- */

// uids with a follow action in flight. A second tap waits its turn
// rather than racing the first one to the database.
const busy = new Set();

const arr = (v) => (Array.isArray(v) ? v : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Move my own uid in or out of somebody's request queue. */
function nudgeRequests(uid, joining) {
  const u = state.userCache[uid];
  if (!u) return;
  const list = arr(u.followRequests).filter((x) => x !== state.uid);
  u.followRequests = joining ? list.concat([state.uid]) : list;
}

function paint(onDone) {
  if (typeof onDone === "function") onDone();
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();
}

function setFollowingLocal(uid, on) {
  const has = state.following.includes(uid);
  if (on && !has) state.following = state.following.concat([uid]);
  if (!on && has) state.following = state.following.filter((u) => u !== uid);
}

/* ---- Requests you have sent, remembered on this device -------------
   Approving a request writes the owner's `followers`; only YOU can
   write your own `following`, and nothing told your app it had
   happened. So an approved request left you following someone whose
   profile still offered "Ask to follow", and a following count one
   short. The asks you're waiting on are kept here and checked on the
   next launch, and any fresh read of a profile heals it too.        */

const ASKS_KEY = () => "livesociya.asks." + state.uid;

function readAsks() {
  try {
    const v = JSON.parse(window.localStorage.getItem(ASKS_KEY()) || "[]");
    return Array.isArray(v) ? v.filter((u) => safeId(u)) : [];
  } catch (e) { return []; }
}
function writeAsks(list) {
  try { window.localStorage.setItem(ASKS_KEY(), JSON.stringify([...new Set(list)].slice(-50))); } catch (e) {}
}
function rememberAsk(uid, on) {
  const list = readAsks().filter((u) => u !== uid);
  writeAsks(on ? list.concat([uid]) : list);
}

/** Once per launch: find out what happened to the asks still out. */
let asksResolvedFor = "";
export async function resolvePendingAsks() {
  if (!state.uid || asksResolvedFor === state.uid) return;
  asksResolvedFor = state.uid;
  const pending = readAsks().slice(-15);
  for (const uid of pending) {
    try { await refreshUser(uid); } catch (e) { /* offline: try next launch */ }
  }
}

// Every fresh profile read passes through here. If it shows you in
// their followers but not in your own following, a request was
// approved — finish it. If it shows the reverse, a follow only half
// landed once — undo your half, so the button tells the truth.
const healing = new Set();
onUserFetched((uid, data, { fromCache }) => {
  if (fromCache || !state.uid || uid === state.uid || busy.has(uid) || healing.has(uid)) return;

  const inTheirs = arr(data.followers).includes(state.uid);
  const inMine = state.following.includes(uid);
  if (!arr(data.followRequests).includes(state.uid)) rememberAsk(uid, false);
  if (inTheirs === inMine || isBlocked(uid)) return;

  healing.add(uid);
  setFollowingLocal(uid, inTheirs);
  refreshSocialUI();
  db.collection("users").doc(state.uid)
    .update({ following: inTheirs ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid) })
    .catch((e) => console.warn("Follow repair failed:", e.code || e.message))
    .finally(() => healing.delete(uid));
});

/* ---- Rate limit, the polite way -------------------------------------
   The rules allow one ask every few seconds (follow requests and orbit
   requests share it). Asking two people back to back used to fail the
   second one outright, and roll its button back — which looked like a
   request disappearing. Now the second one simply waits its turn.    */

async function sendAsk(uid) {
  const gap = msUntilAskAllowed();
  if (gap > 0) await wait(gap);

  const attempt = async () => {
    const batch = db.batch();
    stampAsk(batch);
    batch.update(db.collection("users").doc(uid), {
      followRequests: FieldValue.arrayUnion(state.uid)
    });
    await batch.commit();
  };

  try {
    await attempt();
  } catch (e) {
    // Another device may have asked a moment ago. One patient retry.
    if (e.code !== "permission-denied") throw e;
    await wait(ASK_GAP_MS);
    await attempt();
  }
  rememberAsk(uid, true);
}

/**
 * The one entry point every Follow button uses. It works out which of
 * the four things the tap means from where you actually stand.
 */
export async function toggleFollow(targetUid, onDone) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  if (isBlocked(uid)) return toast("You can't do that with someone you've blocked.");
  if (busy.has(uid)) return;

  if (isFollowing(uid)) return unfollow(uid, onDone);
  if (hasAskedToFollow(uid)) return withdrawAsk(uid, onDone);
  return follow(uid, onDone);
}

/** Kept for callers that ask explicitly. Same rules as the toggle. */
export function askToFollow(targetUid, onDone) {
  return toggleFollow(targetUid, onDone);
}

async function follow(uid, onDone) {
  busy.add(uid);
  const name = displayNameFor(uid);

  // Paint the likely outcome now, from the cache.
  const guessPrivate = isPrivateAccount(uid);
  if (guessPrivate) nudgeRequests(uid, true);
  else { setFollowingLocal(uid, true); nudgeFollowers(uid, 1); }
  paint(onDone);

  try {
    // The truth. This replaces the cached profile, nudges and all.
    const fresh = await refreshUser(uid);
    const followers = arr(fresh.followers);
    const requests = arr(fresh.followRequests);

    if (followers.includes(state.uid)) {
      // Already in — an approval this app never heard about.
      if (!state.following.includes(uid)) {
        setFollowingLocal(uid, true);
        await db.collection("users").doc(state.uid).update({ following: FieldValue.arrayUnion(uid) });
      }
      rememberAsk(uid, false);
      toast("You follow " + name);
    } else if (requests.includes(state.uid)) {
      setFollowingLocal(uid, false);
      rememberAsk(uid, true);
      toast("You've already asked " + name);
    } else if (fresh.private === true) {
      // Private — including one that went private since we last looked.
      setFollowingLocal(uid, false);
      nudgeRequests(uid, true);
      paint(onDone);
      await sendAsk(uid);
      toast("Asked to follow " + name);
    } else {
      setFollowingLocal(uid, true);
      nudgeFollowers(uid, 1);
      paint(onDone);
      // Both halves in one batch: their followers and your following
      // can no longer end up disagreeing because the connection dropped
      // between two separate writes.
      const batch = db.batch();
      batch.update(db.collection("users").doc(uid), { followers: FieldValue.arrayUnion(state.uid) });
      batch.update(db.collection("users").doc(state.uid), { following: FieldValue.arrayUnion(uid) });
      await batch.commit();
      toast("Following " + name);
    }
  } catch (e) {
    console.error("Follow failed:", e.code || e.message);
    setFollowingLocal(uid, false);
    // Put the cached profile back to what the server says, quietly.
    busy.delete(uid);
    await refreshUser(uid).catch(() => {
      nudgeRequests(uid, false);
      nudgeFollowers(uid, -1);
    });
    toast(e.code === "permission-denied"
      ? (isPrivateAccount(uid) ? limitMessage("ask") : "You can't follow " + name + " right now.")
      : "Couldn't save that. Check your connection.");
  }
  busy.delete(uid);
  paint(onDone);
}

async function unfollow(uid, onDone) {
  const name = displayNameFor(uid);
  if (isPrivateAccount(uid)) {
    const ok = await askConfirm({
      title: "Unfollow " + name + "?",
      body: "Their account is private. To follow them again you'll have to ask, and wait for a yes.",
      confirm: "Unfollow",
      danger: true
    });
    if (!ok) return;
  }
  if (busy.has(uid)) return;
  busy.add(uid);

  setFollowingLocal(uid, false);
  nudgeFollowers(uid, -1);
  paint(onDone);

  try {
    const batch = db.batch();
    batch.update(db.collection("users").doc(uid), { followers: FieldValue.arrayRemove(state.uid) });
    batch.update(db.collection("users").doc(state.uid), { following: FieldValue.arrayRemove(uid) });
    try {
      await batch.commit();
    } catch (e) {
      // Leaving must always work. If their half is refused — it may
      // never have landed — still take them off your own list.
      if (e.code !== "permission-denied") throw e;
      await db.collection("users").doc(state.uid).update({ following: FieldValue.arrayRemove(uid) });
    }
    await refreshUser(uid).catch(() => {});
    toast("Unfollowed " + name);
  } catch (e) {
    console.error("Unfollow failed:", e.code || e.message);
    setFollowingLocal(uid, true);
    nudgeFollowers(uid, 1);
    toast("Couldn't save that. Check your connection.");
  }
  busy.delete(uid);
  paint(onDone);
}

async function withdrawAsk(uid, onDone) {
  const name = displayNameFor(uid);
  const ok = await askConfirm({
    title: "Withdraw your request?",
    body: name + " won't see it any more. You can ask again later.",
    confirm: "Withdraw"
  });
  if (!ok || busy.has(uid)) return;
  busy.add(uid);

  nudgeRequests(uid, false);
  paint(onDone);

  try {
    await db.collection("users").doc(uid).update({
      followRequests: FieldValue.arrayRemove(state.uid)
    });
    rememberAsk(uid, false);
    toast("Request withdrawn");
  } catch (e) {
    console.error("Withdraw failed:", e.code || e.message);
    nudgeRequests(uid, true);
    toast("Couldn't do that right now.");
  }
  busy.delete(uid);
  // They may have answered in the meantime; show whatever is true now.
  await refreshUser(uid).catch(() => {});
  paint(onDone);
}

/**
 * Let somebody in, or turn them away. Both are one write on your own
 * profile, and the rules only accept it when exactly one name leaves
 * the queue and nothing but that same name joins the followers.
 */
export async function answerFollowRequest(requesterUid, accept, { quiet = false } = {}) {
  const uid = safeId(requesterUid);
  if (!uid) return false;
  if (!(state.followRequests || []).includes(uid)) return false;

  const me = state.userCache[state.uid] || (state.userCache[state.uid] = { uid: state.uid });
  const before = arr(me.followers);

  // Somebody you've blocked since they asked is only ever declined.
  if (accept && isBlocked(uid)) accept = false;

  const patch = { followRequests: FieldValue.arrayRemove(uid) };
  if (accept) patch.followers = FieldValue.arrayUnion(uid);

  state.followRequests = state.followRequests.filter((u) => u !== uid);
  if (accept && !before.includes(uid)) me.followers = before.concat([uid]);
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();

  let ok = true;
  try {
    await db.collection("users").doc(state.uid).update(patch);
    if (!quiet) toast(accept ? displayNameFor(uid) + " follows you now" : "Request declined");
  } catch (e) {
    ok = false;
    console.error("Follow request answer failed:", e.code || e.message);
    if (!state.followRequests.includes(uid)) state.followRequests = state.followRequests.concat([uid]);
    me.followers = before;
    if (!quiet) toast("Couldn't do that right now.");
  }
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();
  return ok;
}

/**
 * Flip your own account between open and approve-first.
 *
 * Going private keeps everyone who already follows you, and says so.
 * Going public with people still waiting lets them in first — leaving
 * them stuck on "Requested" at an account anyone can follow made no
 * sense, and they had no way to know.
 */
let privacyBusy = false;
export async function setPrivateAccount(on, { confirmFirst = true, quiet = false } = {}) {
  const want = !!on;
  const was = state.isPrivate === true;
  if (privacyBusy) return state.isPrivate;
  const firstChoice = !state.privacyChosen;
  if (want === was && !firstChoice) return state.isPrivate;

  const waiting = myFollowRequests();
  if (confirmFirst && want !== was) {
    const ok = want
      ? await askConfirm({
          title: "Make your account private?",
          body: "People who already follow you stay. Anyone new will have to ask, and you decide.",
          confirm: "Go private"
        })
      : await askConfirm({
          title: "Make your account public?",
          body: waiting.length
            ? `${waiting.length} ${waiting.length === 1 ? "person is" : "people are"} waiting to follow you. They'll all be let in, and anyone can follow you from now on.`
            : "Anyone will be able to follow you without asking.",
          confirm: "Go public"
        });
    if (!ok) { syncPrivacyUI(); return state.isPrivate; }
  }

  privacyBusy = true;
  state.isPrivate = want;
  syncPrivacyUI();

  try {
    if (!want && waiting.length) {
      // One approval per write — that is what the rules allow, and what
      // stops approving from smuggling anyone in.
      for (const uid of waiting) await answerFollowRequest(uid, true, { quiet: true });
    }
    await db.collection("users").doc(state.uid).update({ private: want });
    state.privacyChosen = true;
    if (state.userCache[state.uid]) state.userCache[state.uid].private = want;
    if (!quiet) toast(want ? "Your account is private" : "Your account is public");
  } catch (e) {
    console.error("Privacy switch failed:", e.code || e.message);
    state.isPrivate = was;
    toast("Couldn't change that right now.");
  }
  privacyBusy = false;
  syncPrivacyUI();
  refreshSocialUI();
  return state.isPrivate;
}

/** The one-time sheet for accounts that never picked. */
export async function chooseAccountType(el, type) {
  if (type !== "public" && type !== "private") return;
  document.querySelectorAll("#accountTypeSheet .type-card").forEach((card) => {
    const on = card.dataset.type === type;
    card.classList.toggle("selected", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  });
  // No "are you sure": this is the question itself.
  await setPrivateAccount(type === "private", { confirmFirst: false, quiet: true });
  if (state.privacyChosen) {
    closeOverlay("accountTypeSheet");
    toast(type === "private" ? "Private — you'll approve new followers" : "Public — anyone can follow you");
  }
}

/** Put the Settings switch in step with the account. */
export function syncPrivacyUI() {
  const on = state.isPrivate === true;
  const sw = document.getElementById("privacySwitch");
  const label = document.getElementById("privacyState");
  if (sw) sw.classList.toggle("on", on);
  if (label) {
    label.innerText = on
      ? "You approve everyone who follows you"
      : "Anyone can follow you";
  }
}

/* ---------------------------------------------------------------------
   The lists behind the numbers
   ---------------------------------------------------------------------
   A follower count you can't open is decoration, and worse: without a
   list, unfollowing somebody means remembering their handle and hunting
   down their profile. Tapping any of the three numbers opens the people
   behind it, with the follow button right there on each row.

   All three lists are already in memory. `followers` and `following`
   arrive inside the profile document the app fetched to draw the page,
   and your own following list is held in state — so opening a list
   costs nothing beyond the names, which are cached too.
   ------------------------------------------------------------------- */

let listUid = "";
let listKind = "followers";

const LIST_TITLES = {
  followers: "Followers",
  following: "Following",
  vouches: "Vouched by",
  requests: "Follow requests"
};

function isFollowListOpen() {
  const el = document.getElementById("followListScreen");
  return !!el && !el.classList.contains("hidden");
}

/**
 * A private account's followers and following are for its followers.
 * (The rules still let any signed-in student read a profile document,
 * so this is a courtesy the app keeps, not a wall — said plainly in
 * SECURITY.md rather than pretended otherwise.)
 */
export function listIsLocked(uid, kind) {
  return (kind === "followers" || kind === "following")
    && uid !== state.uid
    && isPrivateAccount(uid)
    && !isFollowing(uid);
}

/** Which uids belong in this list, straight out of what we already hold. */
function listMembers() {
  const u = state.userCache[listUid] || {};
  let uids;
  if (listKind === "requests") uids = state.followRequests;
  else if (listKind === "followers") uids = u.followers;
  else if (listKind === "vouches") uids = u.vouchedBy;
  else uids = listUid === state.uid ? state.following : u.following;
  return (Array.isArray(uids) ? uids : []).filter((x) => x && !isBlocked(x));
}

export async function openFollowList(targetUid, kind) {
  const uid = safeId(targetUid);
  if (!uid) return;
  listUid = uid;
  listKind = LIST_TITLES[kind] ? kind : "followers";

  openOverlay("followListScreen");
  renderFollowList();

  // The arrays normally arrive with the profile that was just opened.
  // If this list was reached some other way, fetch them first.
  const u = state.userCache[uid] || {};
  const needsDoc = listKind === "requests"
    ? false
    : listKind === "followers"
      ? !Array.isArray(u.followers)
      : listKind === "vouches"
        ? !Array.isArray(u.vouchedBy)
        : uid !== state.uid && !Array.isArray(u.following);
  if (needsDoc) await fetchUser(uid, { force: true });
  if (listIsLocked(uid, listKind)) { if (isFollowListOpen()) renderFollowList(); return; }

  // Every row carries a Follow button, and that button needs to know
  // whether the person is private and whether you've already asked.
  // Cached copies are fine to draw from — the tap itself checks.
  await primeUsers(listMembers());
  if (isFollowListOpen()) renderFollowList();
}

export function closeFollowList() {
  closeOverlay("followListScreen");
}

/** Follow or unfollow from inside a list, keeping the list on screen. */
export function toggleFollowInList(uid) {
  toggleFollow(uid, () => { if (isFollowListOpen()) renderFollowList(); });
}

export function renderFollowList() {
  const box = document.getElementById("followListBody");
  const title = document.getElementById("followListTitle");
  if (!box) return;

  if (listIsLocked(listUid, listKind)) {
    if (title) title.innerText = LIST_TITLES[listKind];
    box.innerHTML = `
      <div class="pe-empty locked-list">
        <span class="pe-empty-icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
        <b>This account is private</b>
        <span>Follow ${escapeHtml(displayNameFor(listUid))} to see who they follow and who follows them.</span>
      </div>`;
    return;
  }

  const members = listMembers();
  if (title) {
    title.innerText = LIST_TITLES[listKind] + (members.length ? " · " + members.length : "");
  }

  if (!members.length) {
    const empty = {
      followers: "No followers yet.",
      following: "Not following anyone yet.",
      vouches: "Nobody has vouched for them yet.",
      requests: "Nobody is waiting. When somebody asks to follow you, they'll show up here."
    }[listKind];
    box.innerHTML = `<div class="empty-state"><h4>${escapeHtml(LIST_TITLES[listKind])}</h4><p>${escapeHtml(empty)}</p></div>`;
    return;
  }

  // Rules cap these arrays at 5000. Painting five thousand rows would
  // lock the page up, and nobody scrolls that far anyway.
  const LIST_CAP = 300;
  const capped = members.slice(0, LIST_CAP);
  const hidden = members.length - capped.length;

  box.innerHTML = capped.map((uid) => {
    const id = safeId(uid);
    if (!id) return "";
    const me = uid === state.uid;
    const on = isFollowing(uid);
    let action;
    if (listKind === "requests") {
      action = `
        <button class="act primary" onclick="event.stopPropagation(); window.answerFollowRequest('${id}', true)">Approve</button>
        <button class="act" onclick="event.stopPropagation(); window.answerFollowRequest('${id}', false)">Decline</button>`;
    } else if (me) {
      action = `<span class="row-chip">You</span>`;
    } else if (listKind === "followers" && listUid === state.uid) {
      // Your own followers: follow back, and a way to take someone out.
      const back = on
        ? `<button class="act joined" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">Following</button>`
        : hasAskedToFollow(uid)
          ? `<button class="act requested" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">Requested</button>`
          : `<button class="act primary" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">${isPrivateAccount(uid) ? "Ask" : "Follow back"}</button>`;
      action = `${back}<button class="act icon-only" aria-label="Remove follower" title="Remove follower" onclick="event.stopPropagation(); window.removeFollower('${id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>`;
    } else if (hasAskedToFollow(uid)) {
      action = `<button class="act requested" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">Requested</button>`;
    } else {
      action = `<button class="act ${on ? "joined" : "primary"}" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">${on ? "Following" : isPrivateAccount(uid) ? "Ask" : "Follow"}</button>`;
    }
    return `
      <div class="orbit-row" onclick="window.closeFollowList(); window.openProfileScreen('${id}')">
        <div class="chat-avatar" style="width:44px;height:44px;font-size:19px;">${renderAvatar(avatarFor(uid))}</div>
        <div class="result-text">
          <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
          <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
        </div>
        <div class="orbit-row-actions">${action}</div>
      </div>`;
  }).join("") + (hidden
    ? `<p class="settings-hint" style="text-align:center;">and ${hidden} more</p>`
    : "");
}

/* ---------------------------------------------------------------------
   Removing a follower, and blocking
   ------------------------------------------------------------------- */

/**
 * Take someone out of YOUR followers. Before this there was no way to
 * do it at all — so going private did nothing about the people already
 * in, and blocking someone left them counted as a follower.
 */
export async function removeFollower(targetUid, { ask = true } = {}) {
  const uid = safeId(targetUid);
  if (!uid) return false;
  const me = state.userCache[state.uid] || (state.userCache[state.uid] = { uid: state.uid });
  const before = arr(me.followers);
  if (!before.includes(uid)) return true;

  if (ask) {
    const ok = await askConfirm({
      title: "Remove " + displayNameFor(uid) + "?",
      body: "They won't be told. " + (state.isPrivate
        ? "They'd have to ask again to follow you."
        : "They could follow you again, unless you make your account private."),
      confirm: "Remove",
      danger: true
    });
    if (!ok) return false;
  }

  me.followers = before.filter((u) => u !== uid);
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();
  try {
    await db.collection("users").doc(state.uid).update({ followers: FieldValue.arrayRemove(uid) });
    if (ask) toast("Removed");
    return true;
  } catch (e) {
    console.error("Remove follower failed:", e.code || e.message);
    me.followers = before;
    if (ask) toast("Couldn't do that right now.");
    refreshSocialUI();
    if (isFollowListOpen()) renderFollowList();
    return false;
  }
}

/**
 * Called just before a block. Blocking is total, so every follow edge
 * between the two of you goes, in both directions, along with any
 * request either way. Each write stands alone: one being refused
 * (because it was never there) must not stop the others.
 */
export async function severFollow(targetUid) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  const mine = db.collection("users").doc(state.uid);
  const theirs = db.collection("users").doc(uid);
  const quietly = (p) => p.catch(() => {});

  let fresh = state.userCache[uid] || {};
  try { fresh = await refreshUser(uid); } catch (e) {}

  const jobs = [];
  if (state.following.includes(uid)) {
    setFollowingLocal(uid, false);
    jobs.push(quietly(mine.update({ following: FieldValue.arrayRemove(uid) })));
  }
  if (arr(fresh.followers).includes(state.uid)) {
    jobs.push(quietly(theirs.update({ followers: FieldValue.arrayRemove(state.uid) })));
  }
  if (arr(fresh.followRequests).includes(state.uid)) {
    rememberAsk(uid, false);
    jobs.push(quietly(theirs.update({ followRequests: FieldValue.arrayRemove(state.uid) })));
  }
  if ((state.followRequests || []).includes(uid)) {
    jobs.push(answerFollowRequest(uid, false, { quiet: true }));
  }
  await Promise.all(jobs);
  // Owner-side writes to one document go one at a time.
  await removeFollower(uid, { ask: false });
  refreshSocialUI();
}
