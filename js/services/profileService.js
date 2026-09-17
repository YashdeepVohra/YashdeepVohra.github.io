// ==========================================
// PROFILES & SETTINGS
// ==========================================
//
// A profile is addressed by uid, never by username. The handle is only
// ever rendered as text.
// ==========================================

import { auth, db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar, escapeHtml, safeId } from '../utils/formatters.js';
import { switchScreen, showTab, toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { focusEvent } from './eventsService.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { closeChat, startChatWithUid } from './chatService.js';
import { fetchUser, displayNameFor, usernameFor, avatarFor, rememberUser } from './userService.js';
import {
  orbitStatus, inOrbit, hasVouched, vouchCount, vouchersYouKnow, renderOrbitRings
} from './orbitService.js';
import {
  isFollowing, followerCount, followingCount,
  isPrivateAccount, hasAskedToFollow, myFollowRequests, syncPrivacyUI
} from './followService.js';
import { isBlocked, blockUser, unblockUser, submitReport, myBlockList } from './blockService.js';

// The avatar picker only ever writes one of these, or the Google photo.
const ALLOWED_AVATARS = ["\u{1F98A}", "\u{1F43C}", "\u{1F42F}", "\u{1F438}", "\u{1F436}", "\u{1F431}", "\u{1F984}", "\u{1F47D}", "\u{1F47B}"];

export function openProfileModal() { openOverlay("profileModal"); }
export function closeProfileModal() { closeOverlay("profileModal"); }

function applyAvatarEverywhere(avatar) {
  ["topAvatar", "profileAvatarDisplay", "profileLargeAvatar", "sideAvatar"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = renderAvatar(avatar);
  });
}

export function selectAvatar(element, type) {
  const newAvatar = type === "google" ? state.googlePfp : type;
  if (type !== "google" && !ALLOWED_AVATARS.includes(type)) return;

  db.collection("users").doc(state.uid)
    .set({ avatar: newAvatar, updatedAt: Date.now() }, { merge: true })
    .catch((e) => console.error("Avatar save failed:", e.code || e.message));

  state.userAvatar = newAvatar;
  if (state.userCache[state.uid]) {
    state.userCache[state.uid].avatar = newAvatar;
    rememberUser(state.uid, state.userCache[state.uid]);
  }
  applyAvatarEverywhere(newAvatar);
  closeProfileModal();
}

/**
 * Where you were before this profile.
 *
 * Profiles chain: a follower list leads to somebody's profile, whose
 * orbit leads to another. The profile screen is one screen, not a
 * stack, so back used to drop you all the way to the feed from three
 * profiles deep. Each hop remembers the one before it, and back walks
 * them in order — which matches the history entry each hop pushed.
 */
const profileTrail = [];

export function openProfileScreen(targetUid = null) {
  const uid = safeId(targetUid) || state.uid;

  const alreadyOnAProfile = !document
    .getElementById("profileScreen")
    ?.classList.contains("hidden");
  if (alreadyOnAProfile && state.currentProfileUid && state.currentProfileUid !== uid) {
    profileTrail.push(state.currentProfileUid);
  }

  // A profile opened from a chat used to render UNDERNEATH it — the
  // chat sits at a higher layer — so nothing appeared to happen, and
  // the profile was then left stranded once the chat closed. Tear the
  // chat down first and let switchScreen own the swap.
  if (state.currentChat) closeChat({ silent: true });

  state.currentProfileUid = uid;
  switchScreen("profileScreen");
  document.querySelector(".topbar")?.classList.remove("hidden");
  history.pushState({ screen: "profile" }, "", window.location.href);
  loadProfileUI(uid);
}

/**
 * Back out of a profile. One step at a time along the trail; `all`
 * leaves for good, which is what a tab tap wants.
 */
export function closeProfileScreen({ all = false } = {}) {
  if (!all && profileTrail.length) {
    const previous = profileTrail.pop();
    state.currentProfileUid = previous;
    loadProfileUI(previous);
    return;
  }

  profileTrail.length = 0;
  if (state.profileEventsUnsubscribe) {
    state.profileEventsUnsubscribe();
    state.profileEventsUnsubscribe = null;
  }
  state.currentProfileUid = "";
  switchScreen("home");
}

export function loadUserEvents(targetUid) {
  const list = document.getElementById("myProfileEvents");
  if (!list) return;

  if (state.profileEventsUnsubscribe) state.profileEventsUnsubscribe();

  state.profileEventsUnsubscribe = db
    .collection("events")
    .where("hostUid", "==", targetUid)
    .onSnapshot(
      (snapshot) => {
        if (state.currentProfileUid !== targetUid) return;

        const events = [];
        snapshot.forEach((doc) => events.push({ id: doc.id, ...doc.data() }));
        events.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

        if (!events.length) {
          list.innerHTML = `<div class="empty-state" style="padding: 20px;"><i class='bx bx-ghost'></i><p>No hosted events yet.</p></div>`;
          return;
        }

        // Tapping one takes you to it in the feed — these used to be
        // inert, which made the profile a dead end.
        list.innerHTML = events.map((e) => {
          const id = safeId(e.id);
          const live = e.expiresAt > Date.now();
          return `
          <button class="card profile-event-row${id ? " tappable" : ""}" ${id ? `onclick="window.jumpToEvent('${id}')"` : ""}>
            <div class="result-text">
              <div class="result-title">${escapeHtml(e.title)}</div>
              <div class="result-sub"><i class='bx bx-map-pin'></i> ${escapeHtml(e.place)}</div>
            </div>
            ${live ? `<span class="status-chip live"><span class="live-dot"></span> Live</span>` : `<span class="status-chip soon">Ended</span>`}
          </button>`;
        }).join("");
      },
      (error) => console.error("Profile events error:", error.code || error.message)
    );
}

export async function loadProfileUI(targetUid) {
  if (!safeId(targetUid)) return;

  const avatarEl = document.getElementById("profileAvatarDisplay");
  const nameDisplay = document.getElementById("profileDisplayNameDisplay");
  const usernameDisplay = document.getElementById("profileUsernameDisplay");
  const settingsGear = document.getElementById("profileSettingsBtn");
  const editInput = document.getElementById("editDisplayNameInput");
  const statJoined = document.getElementById("statEventsJoined");
  const statHosted = document.getElementById("statEventsHosted");
  const statVouches = document.getElementById("statVouches");
  const statFollowers = document.getElementById("statFollowers");
  const statFollowing = document.getElementById("statFollowing");
  const eventsList = document.getElementById("myProfileEvents");

  // Placeholders while we fetch. innerText everywhere: no markup path.
  if (avatarEl) avatarEl.innerHTML = renderAvatar("\u{1F464}");
  if (nameDisplay) nameDisplay.innerText = "Loading...";
  if (usernameDisplay) usernameDisplay.innerText = "";
  if (statJoined) statJoined.innerText = "-";
  if (statHosted) statHosted.innerText = "-";
  if (statVouches) statVouches.innerText = "-";
  if (statFollowers) statFollowers.innerText = "-";
  if (statFollowing) statFollowing.innerText = "-";
  if (eventsList) {
    eventsList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size: 13px;"><i class='bx bx-loader-alt bx-spin'></i> Loading...</div>`;
  }

  const isSelf = targetUid === state.uid;
  settingsGear?.classList.toggle("hidden", !isSelf);
  renderSafetyActions(targetUid, isSelf);
  renderOrbitActions(targetUid, isSelf);

  try {
    await fetchUser(targetUid, { force: true });
    if (state.currentProfileUid !== targetUid) return;

    if (avatarEl) avatarEl.innerHTML = renderAvatar(avatarFor(targetUid));
    if (nameDisplay) nameDisplay.innerText = displayNameFor(targetUid);
    if (usernameDisplay) usernameDisplay.innerText = "@" + usernameFor(targetUid);
    renderOrbitActions(targetUid, isSelf);

    refreshProfileSocial(targetUid);

    if (isSelf) {
      state.userDisplayName = displayNameFor(targetUid);
      state.userAvatar = avatarFor(targetUid);
      if (editInput) editInput.value = state.userDisplayName;
    }

    db.collection("events").where("hostUid", "==", targetUid).get()
      .then((snap) => { if (statHosted) statHosted.innerText = snap.size || 0; })
      .catch(() => { if (statHosted) statHosted.innerText = "0"; });

    db.collection("events").where("participantUids", "array-contains", targetUid).get()
      .then((snap) => { if (statJoined) statJoined.innerText = snap.size || 0; })
      .catch(() => { if (statJoined) statJoined.innerText = "0"; });

    loadUserEvents(targetUid);
  } catch (e) {
    console.error("Profile load error:", e.code || e.message);
    if (nameDisplay) nameDisplay.innerText = "Could not load profile";
  }
}

// ---------- Settings ----------
export function openSettingsScreen() {
  openOverlay("settingsScreen");
  refreshBlockedList();
  syncPrivacyUI();

  const nameInput = document.getElementById("editDisplayNameInput");
  if (nameInput) nameInput.value = state.userDisplayName || displayNameFor(state.uid);

  state.pendingSettingsAvatar = state.userAvatar;
  document.querySelectorAll("#settingsAvatarGrid .avatar-option").forEach((el) => {
    el.classList.toggle("selected", el.innerText === state.userAvatar);
  });
}

export function closeSettingsScreen() {
  closeOverlay("settingsScreen");
}

export function selectSettingsAvatar(element, avatarChoice) {
  document.querySelectorAll("#settingsAvatarGrid .avatar-option").forEach((el) => el.classList.remove("selected"));

  if (avatarChoice === "google") {
    state.pendingSettingsAvatar = auth.currentUser?.photoURL || state.googlePfp || "\u{1F464}";
    const originalText = element.innerHTML;
    element.innerHTML = "<i class='bx bx-check'></i> Selected!";
    setTimeout(() => { element.innerHTML = originalText; }, 1500);
    return;
  }

  if (!ALLOWED_AVATARS.includes(avatarChoice)) return;
  state.pendingSettingsAvatar = avatarChoice;
  element.classList.add("selected");
}

export async function saveProfileData() {
  const nameInput = document.getElementById("editDisplayNameInput");
  const btn = document.getElementById("saveProfileBtn");
  const newName = (nameInput?.value || "").trim().slice(0, 20);

  if (!newName) return toast("Your display name can't be empty.");
  if (!auth.currentUser) return;

  const originalText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
    btn.disabled = true;
  }

  try {
    const avatar = state.pendingSettingsAvatar || state.userAvatar;

    // Note: `username` is deliberately absent. Handles are immutable —
    // the rules reject any attempt to change one after it is claimed.
    await db.collection("users").doc(state.uid).set({
      displayName: newName,
      avatar,
      updatedAt: Date.now()
    }, { merge: true });

    state.userDisplayName = newName;
    state.userAvatar = avatar;
    if (state.userCache[state.uid]) {
      state.userCache[state.uid].displayName = newName;
      state.userCache[state.uid].avatar = avatar;
      rememberUser(state.uid, state.userCache[state.uid]);
    }

    const displayEl = document.getElementById("profileDisplayNameDisplay");
    if (displayEl) displayEl.innerText = newName;
    const sideNameEl = document.getElementById("sideName");
    if (sideNameEl) sideNameEl.innerText = newName;
    applyAvatarEverywhere(avatar);

    if (btn) {
      btn.style.background = "var(--periwinkle)";
      btn.innerHTML = `<i class='bx bx-check'></i> Saved!`;
      setTimeout(() => {
        btn.style.background = "";
        btn.innerHTML = originalText;
        btn.disabled = false;
        closeSettingsScreen();
      }, 800);
    }
  } catch (e) {
    console.error("Profile save error:", e.code, e.message);
    toast(e.code === "permission-denied"
      ? "That change wasn't allowed. Try again."
      : "Couldn't save your profile.");
    if (btn) {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }
}


/* ---------------------------------------------------------------------
   Safety actions
   ------------------------------------------------------------------- */

/**
 * The three numbers, and the follow button. Split out so following
 * somebody can update the profile in place instead of reloading it.
 *
 * Followers is the one that carries weight: the rules let only the
 * follower write their own uid into it, so it is the single social
 * number on a profile that its owner could not have inflated. Vouches
 * sits beside it as the stronger, rarer version of the same idea.
 */
export function refreshProfileSocial(targetUid) {
  if (!targetUid || state.currentProfileUid !== targetUid) return;

  const followers = document.getElementById("statFollowers");
  const following = document.getElementById("statFollowing");
  const vouches = document.getElementById("statVouches");

  if (followers) followers.innerText = followerCount(targetUid);
  if (following) following.innerText = followingCount(targetUid);
  if (vouches) vouches.innerText = vouchCount(targetUid);

  renderOrbitActions(targetUid, targetUid === state.uid);
}

/**
 * The orbit half of a profile. On your own it is the rings and a way
 * into the Orbit screen; on someone else's it is where you stand with
 * them, their vouches, and — once you are linked — your own vouch.
 */
export function renderOrbitActions(targetUid, isSelf) {
  const host = document.getElementById("profileOrbit");
  const rings = document.getElementById("profileRings");
  if (!host) return;

  const id = safeId(targetUid);
  if (!id) return;

  const requestsHost = document.getElementById("profileRequests");
  if (requestsHost) {
    const waitingToFollow = isSelf ? myFollowRequests().length : 0;
    requestsHost.classList.toggle("hidden", !waitingToFollow);
    requestsHost.innerHTML = waitingToFollow
      ? `<button class="orbit-cta" onclick="window.openProfileList('requests')">
           <i class='bx bx-user-voice'></i>
           <span class="orbit-cta-text">
             <b>${waitingToFollow} ${waitingToFollow === 1 ? "person wants" : "people want"} to follow you</b>
             <small>Your account is private, so they're waiting on you</small>
           </span>
           <span class="orbit-count">${waitingToFollow}</span>
         </button>`
      : "";
  }

  if (isSelf) {
    const n = state.orbitUids.length;
    const waiting = state.orbitIncoming.length;
    host.classList.remove("hidden");
    host.innerHTML = `
      <button class="orbit-cta" onclick="window.openOrbitScreen()">
        <i class='bx bx-planet'></i>
        <span class="orbit-cta-text">
          <b>${n} in your orbit</b>
          <small>${waiting ? waiting + (waiting === 1 ? " request waiting" : " requests waiting") : "People you'd show up for"}</small>
        </span>
        ${waiting ? `<span class="orbit-count">${waiting}</span>` : `<i class='bx bx-chevron-right'></i>`}
      </button>`;
    renderOrbitRings(rings, state.orbitUids, n);
    return;
  }

  // Clear the stamp with the contents, or renderOrbitRings will think
  // its work is already on screen when it isn't.
  if (rings) {
    rings.innerHTML = "";
    rings.classList.add("hidden");
    delete rings.dataset.signature;
  }

  if (isBlocked(targetUid)) {
    host.innerHTML = "";
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");
  const status = orbitStatus(targetUid);
  const known = vouchersYouKnow(targetUid);
  const total = vouchCount(targetUid);

  // The light action sits next to the deliberate one: follow to keep
  // up with someone, orbit for the people you'd actually show up for.
  const following = isFollowing(targetUid);
  const asked = hasAskedToFollow(targetUid);
  let followLabel = "Follow";
  let followIcon = "bx-plus";
  let followClass = "primary";
  if (following) {
    followLabel = "Following"; followIcon = "bx-check"; followClass = "following";
  } else if (asked) {
    followLabel = "Requested"; followIcon = "bx-time-five"; followClass = "pending";
  } else if (isPrivateAccount(targetUid)) {
    followLabel = "Ask to follow"; followIcon = "bx-lock-open-alt";
  }
  const followBtn = `<button class="orbit-btn ${followClass}" onclick="window.toggleFollow('${id}')"><i class='bx ${followIcon}'></i> ${followLabel}</button>`;

  let action;
  if (status === "linked") {
    action = `<button class="orbit-btn linked" onclick="window.confirmLeaveOrbit('${id}')"><i class='bx bx-check-circle'></i> In your orbit</button>`;
  } else if (status === "outgoing") {
    action = `<button class="orbit-btn pending" onclick="window.declineOrbit('${id}')"><i class='bx bx-time-five'></i> Requested</button>`;
  } else if (status === "incoming") {
    action = `
      <button class="orbit-btn primary" onclick="window.acceptOrbit('${id}')"><i class='bx bx-user-check'></i> Accept</button>
      <button class="orbit-btn" onclick="window.declineOrbit('${id}')">Ignore</button>`;
  } else {
    action = `<button class="orbit-btn primary" onclick="window.pullIn('${id}')"><i class='bx bx-user-plus'></i> Pull into orbit</button>`;
  }

  // The trust line. "3 people you know" is worth far more here than a
  // raw total, so it leads, and the total only fills in behind it.
  let trust = "";
  if (known.length) {
    trust = `<div class="vouch-line strong"><i class='bx bxs-badge-check'></i> Vouched for by <b>${known.length}</b> ${known.length === 1 ? "person" : "people"} in your orbit</div>`;
  } else if (total) {
    trust = `<div class="vouch-line"><i class='bx bx-badge-check'></i> Vouched for by ${total} ${total === 1 ? "student" : "students"}</div>`;
  }

  const vouch = status === "linked"
    ? `<button class="orbit-btn ${hasVouched(targetUid) ? "vouched" : ""}" onclick="window.toggleVouch('${id}')"><i class='bx ${hasVouched(targetUid) ? "bxs-badge-check" : "bx-badge-check"}'></i> ${hasVouched(targetUid) ? "You vouched" : "Vouch for them"}</button>`
    : "";

  host.innerHTML = `<div class="orbit-actions">${followBtn}${action}</div>${vouch ? `<div class="orbit-actions second">${vouch}</div>` : ""}${trust}`;
}

/** Block / report controls, shown only on someone else's profile. */
function renderSafetyActions(targetUid, isSelf) {
  const host = document.getElementById("profileSafety");
  if (!host) return;

  if (isSelf) {
    host.innerHTML = "";
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");
  const blocked = isBlocked(targetUid);
  const id = safeId(targetUid);

  host.innerHTML = blocked
    ? `<p class="settings-hint">You've blocked this person. You won't see each other anywhere.</p>
       <button class="btn-ghost" onclick="window.confirmUnblock('${id}')"><i class='bx bx-user-check'></i> Unblock</button>`
    : `<button onclick="window.messageFromProfile('${id}')"><i class='bx bx-message-rounded-dots'></i> Message</button>
       <div class="safety-row">
         <button class="btn-ghost" onclick="window.openReport('${id}')"><i class='bx bx-flag'></i> Report</button>
         <button class="btn-ghost danger-text" onclick="window.confirmBlock('${id}')"><i class='bx bx-block'></i> Block</button>
       </div>`;
}

export async function confirmBlock(targetUid) {
  const name = displayNameFor(targetUid);
  const yes = await askConfirm({
    title: "Block " + name + "?",
    body: "You won't see each other anywhere — not in the feed, not in messages, and neither of you can join the other's events. They are never told.",
    confirm: "Block",
    danger: true
  });
  if (!yes) return;

  blockUser(targetUid).then((ok) => {
    if (!ok) return toast("Couldn't block right now. Check your connection.");
    // The blocks listener re-renders everything; just leave the profile.
    closeProfileScreen();
  });
}

export async function confirmUnblock(targetUid) {
  const name = displayNameFor(targetUid);
  const yes = await askConfirm({
    title: "Unblock " + name + "?",
    body: "You'll both be able to see and message each other again.",
    confirm: "Unblock"
  });
  if (!yes) return;
  unblockUser(targetUid).then((ok) => {
    if (!ok) return toast("Couldn't unblock right now.");
    renderSafetyActions(targetUid, false);
  });
}

/* ---------------------------------------------------------------------
   Reporting
   ------------------------------------------------------------------- */

const REPORT_REASONS = [
  "Harassment or bullying",
  "Threats or violence",
  "Sexual or explicit content",
  "Impersonation",
  "Spam or scam",
  "Something else"
];

export function openReport(targetUid) {
  const modal = document.getElementById("reportModal");
  if (!modal) return;

  modal.dataset.target = safeId(targetUid);
  const who = document.getElementById("reportWho");
  if (who) who.innerText = `@${usernameFor(targetUid)}`;

  const list = document.getElementById("reportReasons");
  if (list) {
    list.innerHTML = REPORT_REASONS.map((r, i) =>
      `<button class="reason-pill${i === 0 ? " selected" : ""}" onclick="window.pickReason(this)">${escapeHtml(r)}</button>`
    ).join("");
  }

  const note = document.getElementById("reportNote");
  if (note) note.value = "";
  openOverlay("reportModal");
}

export function closeReport() {
  closeOverlay("reportModal");
}

export function pickReason(el) {
  document.querySelectorAll("#reportReasons .reason-pill").forEach((p) => p.classList.remove("selected"));
  el.classList.add("selected");
}

export async function sendReport() {
  const modal = document.getElementById("reportModal");
  const btn = document.getElementById("reportSubmit");
  if (!modal) return;

  const targetUid = modal.dataset.target;
  const reason = document.querySelector("#reportReasons .reason-pill.selected")?.innerText || REPORT_REASONS[0];
  const note = document.getElementById("reportNote")?.value || "";

  if (btn) { btn.disabled = true; btn.innerHTML = "Sending..."; }

  const ok = await submitReport({ targetUid, reason, note });

  if (btn) { btn.disabled = false; btn.innerHTML = "Send report"; }
  closeReport();

  if (!ok) return toast("Couldn't send the report. Check your connection.");

  if (await askConfirm({
        title: "Report sent",
        body: "Thanks — the admin will take a look. Do you want to block this person as well?",
        confirm: "Block them too",
        cancel: "No thanks",
        danger: true
      })) {
    confirmBlock(targetUid);
  }
}

/* ---------------------------------------------------------------------
   Blocked list, in Settings, so a block can always be undone
   ------------------------------------------------------------------- */

export async function refreshBlockedList() {
  const box = document.getElementById("blockedList");
  if (!box) return;

  box.innerHTML = `<p class="settings-hint">Loading...</p>`;
  const uids = await myBlockList();

  if (!uids.length) {
    box.innerHTML = `<p class="settings-hint">You haven't blocked anyone.</p>`;
    return;
  }

  await Promise.all(uids.map((u) => fetchUser(u)));
  box.innerHTML = uids.map((uid) => {
    const id = safeId(uid);
    return `
      <div class="blocked-row">
        <div class="chat-avatar" style="width:34px;height:34px;font-size:16px;">${renderAvatar(avatarFor(uid))}</div>
        <div style="flex:1;min-width:0;">
          <div class="blocked-name">${escapeHtml(displayNameFor(uid))}</div>
          <div class="settings-hint" style="margin:0;">@${escapeHtml(usernameFor(uid))}</div>
        </div>
        <button class="btn-ghost" style="width:auto;padding:7px 14px;font-size:13px;" onclick="window.confirmUnblock('${id}')">Unblock</button>
      </div>`;
  }).join("");
}


/** Message someone from their profile. */
export function messageFromProfile(targetUid) {
  const uid = safeId(targetUid);
  if (!uid) return;
  closeProfileScreen();
  startChatWithUid(uid);
}


/** From a profile, jump to one of their events in the feed. */
export function jumpToEvent(eventId) {
  closeProfileScreen();
  setTimeout(() => {
    showTab("events");
    focusEvent(eventId);
  }, 80);
}
