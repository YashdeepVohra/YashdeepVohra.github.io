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

  // ---- Orbit: who you'd actually show up for ----
  // One listener over orbit/{pairId} fills all three of these, so a
  // connection and a request waiting on you cost the same single query.
  following: [],           // uids I follow — my own list, from my user doc
  followRequests: [],      // uids waiting on me, when my account is private
  isPrivate: false,        // do I approve my followers?
  privacyChosen: false,    // has this account ever picked public or private?
  orbitUids: [],           // linked — both of you accepted
  orbitIncoming: [],       // uids who asked to join your orbit
  orbitOutgoing: [],       // uids you asked, still waiting
  eventCache: {},          // eventId -> event data (avoids passing text through inline HTML)
  eventOrder: [],          // live eventIds, newest first
  recapOrder: [],          // past eventIds, paged in on demand
  recapCursor: null,       // last doc of the previous recap page
  recapDone: false,
  recapLoading: false,

  // ---- Active chat ----
  // The pinned message in an event chat: a COPY (id, text, sender), so
  // the bar can paint without a second read for a message that has
  // usually scrolled out of the live window.
  pinnedMessage: null,
  currentChat: null,       // chatId (direct) or eventId (event chat)
  currentChatType: "direct",
  currentChatStatus: "unlocked",
  currentChatInitiatorUid: "",
  currentChatData: null,
  currentOtherUid: "",
  replyingToMessage: null,
  // Set while the composer is rewriting a message already sent, not
  // writing a new one: { id, text, time }. sendMessage() checks it
  // first, so the same box and the same Enter key do both jobs.
  editingMessage: null,
  // A long press opens the message sheet and the browser then fires a
  // click on the way up. Without this the sheet would open and the
  // tap underneath would toggle the timestamp at the same time.
  suppressNextTap: false,
  myMessageCount: 0,

  // Message paging: a small live window of the newest messages, plus
  // older pages fetched once on demand. Messages are immutable, so
  // older pages never need a listener.
  liveMessages: [],
  olderMessages: [],
  loadingOlder: false,
  noMoreMessages: false,

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
  pinnedUnsubscribe: null,
  // Who you talk to, newest conversation first. Kept by the inbox
 // listener so the share sheet can offer them without a second query.
  recentChatUids: [],

  chatListUnsubscribe: null,
  blocksUnsubscribe: null,
  orbitUnsubscribe: null,
  myProfileUnsubscribe: null,
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
    state.pinnedUnsubscribe,
    state.chatListUnsubscribe,
    state.blocksUnsubscribe,
    state.orbitUnsubscribe,
    state.myProfileUnsubscribe,
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
  state.following = [];
  state.followRequests = [];
  state.isPrivate = false;
  state.privacyChosen = false;
  state.orbitUids = [];
  state.orbitIncoming = [];
  state.orbitOutgoing = [];
  state.eventCache = {};
  state.eventOrder = [];
  state.recapOrder = [];
  state.recapCursor = null;
  state.recapDone = false;
  state.liveMessages = [];
  state.olderMessages = [];
  state.noMoreMessages = false;
  state.currentChat = null;
  state.currentChatData = null;
  state.currentOtherUid = "";
  state.currentProfileUid = "";
  state.replyingToMessage = null;
  state.editingMessage = null;
  state.suppressNextTap = false;
  state.pinnedMessage = null;
  state.recentChatUids = [];
  state.messagesUnsubscribe = null;
  state.chatDocUnsubscribe = null;
  state.typingUnsubscribe = null;
  state.pinnedUnsubscribe = null;
  state.eventTypingUids = [];
  state.chatListUnsubscribe = null;
  state.blocksUnsubscribe = null;
  state.orbitUnsubscribe = null;
  state.myProfileUnsubscribe = null;
  state.eventsUnsubscribe = null;
  state.profileEventsUnsubscribe = null;
}
