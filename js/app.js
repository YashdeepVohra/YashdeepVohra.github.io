// ==========================================
// MAIN ENTRY POINT
// ==========================================
// Loaded from index.html as <script type="module" src="js/app.js">.
// Modules are deferred by definition, so the Firebase compat scripts in
// <head> have already run by the time this executes.
// ==========================================

import { auth } from './config/firebase.js';
import { state } from './state/store.js';
import { switchScreen, showTab, toggleTime, setLoading } from './utils/ui.js';

import {
  loginWithGoogle,
  claimUsername,
  checkUsernameAvailability,
  logout,
  initAuthListener,
  checkRedirectLock,
  describeAuthError
} from './services/authService.js';

import {
  addEvent,
  joinEvent,
  leaveEvent,
  toggleHype,
  selectTag,
  setLiveFilter,
  setRecapFilter,
  jumpToVibe,
  focusEvent,
  toggleEventDesc,
  openCreateScreen,
  closeCreateScreen,
  openDeleteModal,
  closeDeleteModal,
  confirmMoveToRecap,
  confirmDeletePermanently
} from './services/eventsService.js';

import {
  startChat,
  startChatWithUid,
  openChat,
  closeChat,
  openEventChat,
  sendMessage,
  handleTyping,
  cancelReply,
  handleMessageTap
} from './services/chatService.js';

import {
  openProfileScreen,
  closeProfileScreen,
  openProfileModal,
  closeProfileModal,
  selectAvatar,
  openSettingsScreen,
  closeSettingsScreen,
  selectSettingsAvatar,
  saveProfileData
} from './services/profileService.js';

import { initSwipeListeners } from './interactions/swipeReply.js';
import { initViewportFit } from './utils/viewport.js';

// ==========================================
// EXPOSE TO WINDOW FOR INLINE HTML HANDLERS
// ==========================================
// Only these functions are reachable from markup. Every one of them
// takes either no argument or an id (uid / document id) — never a piece
// of user-typed text.
/**
 * Tapping a tab is an escape hatch: it must work from anywhere. Chat
 * and profile are full-screen layers, so they have to be dismissed
 * first or the tab switches invisibly behind them.
 */
function goToTab(tab) {
  if (state.currentChat) closeChat({ silent: true });
  if (state.currentProfileUid) closeProfileScreen();
  switchScreen("home");
  document.querySelector(".topbar")?.classList.remove("hidden");
  showTab(tab);
}

Object.assign(window, {
  // Navigation
  switchScreen,
  showTab: goToTab,

  // Auth
  loginWithGoogle,
  checkUsernameAvailability,
  claimUsername,
  logout,

  // Events
  selectTag,
  setLiveFilter,
  setRecapFilter,
  jumpToVibe,
  focusEvent,
  toggleEventDesc,
  openCreateScreen,
  closeCreateScreen,
  addEvent,
  joinEvent,
  leaveEvent,
  toggleHype,
  openDeleteModal,
  closeDeleteModal,
  confirmMoveToRecap,
  confirmDeletePermanently,

  // Chat
  startChat,
  startChatWithUid,
  openChat,
  closeChat,
  openEventChat,
  sendMessage,
  handleTyping,
  cancelReply,
  handleMessageTap,
  toggleTime,

  // Profile
  openProfileScreen,
  closeProfileScreen,
  openProfileModal,
  closeProfileModal,
  selectAvatar,
  openSettingsScreen,
  closeSettingsScreen,
  selectSettingsAvatar,
  saveProfileData
});

// ==========================================
// BOOTSTRAP
// ==========================================
function boot() {
  window.__livesociyaBooted = true;
  checkRedirectLock();
  initAuthListener();
  initSwipeListeners();
  initViewportFit();

  document.getElementById("login-btn")?.addEventListener("click", () => loginWithGoogle());

  document.getElementById("claimBtn")?.addEventListener("click", async () => {
    setLoading(true);
    await claimUsername();
  });

  document.getElementById("newUsername")?.addEventListener("input", checkUsernameAvailability);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// Firebase throws some failures as unhandled promise rejections that no
// callback of ours ever sees. Catch them so the user gets a readable
// reason instead of a spinner that never stops.
window.addEventListener("unhandledrejection", (event) => {
  const code = String(event.reason?.code || event.reason?.message || "");
  if (!code.includes("auth/") && !code.includes("Firebase")) return;

  console.error("Unhandled Firebase error:", code);
  setLoading(false);

  const detail = document.getElementById("boot-error-detail");
  const box = document.getElementById("boot-error");
  if (detail && box) {
    detail.innerText = describeAuthError(event.reason);
    box.classList.remove("hidden");
  }
});

// Ask for desktop notifications on the first interaction, once.
document.addEventListener("click", () => {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}, { once: true });

// Native back button: close chat, then profile, then trap at home.
window.addEventListener("popstate", () => {
  if (state.currentChat) {
    closeChat();
  } else if (state.currentProfileUid) {
    closeProfileScreen();
  } else if (auth.currentUser) {
    history.pushState(null, "", window.location.href);
  }
});
