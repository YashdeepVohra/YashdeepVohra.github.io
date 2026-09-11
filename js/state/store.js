// ==========================================
// CENTRAL APPLICATION STATE
// ==========================================
//
// IDENTITY MODEL
// --------------
// `uid` is the Firebase Auth UID and is the ONLY identity the database
// trusts. Every ownership field in Firestore stores a uid, because
// security rules can verify `request.auth.uid` for free but cannot
// verify a username without an extra document lookup.
//
// `username` is a display handle only. It is never used as a key, a
// document id, or an ownership field.
// ==========================================

export const state = {
  // ---- Current user (identity) ----
  uid: "",                 // Firebase Auth UID — the real identity
  username: "",            // public handle, display only
  userEmail: "",           // kept in memory only, never written to a public doc
  userDisplayName: "",
  userAvatar: "\u{1F464}",
  googlePfp: "",

  // ---- Caches ----
  userCache: {},           // uid -> { username, displayName, avatar }
  blockedUids: [],         // blocked in EITHER direction — always hidden
  eventCache: {},          // eventId -> event data (avoids passing text through inline HTML)
  eventOrder: [],          // eventIds, newest first

  // ---- Active chat ----
  currentChat: null,       // chatId (direct) or eventId (event chat)
  currentChatType: "direct",
  currentChatStatus: "unlocked",
  currentChatInitiatorUid: "",
  currentChatData: null,
  currentOtherUid: "",
  replyingToMessage: null,
  myMessageCount: 0,

  // ---- Events / screens ----
  currentEventData: null,
  eventTypingUids: [],
  currentSelectedTag: "☕ Chill",
  currentLiveFilter: "All",
  currentRecapFilter: "All",
  currentProfileUid: "",
  pendingSettingsAvatar: null,
  eventIdToManage: null,
  editingEventId: null,

  // ---- Listeners & timers ----
  messagesUnsubscribe: null,
  chatDocUnsubscribe: null,
  typingUnsubscribe: null,
  chatListUnsubscribe: null,
  blocksUnsubscribe: null,
  eventsUnsubscribe: null,
  profileEventsUnsubscribe: null,
  typingTimer: null,
  scrollTimeout: null,
  lastTapTime: 0
};

// Wipe per-user state on logout so nothing leaks into the next session
// if a student signs in on a shared laptop.
export function resetState() {
  [
    state.messagesUnsubscribe,
    state.chatDocUnsubscribe,
    state.typingUnsubscribe,
    state.chatListUnsubscribe,
    state.blocksUnsubscribe,
    state.eventsUnsubscribe,
    state.profileEventsUnsubscribe
  ].forEach((unsub) => { if (typeof unsub === "function") unsub(); });

  state.uid = "";
  state.username = "";
  state.userEmail = "";
  state.userDisplayName = "";
  state.userAvatar = "\u{1F464}";
  state.googlePfp = "";
  state.userCache = {};
  state.blockedUids = [];
  state.eventCache = {};
  state.eventOrder = [];
  state.currentChat = null;
  state.currentChatData = null;
  state.currentOtherUid = "";
  state.currentProfileUid = "";
  state.replyingToMessage = null;
  state.messagesUnsubscribe = null;
  state.chatDocUnsubscribe = null;
  state.typingUnsubscribe = null;
  state.eventTypingUids = [];
  state.chatListUnsubscribe = null;
  state.blocksUnsubscribe = null;
  state.eventsUnsubscribe = null;
  state.profileEventsUnsubscribe = null;
}
