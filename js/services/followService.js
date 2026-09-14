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
// ==========================================

import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId, escapeHtml, renderAvatar } from '../utils/formatters.js';
import { isBlocked } from './blockService.js';
import {
  fetchUser, primeUsers, displayNameFor, usernameFor, avatarFor
} from './userService.js';
import { toast } from '../utils/ui.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';

/** Am I following them? Read from my own list, never the network. */
export function isFollowing(uid) {
  return !!uid && state.following.includes(uid);
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

  const on = isFollowing(uid);

  // Optimistic: the button AND the count move now, network catches up.
  state.following = on
    ? state.following.filter((u) => u !== uid)
    : state.following.concat([uid]);
  nudgeFollowers(uid, on ? -1 : 1);
  if (typeof onDone === "function") onDone();

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
  if (isFollowListOpen()) renderFollowList();
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
  vouches: "Vouched by"
};

function isFollowListOpen() {
  const el = document.getElementById("followListScreen");
  return !!el && !el.classList.contains("hidden");
}

/** Which uids belong in this list, straight out of what we already hold. */
function listMembers() {
  const u = state.userCache[listUid] || {};
  let uids;
  if (listKind === "followers") uids = u.followers;
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
  const needsDoc = listKind === "followers"
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
      vouches: "Nobody has vouched for them yet."
    }[listKind];
    box.innerHTML = `<div class="empty-state"><h4>${escapeHtml(LIST_TITLES[listKind])}</h4><p>${escapeHtml(empty)}</p></div>`;
    return;
  }

  box.innerHTML = members.map((uid) => {
    const id = safeId(uid);
    if (!id) return "";
    const me = uid === state.uid;
    const on = isFollowing(uid);
    const action = me
      ? `<span class="row-chip">You</span>`
      : `<button class="act ${on ? "joined" : "primary"}" onclick="event.stopPropagation(); window.toggleFollowInList('${id}')">${on ? "Following" : "Follow"}</button>`;
    return `
      <div class="orbit-row" onclick="window.closeFollowList(); window.openProfileScreen('${id}')">
        <div class="chat-avatar" style="width:44px;height:44px;font-size:19px;">${renderAvatar(avatarFor(uid))}</div>
        <div class="result-text">
          <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
          <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
        </div>
        <div class="orbit-row-actions">${action}</div>
      </div>`;
  }).join("");
}
