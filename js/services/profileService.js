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
import { fetchUser, displayNameFor, usernameFor, avatarFor } from './userService.js';

// The avatar picker only ever writes one of these, or the Google photo.
const ALLOWED_AVATARS = ["\u{1F98A}", "\u{1F43C}", "\u{1F42F}", "\u{1F438}", "\u{1F436}", "\u{1F431}", "\u{1F984}", "\u{1F47D}", "\u{1F47B}"];

export function openProfileModal() { document.getElementById("profileModal")?.classList.remove("hidden"); }
export function closeProfileModal() { document.getElementById("profileModal")?.classList.add("hidden"); }

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
  if (state.userCache[state.uid]) state.userCache[state.uid].avatar = newAvatar;
  applyAvatarEverywhere(newAvatar);
  closeProfileModal();
}

export function openProfileScreen(targetUid = null) {
  const uid = safeId(targetUid) || state.uid;
  document.getElementById("home")?.classList.add("hidden");
  document.getElementById("profileScreen")?.classList.remove("hidden");
  history.pushState({ screen: "profile" }, "", window.location.href);
  state.currentProfileUid = uid;
  loadProfileUI(uid);
}

export function closeProfileScreen() {
  if (state.profileEventsUnsubscribe) {
    state.profileEventsUnsubscribe();
    state.profileEventsUnsubscribe = null;
  }
  document.getElementById("profileScreen")?.classList.add("hidden");
  document.getElementById("home")?.classList.remove("hidden");
  state.currentProfileUid = "";
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

        list.innerHTML = events.map((e) => `
          <div class="card" style="padding: 16px 20px; margin-bottom: 12px; border-radius: 20px;">
            <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">${escapeHtml(e.title)}</div>
            <div style="font-size: 12px; color: var(--text-muted);"><i class='bx bx-map'></i> ${escapeHtml(e.place)}</div>
          </div>`).join("");
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
  document.getElementById("settingsScreen")?.classList.remove("hidden");

  const nameInput = document.getElementById("editDisplayNameInput");
  if (nameInput) nameInput.value = state.userDisplayName || displayNameFor(state.uid);

  state.pendingSettingsAvatar = state.userAvatar;
  document.querySelectorAll("#settingsAvatarGrid .avatar-option").forEach((el) => {
    el.classList.toggle("selected", el.innerText === state.userAvatar);
  });
}

export function closeSettingsScreen() {
  document.getElementById("settingsScreen")?.classList.add("hidden");
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
