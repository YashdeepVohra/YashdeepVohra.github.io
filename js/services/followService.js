// ==========================================
// FOLLOWING — the light, public half of the graph
// ==========================================
//
// Orbit is the deliberate, mutual tier: the people you'd actually show
// up for. Following is the cheap one — one tap, no permission asked,
// one way — and it exists mainly so a profile carries a number that
// means something to a stranger.
//
// ONE DOCUMENT PER FOLLOWER, AND A COUNT
// --------------------------------------
// `followers` was an array on the profile, capped at 5000. Nobody
// decided 5000 people was enough to follow somebody — that was the
// shape showing through the product. An array of uids runs at the
// 1 MiB a document gets, every follow rewrote the whole document
// (and one document takes about one write a second), every read of
// that profile dragged the entire list down the wire, and any signed
// in account could read a private account's whole follower list
// straight out of it.
//
// So a follower is a document now: users/{uid}/followers/{followerUid},
// holding nothing but the time. The id IS the follower's uid, so two
// people following at the same moment write two different documents
// instead of racing over one array, and there is no ceiling.
//
// The number on the profile is `followerCount`, and it still cannot be
// inflated by its owner. The rules only let it move in the same write
// that provably creates or deletes the matching follower document, and
// `followerEdge` names whose — so a count has to be earned one real
// account at a time, same as before.
//
// `following` deliberately did NOT move. Only you write your own list,
// so there is no contention on it, and one read gives the app the whole
// thing — which is what answers "am I following them?" on every card in
// the feed, for nothing. A subcollection there would have cost a read
// per person you follow on every cold start, to answer a question the
// array already answers for free.
//
// The honest caveat is unchanged: `following` is your own list on your
// own document, so a determined person could add uids they do not
// really follow. That is why the FOLLOWER count is the one used as a
// signal anywhere it matters, and the following count is just context.
//
// PRIVATE ACCOUNTS
// ----------------
// With `private: true`, a follow does not land in `followers` at all —
// the rules forbid it — it lands in users/{uid}/followRequests/{asker},
// and only the owner can move a name from that queue into their
// followers. The rule on the follower document checks the request
// really existed, so approving cannot smuggle in somebody who never
// asked. The queue is also readable only by its owner now; the asker
// can read their own row and nothing else.
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
  fetchUser, refreshUser, primeUsers, displayNameFor, usernameFor, avatarFor
} from './userService.js';
import { toast, refreshSocialUI } from '../utils/ui.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { askConfirm } from '../utils/confirm.js';
import { stampAsk, limitMessage, msUntilAskAllowed, ASK_GAP_MS } from './limitsService.js';

/* ---------------------------------------------------------------------
   Where each edge lives
   ------------------------------------------------------------------- */

/** users/{uid}/followers/{followerUid} — one document per follower. */
export function followerRef(uid, followerUid) {
  return db.collection("users").doc(uid).collection("followers").doc(followerUid);
}

/** users/{uid}/followRequests/{askerUid} — the queue on a private account. */
export function askRef(uid, askerUid) {
  return db.collection("users").doc(uid).collection("followRequests").doc(askerUid);
}

/**
 * A live view of your own profile document.
 *
 * Your own `following`, the private switch and your follower count live
 * here. One read to start and one per change after that, which is also
 * what keeps two devices signed in at once from disagreeing.
 */
export function loadMyProfile(onChange) {
  if (state.myProfileUnsubscribe) state.myProfileUnsubscribe();

  state.myProfileUnsubscribe = db.collection("users").doc(state.uid).onSnapshot(
    (doc) => {
      const d = doc.data() || {};
      state.following = Array.isArray(d.following) ? d.following : [];
      state.isPrivate = d.private === true;
      state.privacyChosen = typeof d.private === "boolean";
      if (state.userCache[state.uid]) Object.assign(state.userCache[state.uid], d);
      syncPrivacyUI();
      if (typeof onChange === "function") onChange();
      resolvePendingAsks();
    },
    (error) => console.error("Own profile listener:", error.code || error.message)
  );

  loadMyFollowRequests(onChange);
}

/**
 * The queue of people waiting on you.
 *
 * It used to be an array on your own profile, so the listener above
 * carried it for free. It is a subcollection now — written by the
 * asker, readable only by you — which means it needs a listener of its
 * own. That costs one read per person actually waiting, which for
 * almost everybody is nought, and it is the write that a request has to
 * make anyway.
 *
 * Attached whatever the account setting is, not just while private: an
 * account that goes public still has to let the people already waiting
 * in, and a queue nobody is listening to is a queue nobody answers. An
 * empty one costs a single read.
 */
export function loadMyFollowRequests(onChange) {
  if (state.followRequestsUnsubscribe) state.followRequestsUnsubscribe();
  state.followRequestsUnsubscribe = null;

  if (!state.uid) return;

  state.followRequestsUnsubscribe = db.collection("users").doc(state.uid)
    .collection("followRequests")
    .orderBy("at", "desc")
    .limit(200)
    .onSnapshot(
      (snap) => {
        state.followRequests = snap.docs.map((d) => d.id);
        // Names for the queue, so the list paints without a second pass.
        primeUsers(state.followRequests).then(() => {
          if (typeof onChange === "function") onChange();
          if (isFollowListOpen()) renderFollowList();
        });
        if (typeof onChange === "function") onChange();
      },
      (error) => console.error("Follow requests listener:", error.code || error.message)
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

/**
 * Have I already asked to follow them?
 *
 * Their request queue is theirs to read, not mine — so this cannot be
 * answered from their profile any more. It is answered from the asks
 * this device remembers, which is what the localStorage record below
 * was already for, and confirmed against the server whenever a profile
 * is actually opened (syncFollowState).
 */
export function hasAskedToFollow(uid) {
  return !!uid && askedSet().has(uid);
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
 * A list in hand can be filtered exactly. `followerCount` is a stored
 * number now and cannot be, so a follower you have blocked is still
 * inside it — the honest trade for a count that no longer has a
 * ceiling. The list under it, which IS filtered, is the one that has
 * to be right, and the numbers only disagree for people you blocked.
 */
function countOf(list, fallback) {
  if (Array.isArray(list)) return list.filter((u) => !isBlocked(u)).length;
  return typeof fallback === "number" ? fallback : 0;
}

export function followerCount(uid) {
  const u = state.userCache[uid];
  if (!u) return 0;
  // A loaded page of followers beats the stored number, because it can
  // be filtered; the number is what answers before anyone opens it.
  if (uid === listUid && listKind === "followers" && Array.isArray(loadedFollowers)) {
    return countOf(loadedFollowers, u.followerCount);
  }
  return typeof u.followerCount === "number" ? Math.max(0, u.followerCount) : 0;
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
  u.followerCount = Math.max(0, (u.followerCount || 0) + delta);
  if (Array.isArray(loadedFollowers) && uid === listUid) {
    loadedFollowers = delta > 0
      ? loadedFollowers.concat([state.uid])
      : loadedFollowers.filter((x) => x !== state.uid);
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

// Things that must happen when you stop following someone, registered
// by whoever owns them (a pending orbit request goes too — orbit comes
// after following). A registry rather than an import keeps the orbit
// and follow modules from importing each other.
const unfollowHooks = [];
export function onUnfollow(fn) {
  if (typeof fn === "function") unfollowHooks.push(fn);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Remember that I am (or am no longer) in somebody's request queue.
 *
 * Their queue is theirs to read, so there is nothing to nudge on a
 * cached profile any more — the record this device keeps IS the answer
 * the button reads.
 */
function nudgeRequests(uid, joining) {
  rememberAsk(uid, joining);
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
   Approving a request writes the owner's followers; only YOU can write
   your own `following`, and nothing tells your app it happened. So an
   approved request would leave you following someone whose profile
   still offered "Ask to follow", and a following count one short.

   This record now does double duty. A private account's request queue
   is readable only by its owner, so "have I asked them?" cannot be
   answered from their profile at all — this is the answer, confirmed
   against the server by syncFollowState() whenever a profile is
   actually opened, and swept once per launch by resolvePendingAsks.  */

const ASKS_KEY = () => "livesociya.asks." + state.uid;

// The same list as a Set, rebuilt when it changes rather than parsed
// out of localStorage on every button repaint.
let askedCache = null;
let askedCacheFor = "";
function askedSet() {
  if (askedCache && askedCacheFor === state.uid) return askedCache;
  askedCacheFor = state.uid;
  askedCache = new Set(readAsks());
  return askedCache;
}

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
  const set = askedSet();
  if (on) set.add(uid); else set.delete(uid);
}

/* ---- Keeping the two halves of an edge in step ---------------------
   A follow is two writes: their follower document, and your own
   `following`. Approving is the same two, made by two different people
   — they create your follower document, and nothing tells your app. So
   the halves can disagree, and the button is what shows it.

   This used to ride on every fresh profile read, because the answer was
   sitting in the array that came with it. It is a document of its own
   now, so asking costs a read — which means it is asked deliberately:
   once per launch over the asks still outstanding, and once whenever a
   profile is actually opened, where a read is being spent anyway.   */

const healing = new Set();

/**
 * Settle where you really stand with one person, from the server.
 * Two reads at worst, and usually the second is skipped.
 */
export async function syncFollowState(uid) {
  if (!state.uid || !safeId(uid) || uid === state.uid) return;
  if (busy.has(uid) || healing.has(uid)) return;

  healing.add(uid);
  try {
    const edge = await followerRef(uid, state.uid).get();
    const inTheirs = edge.exists;
    const inMine = state.following.includes(uid);

    // In their followers means the ask, if there was one, is answered.
    if (inTheirs) rememberAsk(uid, false);
    else if (askedSet().has(uid)) {
      // Still remembered as asked — is the request actually still out?
      const still = await askRef(uid, state.uid).get().catch(() => null);
      if (still && !still.exists) rememberAsk(uid, false);
    }

    if (inTheirs === inMine || isBlocked(uid)) return;

    setFollowingLocal(uid, inTheirs);
    refreshSocialUI();
    await db.collection("users").doc(state.uid)
      .update({ following: inTheirs ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid) })
      .catch((e) => console.warn("Follow repair failed:", e.code || e.message));
  } catch (e) {
    // Offline. The next profile open or the next launch will settle it.
  } finally {
    healing.delete(uid);
    refreshSocialUI();
  }
}

/** Once per launch: find out what happened to the asks still out. */
let asksResolvedFor = "";
export async function resolvePendingAsks() {
  if (!state.uid || asksResolvedFor === state.uid) return;
  asksResolvedFor = state.uid;
  for (const uid of readAsks().slice(-15)) {
    await syncFollowState(uid);
  }
}

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
    batch.set(askRef(uid, state.uid), { at: FieldValue.serverTimestamp() });
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
    // The truth: their profile, and whether an edge between us already
    // exists. Two reads, on an action people take a handful of times a
    // day — and getting it wrong is worse than paying for them.
    const [fresh, edge] = await Promise.all([
      refreshUser(uid),
      followerRef(uid, state.uid).get()
    ]);

    if (edge.exists) {
      // Already in — an approval this app never heard about.
      if (!state.following.includes(uid)) {
        setFollowingLocal(uid, true);
        await db.collection("users").doc(state.uid).update({ following: FieldValue.arrayUnion(uid) });
      }
      rememberAsk(uid, false);
      toast("You follow " + name);
    } else if (fresh.private === true) {
      // Private — including one that went private since we last looked.
      // Their queue is theirs to read, so whether we already asked is
      // answered by the row we would be writing.
      setFollowingLocal(uid, false);
      const mine = await askRef(uid, state.uid).get().catch(() => null);
      if (mine && mine.exists) {
        rememberAsk(uid, true);
        paint(onDone);
        toast("You've already asked " + name);
      } else {
        nudgeRequests(uid, true);
        paint(onDone);
        await sendAsk(uid);
        toast("Asked to follow " + name);
      }
    } else {
      setFollowingLocal(uid, true);
      nudgeFollowers(uid, 1);
      paint(onDone);
      // Three writes, one batch: the follower document, the count that
      // goes with it, and your own following. They can no longer end up
      // disagreeing because the connection dropped between two of them.
      // `followerEdge` is what lets the rule check the count moved with
      // a real document — see firestore.rules.
      const batch = db.batch();
      batch.set(followerRef(uid, state.uid), { at: FieldValue.serverTimestamp() });
      batch.update(db.collection("users").doc(uid), {
        followerCount: FieldValue.increment(1),
        followerEdge: state.uid
      });
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
    batch.delete(followerRef(uid, state.uid));
    batch.update(db.collection("users").doc(uid), {
      followerCount: FieldValue.increment(-1),
      followerEdge: state.uid
    });
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
    unfollowHooks.forEach((fn) => { try { fn(uid); } catch (e) {} });
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
    await askRef(uid, state.uid).delete();
    rememberAsk(uid, false);
    toast("Request withdrawn");
  } catch (e) {
    console.error("Withdraw failed:", e.code || e.message);
    nudgeRequests(uid, true);
    toast("Couldn't do that right now.");
  }
  busy.delete(uid);
  // They may have answered in the meantime; show whatever is true now.
  await syncFollowState(uid);
  paint(onDone);
}

/**
 * Let somebody in, or turn them away.
 *
 * Declining is one delete. Approving is a batch: the request row goes,
 * the follower document arrives, and the count moves with it. The rule
 * on the follower document checks — with exists(), which sees the state
 * BEFORE this batch — that a request really was there, so approving
 * cannot smuggle in somebody who never asked.
 */
export async function answerFollowRequest(requesterUid, accept, { quiet = false } = {}) {
  const uid = safeId(requesterUid);
  if (!uid) return false;
  if (!(state.followRequests || []).includes(uid)) return false;

  const me = state.userCache[state.uid] || (state.userCache[state.uid] = { uid: state.uid });
  const beforeCount = me.followerCount || 0;

  // Somebody you've blocked since they asked is only ever declined.
  if (accept && isBlocked(uid)) accept = false;

  const before = state.followRequests.slice();
  state.followRequests = state.followRequests.filter((u) => u !== uid);
  if (accept) me.followerCount = beforeCount + 1;
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();

  let ok = true;
  try {
    if (accept) {
      const batch = db.batch();
      batch.delete(askRef(state.uid, uid));
      batch.set(followerRef(state.uid, uid), { at: FieldValue.serverTimestamp() });
      batch.update(db.collection("users").doc(state.uid), {
        followerCount: FieldValue.increment(1),
        followerEdge: uid
      });
      await batch.commit();
    } else {
      await askRef(state.uid, uid).delete();
    }
    if (!quiet) toast(accept ? displayNameFor(uid) + " follows you now" : "Request declined");
  } catch (e) {
    ok = false;
    console.error("Follow request answer failed:", e.code || e.message);
    state.followRequests = before;
    me.followerCount = beforeCount;
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

// The page of followers fetched for whoever's list is open. Followers
// are a subcollection now, so unlike `following` and `vouchedBy` they
// do not arrive with the profile — they are queried when the list is
// opened, and only then. Kept here so followerCount() can filter
// blocked people out of a count once the list behind it is in hand.
let loadedFollowers = null;

// Rules cap nothing now. This is what a person will actually scroll.
const FOLLOWER_PAGE = 300;

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
 *
 * The followers half is a real wall now, not a courtesy: the read rule
 * on users/{uid}/followers refuses the query outright unless you are
 * the owner, the account is public, or you already follow it. `following`
 * and `vouchedBy` are still arrays on a profile any signed-in person
 * can read, so those two remain app-level — see SECURITY.md.
 */
export function listIsLocked(uid, kind) {
  return (kind === "followers" || kind === "following" || kind === "vouches")
    && uid !== state.uid
    && isPrivateAccount(uid)
    && !isFollowing(uid);
}

/** Which uids belong in this list, out of what we hold for it. */
function listMembers() {
  const u = state.userCache[listUid] || {};
  let uids;
  if (listKind === "requests") uids = state.followRequests;
  else if (listKind === "followers") uids = loadedFollowers;
  else if (listKind === "vouches") uids = u.vouchedBy;
  else uids = listUid === state.uid ? state.following : u.following;
  return (Array.isArray(uids) ? uids : []).filter((x) => x && !isBlocked(x));
}

/** Newest followers first — one page, only when somebody opens it. */
async function fetchFollowers(uid) {
  const snap = await db.collection("users").doc(uid).collection("followers")
    .orderBy("at", "desc")
    .limit(FOLLOWER_PAGE)
    .get();
  return snap.docs.map((d) => d.id);
}

export async function openFollowList(targetUid, kind) {
  const uid = safeId(targetUid);
  if (!uid) return;
  const switching = uid !== listUid || kind !== listKind;
  listUid = uid;
  listKind = LIST_TITLES[kind] ? kind : "followers";
  if (switching && listKind === "followers") loadedFollowers = null;

  openOverlay("followListScreen");
  renderFollowList();

  // `following` and `vouchedBy` ride along with the profile document.
  // `followers` is a query of its own, and the only one that costs
  // anything — which is exactly why it waits until somebody asks.
  const u = state.userCache[uid] || {};
  const needsDoc = listKind === "vouches"
    ? !Array.isArray(u.vouchedBy)
    : listKind === "following"
      ? uid !== state.uid && !Array.isArray(u.following)
      : false;
  if (needsDoc) await fetchUser(uid, { force: true });
  if (listIsLocked(uid, listKind)) { if (isFollowListOpen()) renderFollowList(); return; }

  if (listKind === "followers" && !Array.isArray(loadedFollowers)) {
    try {
      loadedFollowers = await fetchFollowers(uid);
    } catch (e) {
      // A refused query means the rules say this list is not ours to
      // read — the same answer listIsLocked gives, arrived at the hard
      // way (a private account we do not follow).
      console.error("Followers load failed:", e.code || e.message);
      loadedFollowers = [];
    }
    if (listUid !== uid) return;
    if (isFollowListOpen()) renderFollowList();
  }

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
        <span>Follow ${escapeHtml(displayNameFor(listUid))} to see who they follow, who follows them, and who vouches for them.</span>
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
export async function removeFollower(targetUid, { ask = true, known = null } = {}) {
  const uid = safeId(targetUid);
  if (!uid) return false;
  const me = state.userCache[state.uid] || (state.userCache[state.uid] = { uid: state.uid });

  // Is there anything to remove? The list on screen knows when it is
  // loaded; otherwise ask, so severFollow does not spend a write on an
  // edge that was never there.
  let present = known;
  if (present === null) {
    if (Array.isArray(loadedFollowers) && listUid === state.uid) present = loadedFollowers.includes(uid);
    else present = await followerRef(state.uid, uid).get().then((d) => d.exists).catch(() => false);
  }
  if (!present) return true;

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

  const beforeCount = me.followerCount || 0;
  const beforeList = Array.isArray(loadedFollowers) ? loadedFollowers.slice() : null;
  me.followerCount = Math.max(0, beforeCount - 1);
  if (Array.isArray(loadedFollowers)) loadedFollowers = loadedFollowers.filter((u) => u !== uid);
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();

  try {
    const batch = db.batch();
    batch.delete(followerRef(state.uid, uid));
    batch.update(db.collection("users").doc(state.uid), {
      followerCount: FieldValue.increment(-1),
      followerEdge: uid
    });
    await batch.commit();
    if (ask) toast("Removed");
    return true;
  } catch (e) {
    console.error("Remove follower failed:", e.code || e.message);
    me.followerCount = beforeCount;
    loadedFollowers = beforeList;
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
  const quietly = (p) => p.catch(() => {});

  // What actually exists between us. Two reads rather than a profile
  // fetch, because the edges are documents now and the arrays that used
  // to answer this are gone.
  const [iFollowThem, iAsked] = await Promise.all([
    followerRef(uid, state.uid).get().then((d) => d.exists).catch(() => false),
    askRef(uid, state.uid).get().then((d) => d.exists).catch(() => false)
  ]);

  const jobs = [];
  if (state.following.includes(uid)) {
    setFollowingLocal(uid, false);
    jobs.push(quietly(mine.update({ following: FieldValue.arrayRemove(uid) })));
  }
  if (iFollowThem) {
    // Leaving works block or no block — that is what the delete rule on
    // the follower document says, and why it is not gated on anything.
    const batch = db.batch();
    batch.delete(followerRef(uid, state.uid));
    batch.update(db.collection("users").doc(uid), {
      followerCount: FieldValue.increment(-1),
      followerEdge: state.uid
    });
    jobs.push(quietly(batch.commit()));
  }
  if (iAsked) {
    rememberAsk(uid, false);
    jobs.push(quietly(askRef(uid, state.uid).delete()));
  }
  if ((state.followRequests || []).includes(uid)) {
    jobs.push(answerFollowRequest(uid, false, { quiet: true }));
  }
  await Promise.all(jobs);
  // Owner-side, and it checks for itself whether there is anything there.
  await removeFollower(uid, { ask: false });
  refreshSocialUI();
}
