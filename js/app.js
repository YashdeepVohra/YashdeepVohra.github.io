// ==========================================
// MAIN ENTRY POINT
// ==========================================
// Loaded from index.html as <script type="module" src="js/app.js">.
// Modules are deferred by definition, so the Firebase compat scripts in
// <head> have already run by the time this executes.
// ==========================================

import { auth } from './config/firebase.js';
import { state } from './state/store.js';
import { switchScreen, showTab, toggleTime, setLoading, onSocialChange } from './utils/ui.js';

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
  renderEvents,
  flushAllHype,
  addEvent,
  joinEvent,
  leaveEvent,
  requestJoin,
  cancelRequest,
  confirmAttendance,
  openPeople,
  closePeople,
  approveRequest,
  declineRequest,
  removeAttendee,
  openEditScreen,
  toggleHype,
  selectTag,
  setLiveFilter,
  setRecapFilter,
  jumpToVibe,
  focusEvent,
  loadRecap,
  ensureRecapLoaded,
  onRecapScroll,
  toggleEventDesc,
  openCreateScreen,
  closeCreateScreen,
  startSomething,
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
  handleMessageTap,
  onInboxSearch,
  clearInboxSearch
} from './services/chatService.js';

import {
  refreshProfileSocial,
  openProfileScreen,
  closeProfileScreen,
  openProfileModal,
  closeProfileModal,
  selectAvatar,
  openSettingsScreen,
  closeSettingsScreen,
  selectSettingsAvatar,
  saveProfileData,
  confirmBlock,
  confirmUnblock,
  openReport,
  closeReport,
  pickReason,
  sendReport,
  messageFromProfile,
  jumpToEvent,
  setProfileEventsTab
} from './services/profileService.js';

import {
  updateOrbitBadge,
  openOrbitScreen,
  closeOrbitScreen,
  pullIn,
  acceptRequest,
  removeOrbit,
  confirmLeaveOrbit,
  toggleVouch
} from './services/orbitService.js';

import {
  toggleFollow,
  toggleFollowInList,
  openFollowList,
  closeFollowList,
  answerFollowRequest,
  setPrivateAccount,
  syncPrivacyUI,
  removeFollower
} from './services/followService.js';

import { chooseAccountType } from './services/followService.js';
import { pickAccountType } from './services/authService.js';
import { confirmYes, confirmNo } from './utils/confirm.js';

import { initSwipeListeners } from './interactions/swipeReply.js';
import { initViewportFit } from './utils/viewport.js';
import { popOverlay, anyOverlayOpen, clearOverlays } from './utils/overlays.js';
import { openSearch, closeSearch, onSearchInput, searchOpenProfile, searchOpenEvent, refreshSearchResults } from './interactions/searchUI.js';

// ==========================================
// EXPOSE TO WINDOW FOR INLINE HTML HANDLERS
// ==========================================
// Only these functions are reachable from markup. Every one of them
// takes either no argument or an id (uid / document id) — never a piece
// of user-typed text.
/** The manage sheet acts on whichever event opened it. */
function editManagedEvent() {
  const id = state.eventIdToManage;
  if (id) openEditScreen(id);
}
function peopleForManagedEvent() {
  const id = state.eventIdToManage;
  if (id) openPeople(id);
}

/**
 * Tapping a tab is an escape hatch: it must work from anywhere. Chat
 * and profile are full-screen layers, so they have to be dismissed
 * first or the tab switches invisibly behind them.
 */
/** Follow from a profile, re-rendering that profile's controls. */
function followFromProfile(uid) {
  toggleFollow(uid, () => refreshProfileSocial(uid));
}

/** The three numbers on a profile open the people behind them. */
function openProfileList(kind) {
  openFollowList(state.currentProfileUid || state.uid, kind);
}

/** Approve or decline from the requests list, keeping it on screen. */
function answerRequest(uid, accept) {
  answerFollowRequest(uid, accept === true || accept === "true");
}

function togglePrivateAccount() {
  setPrivateAccount(!(state.isPrivate === true)).then(syncPrivacyUI);
}

function goToTab(tab) {
  clearOverlays();
  // Recap is only fetched the first time someone actually asks for it.
  if (tab === "recap") ensureRecapLoaded();
  if (state.currentChat) closeChat({ silent: true });
  if (state.currentProfileUid) closeProfileScreen({ all: true });
  switchScreen("home");
  document.querySelector(".topbar")?.classList.remove("hidden");
  showTab(tab);
}

Object.assign(window, {
  // The in-app replacement for window.confirm
  confirmYes,
  confirmNo,

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
  loadRecap,
  ensureRecapLoaded,
  onRecapScroll,
  toggleEventDesc,
  openCreateScreen,
  closeCreateScreen,
  startSomething,
  addEvent,
  joinEvent,
  leaveEvent,
  requestJoin,
  cancelRequest,
  confirmAttendance,
  openPeople,
  closePeople,
  approveRequest,
  declineRequest,
  removeAttendee,
  openEditScreen,
  toggleHype,
  openDeleteModal,
  closeDeleteModal,
  editManagedEvent,
  peopleForManagedEvent,
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
  onInboxSearch,
  clearInboxSearch,

  // Search
  openSearch,
  closeSearch,
  onSearchInput,
  searchOpenProfile,
  searchOpenEvent,

  // Profile
  openProfileScreen,
  closeProfileScreen,
  openProfileModal,
  closeProfileModal,
  selectAvatar,
  openSettingsScreen,
  closeSettingsScreen,
  selectSettingsAvatar,
  saveProfileData,

  // Following
  toggleFollow: followFromProfile,
  toggleFollowInList,
  openProfileList,
  closeFollowList,
  answerFollowRequest: answerRequest,
  togglePrivateAccount,
  removeFollower: (uid) => removeFollower(uid),
  chooseAccountType,
  pickAccountType,

  // Orbit
  openOrbitScreen,
  closeOrbitScreen,
  pullIn,
  acceptOrbit: acceptRequest,
  // Declining a request, withdrawing one and leaving an orbit are the
  // same delete, so they are the same handler.
  declineOrbit: removeOrbit,
  confirmLeaveOrbit,
  toggleVouch,

  // Safety
  confirmBlock,
  confirmUnblock,
  openReport,
  closeReport,
  pickReason,
  sendReport,
  messageFromProfile,
  jumpToEvent,
  setProfileEventsTab
});

// ==========================================
// BOOTSTRAP
// ==========================================
function boot() {
  window.__livesociyaBooted = true;

  // Everything that shows who you follow or who is in your orbit
  // repaints together. Registered here because this is the only module
  // that already imports all of them.
  onSocialChange(renderEvents);
  onSocialChange(updateOrbitBadge);
  onSocialChange(refreshSearchResults);
  onSocialChange(() => refreshProfileSocial(state.currentProfileUid));

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

  // The feed only repaints when something changes, so an event that
  // ENDS while somebody is looking at it just sat there in Live Now,
  // and "10m ago" quietly went stale. One tick a minute moves it to
  // Recap on its own. It costs nothing: renderEvents diffs, so a minute
  // where nothing changed touches no DOM and reads nothing.
  setInterval(() => {
    if (document.visibilityState === "visible" && state.uid) renderEvents();
  }, 60000);

  // Registering this is what lets a browser offer "add to home screen".
  // It caches nothing — see sw.js for why that is deliberate.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((e) => {
        console.warn("Install prompt unavailable:", e.message);
      });
    });
  }

  // A hype waits a moment before it is written, so anything still
  // waiting has to go when the app is put away — otherwise tapping and
  // immediately locking the phone would lose it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllHype();
  });
  window.addEventListener("pagehide", flushAllHype);

  // Page in more recap as it is scrolled, rather than all at once.
  const scroller = document.querySelector(".container");
  scroller?.addEventListener("scroll", () => {
    const recapOpen = !document.getElementById("recapTab")?.classList.contains("hidden");
    if (recapOpen) onRecapScroll(scroller);
  }, { passive: true });

  window.addEventListener("scroll", () => {
    const recapOpen = !document.getElementById("recapTab")?.classList.contains("hidden");
    if (!recapOpen) return;
    const doc = document.documentElement;
    if (doc.scrollTop + window.innerHeight > doc.scrollHeight - 320) loadRecap();
  }, { passive: true });
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
// Back unwinds one layer at a time: overlays (create, settings, search,
// modals) first, then chat, then profile, and finally traps at the feed
// so back never drops a signed-in student out of the app.
window.addEventListener("popstate", () => {
  if (popOverlay()) return;

  if (state.currentChat) {
    closeChat();
  } else if (state.currentProfileUid) {
    closeProfileScreen();
  } else if (auth.currentUser) {
    history.pushState(null, "", window.location.href);
  }
});

// Escape closes the top layer on desktop.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (anyOverlayOpen()) history.back();
});
