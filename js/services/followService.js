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
import { safeId } from '../utils/formatters.js';
import { isBlocked } from './blockService.js';
import { fetchUser, displayNameFor } from './userService.js';
import { toast } from '../utils/ui.js';

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
 * Follow or unfollow. Two writes: their list, then mine. Mine goes
 * second so that if the connection drops between them, the visible,
 * public number is the one that stayed correct.
 */
export async function toggleFollow(targetUid, onDone) {
  const uid = safeId(targetUid);
  if (!uid || uid === state.uid) return;
  if (isBlocked(uid)) return toast("You can't do that with someone you've blocked.");

  const on = isFollowing(uid);

  // Optimistic: the button flips now, the network catches up.
  state.following = on
    ? state.following.filter((u) => u !== uid)
    : state.following.concat([uid]);
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
    if (!on) toast("Following " + displayNameFor(uid));
  } catch (e) {
    console.error("Follow failed:", e.code || e.message);
    // Put it back the way it was.
    state.following = on
      ? state.following.concat([uid])
      : state.following.filter((u) => u !== uid);
    toast("Couldn't save that. Check your connection.");
  }
  if (typeof onDone === "function") onDone();
}
