import { auth, db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar } from '../utils/formatters.js';

export function openProfileModal() { document.getElementById("profileModal")?.classList.remove("hidden"); }
export function closeProfileModal() { document.getElementById("profileModal")?.classList.add("hidden"); }

export function selectAvatar(element, type) {
  let newAvatar = (type === 'google') ? state.googlePfp : type;
  db.collection("users").doc(state.userEmail).set({ avatar: newAvatar }, { merge: true });
  state.userAvatar = newAvatar;
  
  const topAvatar = document.getElementById("topAvatar");
  const profAvatar = document.getElementById("profileLargeAvatar");
  if (topAvatar) topAvatar.innerHTML = renderAvatar(state.userAvatar);
  if (profAvatar) profAvatar.innerHTML = renderAvatar(state.userAvatar);
  closeProfileModal();
}

export function openProfileScreen(targetUsername = null) {
  document.getElementById("home").classList.add("hidden");
  document.getElementById("profileScreen").classList.remove("hidden");
  history.pushState({ screen: 'profile' }, '', window.location.href);
  state.currentProfileView = targetUsername || state.user;
  loadProfileUI(state.currentProfileView);
}

export function closeProfileScreen() {
  document.getElementById("profileScreen").classList.add("hidden");
  document.getElementById("home").classList.remove("hidden");
  state.currentProfileView = "";
}

export function loadUserEvents(targetUser) {
  const list = document.getElementById("myProfileEvents");
  if (!list) return;

  if (state.profileEventsUnsubscribe) state.profileEventsUnsubscribe();

  state.profileEventsUnsubscribe = db.collection("events").where("user", "==", targetUser).onSnapshot(snapshot => {
    list.innerHTML = "";
    let eventsArray = [];
    snapshot.forEach(doc => eventsArray.push({ id: doc.id, ...doc.data() }));
    eventsArray.sort((a, b) => b.startTime - a.startTime);

    if (eventsArray.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding: 20px;"><i class='bx bx-ghost'></i><p>No hosted events yet.</p></div>`;
      return;
    }

    eventsArray.forEach(e => {
      list.innerHTML += `
        <div class="card" style="padding: 16px; margin-bottom: 12px; box-shadow: none; border: 1px solid var(--border);">
          <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">${e.title}</div>
          <div style="font-size: 12px; color: var(--text-muted);"><i class='bx bx-map'></i> ${e.place}</div>
        </div>
      `;
    });
  }, error => {
    console.error("Error loading events:", error);
  });
}

export async function loadProfileUI(targetUser) {
  if (!targetUser) return;

  const avatarEl = document.getElementById("profileAvatarDisplay");
  const nameDisplay = document.getElementById("profileDisplayNameDisplay");
  const usernameDisplay = document.getElementById("profileUsernameDisplay");
  const settingsGear = document.getElementById("profileSettingsBtn");
  const editInput = document.getElementById("editDisplayNameInput");

  if (avatarEl) avatarEl.innerHTML = renderAvatar("👤");
  if (nameDisplay) nameDisplay.innerText = "Loading...";
  if (usernameDisplay) usernameDisplay.innerText = targetUser;

  const statJoined = document.getElementById("statEventsJoined");
  const statHosted = document.getElementById("statEventsHosted");
  const eventsList = document.getElementById("myProfileEvents");

  if (statJoined) statJoined.innerText = "-";
  if (statHosted) statHosted.innerText = "-";
  if (eventsList) eventsList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size: 13px;"><i class='bx bx-loader-alt bx-spin'></i> Loading...</div>`;

  let cachedUser = state.userCache[targetUser];
  if (cachedUser) {
    if (avatarEl && cachedUser.avatar) avatarEl.innerHTML = renderAvatar(cachedUser.avatar);
    if (nameDisplay && cachedUser.displayName) nameDisplay.innerText = cachedUser.displayName;
  }

  if (targetUser === state.user) {
    settingsGear.classList.remove("hidden");
  } else {
    settingsGear.classList.add("hidden");
  }

  try {
    const userDoc = await db.collection("users").doc(targetUser).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      state.userCache[targetUser] = data;

      if (avatarEl) avatarEl.innerHTML = renderAvatar(data.avatar || "👤");
      if (nameDisplay) nameDisplay.innerText = data.displayName || targetUser;

      if (targetUser === state.user && editInput) {
        state.userDisplayName = data.displayName || targetUser;
        editInput.value = state.userDisplayName;
      }
    } else {
      if (nameDisplay) nameDisplay.innerText = targetUser;
    }

    db.collection("events").where("user", "==", targetUser).get().then(snap => {
      if (statHosted) statHosted.innerText = snap.size || 0;
    });
    db.collection("events").where("participants", "array-contains", targetUser).get().then(snap => {
      if (statJoined) statJoined.innerText = snap.size || 0;
    });

    loadUserEvents(targetUser);
  } catch (e) {
    console.error("Profile load error:", e);
  }
}

export function openSettingsScreen() {
  document.getElementById("settingsScreen")?.classList.remove("hidden");
  const nameInput = document.getElementById("editDisplayNameInput");
  if (nameInput) nameInput.value = document.getElementById("profileDisplayNameDisplay").innerText;

  state.pendingSettingsAvatar = state.userAvatar;
  document.querySelectorAll('#settingsAvatarGrid .avatar-option').forEach(el => {
    el.classList.remove('selected');
    if (el.innerText === state.userAvatar) el.classList.add('selected');
  });
}

export function closeSettingsScreen() {
  document.getElementById("settingsScreen")?.classList.add("hidden");
}

export function selectSettingsAvatar(element, avatarChoice) {
  document.querySelectorAll('#settingsAvatarGrid .avatar-option').forEach(el => el.classList.remove('selected'));

  if (avatarChoice === 'google') {
    state.pendingSettingsAvatar = auth.currentUser.photoURL;
    const originalText = element.innerHTML;
    element.innerHTML = "<i class='bx bx-check'></i> Selected!";
    setTimeout(() => element.innerHTML = originalText, 1500);
  } else {
    state.pendingSettingsAvatar = avatarChoice;
    element.classList.add('selected');
  }
}

export async function saveProfileData() {
  const nameInput = document.getElementById("editDisplayNameInput");
  const btn = document.getElementById("saveProfileBtn");
  const newName = nameInput.value.trim();

  if (!newName) return alert("Display Name cannot be empty!");

  const originalText = btn.innerHTML;
  btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
  btn.disabled = true;

  try {
    const updateData = {
      displayName: newName,
      avatar: state.pendingSettingsAvatar,
      updatedAt: Date.now(),
      uid: auth.currentUser.uid
    };

    await db.collection("users").doc(state.user).set(updateData, { merge: true });

    state.userDisplayName = newName;
    state.userAvatar = state.pendingSettingsAvatar;

    const displayEl = document.getElementById("profileDisplayNameDisplay");
    if (displayEl) displayEl.innerText = newName;

    const avatarDisplay = document.getElementById("profileAvatarDisplay");
    if (avatarDisplay) {
      avatarDisplay.innerHTML = state.pendingSettingsAvatar.startsWith('http')
        ? `<img src="${state.pendingSettingsAvatar}" alt="avatar" style="width:100%; height:100%; object-fit:cover;">`
        : state.pendingSettingsAvatar;
    }

    btn.style.background = "var(--success)";
    btn.innerHTML = `<i class='bx bx-check'></i> Saved!`;

    setTimeout(() => {
      btn.style.background = "var(--primary-gradient)";
      btn.innerHTML = originalText;
      btn.disabled = false;
      closeSettingsScreen();
    }, 800);
  } catch (e) {
    console.error("🚨 CRITICAL SAVE ERROR:", e.code, e.message);
    alert(e.code === 'permission-denied' ? "Firebase blocked the save: Permission Denied. Check your Firestore rules!" : "Failed to save profile.");
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}
