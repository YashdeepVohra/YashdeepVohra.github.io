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
import { switchScreen, showTab } from '../utils/ui.js';
import { focusEvent } from './eventsService.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { closeChat, startChatWithUid } from './chatService.js';
import { fetchUser, displayNameFor, usernameFor, avatarFor, rememberUser } from './userService.js';
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

export function openProfileScreen(targetUid = null) {
  const uid = safeId(targetUid) || state.uid;

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

export function closeProfileScreen() {
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
  const eventsList = document.getElementById("myProfileEvents");

  // Placeholders while we fetch. innerText everywhere: no markup path.
  if (avatarEl) avatarEl.innerHTML = renderAvatar("\u{1F464}");
  if (nameDisplay) nameDisplay.innerText = "Loading...";
  if (usernameDisplay) usernameDisplay.innerText = "";
  if (statJoined) statJoined.innerText = "-";
  if (statHosted) statHosted.innerText = "-";
  if (eventsList) {
    eventsList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size: 13px;"><i class='bx bx-loader-alt bx-spin'></i> Loading...</div>`;
  }

  const isSelf = targetUid === state.uid;
  settingsGear?.classList.toggle("hidden", !isSelf);
  renderSafetyActions(targetUid, isSelf);

  try {
    await fetchUser(targetUid, { force: true });
    if (state.currentProfileUid !== targetUid) return;

    if (avatarEl) avatarEl.innerHTML = renderAvatar(avatarFor(targetUid));
    if (nameDisplay) nameDisplay.innerText = displayNameFor(targetUid);
    if (usernameDisplay) usernameDisplay.innerText = "@" + usernameFor(targetUid);

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

  if (!newName) return alert("Display Name cannot be empty!");
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
    alert(
      e.code === "permission-denied"
        ? "Firestore rejected the save. Check your security rules."
        : "Failed to save profile."
    );
    if (btn) {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }
}


/* ---------------------------------------------------------------------
   Safety actions
   ------------------------------------------------------------------- */

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

export function confirmBlock(targetUid) {
  const name = displayNameFor(targetUid);
  if (!window.confirm(`Block ${name}?\n\nYou won't see each other anywhere — not in the feed, not in messages, and neither of you can join the other's events. They are not told.`)) return;

  blockUser(targetUid).then((ok) => {
    if (!ok) return alert("Couldn't block right now. Check your connection.");
    // The blocks listener re-renders everything; just leave the profile.
    closeProfileScreen();
  });
}

export function confirmUnblock(targetUid) {
  const name = displayNameFor(targetUid);
  if (!window.confirm(`Unblock ${name}? You'll both be able to see and message each other again.`)) return;
  unblockUser(targetUid).then((ok) => {
    if (!ok) return alert("Couldn't unblock right now.");
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

  if (!ok) return alert("Couldn't send the report. Check your connection.");

  if (window.confirm("Report sent — thank you. Do you also want to block this person?")) {
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
