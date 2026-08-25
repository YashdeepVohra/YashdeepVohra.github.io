// ==========================================
// CENTRAL APPLICATION STATE
// ==========================================
export const state = {
  // Current User Data
  user: "",
  userEmail: "",
  userAvatar: "👤",
  userDisplayName: "",
  googlePfp: "",
  realName: "",
  userCache: {},

  // Active Chat State
  currentChat: null,
  currentChatType: "direct",
  currentChatStatus: "unlocked",
  currentChatInitiator: "",
  currentChatData: null,
  currentOtherUser: "",
  replyingToMessage: null,
  myMessageCount: 0,
  
  // Active Event / Screen State
  currentEventData: null,
  currentSelectedTag: '☕ Chill',
  currentLiveFilter: 'All',
  currentRecapFilter: 'All',
  currentProfileView: "",
  pendingSettingsAvatar: null,
  eventIdToManage: null,

  // Listeners & Timers
  messagesUnsubscribe: null,
  chatDocUnsubscribe: null,
  profileEventsUnsubscribe: null,
  typingTimer: null,
  scrollTimeout: null,
  lastTapTime: 0
};
