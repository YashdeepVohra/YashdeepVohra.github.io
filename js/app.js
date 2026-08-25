// ==========================================
// MAIN ENTRY POINT
// ==========================================
import { auth } from './config/firebase.js';
import { state } from './state/store.js';
import { switchScreen, showTab, toggleTime } from './utils/ui.js';
import { 
  loginWithGoogle, 
  claimUsername, 
  checkUsernameAvailability, 
  logout, 
  initAuthListener, 
  checkRedirectLock 
} from './services/authService.js';
import { 
  addEvent, 
  joinEvent, 
  leaveEvent, 
  toggleHype, 
  selectTag, 
  setLiveFilter, 
  setRecapFilter, 
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

// ==========================================
// EXPOSE FUNCTIONS TO WINDOW FOR INLINE HTML
// ==========================================
window.switchScreen = switchScreen;
window.showTab = showTab;
window.loginWithGoogle = loginWithGoogle;
window.checkUsernameAvailability = checkUsernameAvailability;
window.claimUsername = claimUsername;
window.logout = logout;

// Event Functions
window.selectTag = selectTag;
window.setLiveFilter = setLiveFilter;
window.setRecapFilter = setRecapFilter;
window.toggleEventDesc = toggleEventDesc;
window.openCreateScreen = openCreateScreen;
window.closeCreateScreen = closeCreateScreen;
window.addEvent = addEvent;
window.joinEvent = joinEvent;
window.leaveEvent = leaveEvent;
window.toggleHype = toggleHype;
window.openDeleteModal = openDeleteModal;
window.closeDeleteModal = closeDeleteModal;
window.confirmMoveToRecap = confirmMoveToRecap;
window.confirmDeletePermanently = confirmDeletePermanently;

// Chat Functions
window.startChat = startChat;
window.openChat = openChat;
window.closeChat = closeChat;
window.openEventChat = openEventChat;
window.sendMessage = sendMessage;
window.handleTyping = handleTyping;
window.cancelReply = cancelReply;
window.handleMessageTap = handleMessageTap;
window.toggleTime = toggleTime;

// Profile Functions
window.openProfileScreen = openProfileScreen;
window.closeProfileScreen = closeProfileScreen;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.selectAvatar = selectAvatar;
window.openSettingsScreen = openSettingsScreen;
window.closeSettingsScreen = closeSettingsScreen;
window.selectSettingsAvatar = selectSettingsAvatar;
window.saveProfileData = saveProfileData;

// ==========================================
// BOOTSTRAP APP & LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  checkRedirectLock();
  initAuthListener();
  initSwipeListeners();

  const loginBtn = document.getElementById("login-btn");
  if (loginBtn) loginBtn.addEventListener("click", () => loginWithGoogle());

  const claimBtn = document.getElementById("claimBtn");
  if (claimBtn) claimBtn.addEventListener("click", async () => {
    const loadingScreen = document.getElementById("loading-screen");
    if (loadingScreen) loadingScreen.classList.remove("hidden");
    await claimUsername();
  });
});

// Desktop Notification Unlocker
document.addEventListener("click", () => {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") console.log("Desktop notifications enabled!");
    });
  }
}, { once: true });

// Stealth Native Back Button Engine
window.addEventListener('popstate', () => {
  if (state.currentChat) {
    closeChat();
  } else if (state.currentProfileView && state.currentProfileView !== "") {
    closeProfileScreen();
  } else if (auth.currentUser) {
    history.pushState(null, '', window.location.href);
  }
});
