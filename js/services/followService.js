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
  fetchUser, primeUsers, displayNameFor, usernameFor, avatarFor
} from './userService.js';
import { toast, refreshSocialUI } from '../utils/ui.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { stampAsk, limitMessage } from './limitsService.js';

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
      if (state.userCache[state.uid]) Object.assign(state.userCache[state.uid], d);
      syncPrivacyUI();
      if (typeof onChange === "function") onChange();
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

export function followerCount(uid) {
  const u = state.userCache[uid];
  if (!u) return 0;
  if (typeof u.followerCount === "number") return u.followerCount;
  return Array.isArray(u.followers) ? u.followers.length : 0;
}

export function followingCount(uid) {
  if (uid === state.uid) return state.following.length;
  const u = state.userCache[uid];
  if (!u) return 0;
  if (typeof u.followingCount === "number") return u.followingCount;
  return Array.isArray(u.following) ? u.following.length : 0;
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

/**
 * Follow or unfollow — the same call, because the button is a toggle.
 * Two writes: their list, then mine. Mine goes second so that if the
 * connection drops between them, the visible, public number is the one
 * that stayed correct.
 */
export async function toggleFollow(targetUid, onDone) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  if (isBlocked(uid)) return toast("You can't do that with someone you've blocked.");

  // A private account is asked, not followed. Unfollowing one still
  // goes down the normal path — leaving is never gated.
  if (!isFollowing(uid) && isPrivateAccount(uid)) {
    return askToFollow(uid, onDone);
  }

  const on = isFollowing(uid);

  // Optimistic: the button AND the count move now, network catches up.
  state.following = on
    ? state.following.filter((u) => u !== uid)
    : state.following.concat([uid]);
  nudgeFollowers(uid, on ? -1 : 1);
  if (typeof onDone === "function") onDone();
  refreshSocialUI();

  try {
    await db.collection("users").doc(uid).update({
      followers: on ? FieldValue.arrayRemove(state.uid) : FieldValue.arrayUnion(state.uid)
    });
    await db.collection("users").doc(state.uid).update({
      following: on ? FieldValue.arrayRemove(uid) : FieldValue.arrayUnion(uid)
    });

    // Pull their profile back so the follower count on screen is the
    // real one rather than our guess at it.
    await fetchUser(uid, { force: true });
    toast(on ? "Unfollowed " + displayNameFor(uid) : "Following " + displayNameFor(uid));
  } catch (e) {
    console.error("Follow failed:", e.code || e.message);
    // Put it back the way it was.
    state.following = on
      ? state.following.concat([uid])
      : state.following.filter((u) => u !== uid);
    nudgeFollowers(uid, on ? 1 : -1);
    toast("Couldn't save that. Check your connection.");
  }
  if (typeof onDone === "function") onDone();
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();
}

/** Move my own uid in or out of somebody's request queue. */
function nudgeRequests(uid, joining) {
  const u = state.userCache[uid];
  if (!u) return;
  const list = Array.isArray(u.followRequests) ? u.followRequests : [];
  u.followRequests = joining
    ? list.concat([state.uid])
    : list.filter((x) => x !== state.uid);
}

/** Ask a private account to let you follow, or take the ask back. */
export async function askToFollow(targetUid, onDone) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  if (isBlocked(uid)) return toast("You can't do that with someone you've blocked.");

  const asked = hasAskedToFollow(uid);
  nudgeRequests(uid, !asked);
  if (typeof onDone === "function") onDone();
  refreshSocialUI();

  try {
    if (asked) {
      // Withdrawing is never rate limited — leaving never is.
      await db.collection("users").doc(uid).update({
        followRequests: FieldValue.arrayRemove(state.uid)
      });
    } else {
      const batch = db.batch();
      stampAsk(batch);
      batch.update(db.collection("users").doc(uid), {
        followRequests: FieldValue.arrayUnion(state.uid)
      });
      await batch.commit();
    }
    toast(asked ? "Request withdrawn" : "Asked to follow " + displayNameFor(uid));
  } catch (e) {
    console.error("Follow request failed:", e.code || e.message);
    nudgeRequests(uid, asked);
    toast(e.code === "permission-denied" ? limitMessage("ask") : "Couldn't send that. Check your connection.");
  }
  if (typeof onDone === "function") onDone();
  refreshSocialUI();
}

/**
 * Let somebody in, or turn them away. Both are one write on your own
 * profile, and the rules only accept it when exactly one name leaves
 * the queue and nothing but that same name joins the followers.
 */
export async function answerFollowRequest(requesterUid, accept) {
  const uid = safeId(requesterUid);
  if (!uid) return;

  const me = state.userCache[state.uid] || {};
  const before = Array.isArray(me.followers) ? me.followers : [];
  if (!(state.followRequests || []).includes(uid)) return;

  const patch = { followRequests: FieldValue.arrayRemove(uid) };
  if (accept) patch.followers = FieldValue.arrayUnion(uid);

  state.followRequests = state.followRequests.filter((u) => u !== uid);
  if (accept) me.followers = before.concat([uid]);
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();

  try {
    await db.collection("users").doc(state.uid).update(patch);
    toast(accept ? displayNameFor(uid) + " follows you now" : "Request declined");
  } catch (e) {
    console.error("Follow request answer failed:", e.code || e.message);
    state.followRequests = state.followRequests.concat([uid]);
    me.followers = before;
    toast("Couldn't do that right now.");
  }
  refreshSocialUI();
  if (isFollowListOpen()) renderFollowList();
}

/** Flip your own account between open and approve-first. */
export async function setPrivateAccount(on) {
  const want = !!on;
  const was = state.isPrivate === true;
  state.isPrivate = want;

  try {
    await db.collection("users").doc(state.uid).update({ private: want });
    if (state.userCache[state.uid]) state.userCache[state.uid].private = want;
    toast(want ? "Your account is private" : "Your account is open");
  } catch (e) {
    console.error("Privacy switch failed:", e.code || e.message);
    state.isPrivate = was;
    toast("Couldn't change that right now.");
  }
  refreshSocialUI();
  return state.isPrivate;
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
    } else if (hasAskedToFollow(uid)) {
      action = `<button class="act requested" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">Asked</button>`;
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
