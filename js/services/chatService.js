// ==========================================
// CHAT (DIRECT + EVENT)
// ==========================================
//
// LAYOUT
//   chats/{chatId}                 chatId = [uidA, uidB].sort().join("_")
//   chats/{chatId}/messages/{id}
//   events/{eventId}/messages/{id}
//
// Messages live in SUBCOLLECTIONS on purpose. A security rule can then
// authorise a whole message query with a single lookup of the parent
// document, instead of a per-message lookup on a flat collection.
//
// Every identity field is a uid: senderUid, userUids, unreadByUid,
// typingUid, initiatedByUid.
// ==========================================

import { auth, db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar, formatTime, formatMessage, escapeHtml, safeId } from '../utils/formatters.js';
import { switchScreen, showTab, showNotification, toggleTime } from '../utils/ui.js';
import { openProfileScreen } from './profileService.js';
import { isBlocked } from './blockService.js';
import { searchPeople } from './searchService.js';
import {
  primeUsers, fetchUser, displayNameFor, usernameFor, avatarFor,
  resolveUsernameToUid, directChatId, normalizeUsername
} from './userService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The right messages subcollection for whatever chat is open. */
function messagesRef(chatId = state.currentChat, type = state.currentChatType) {
  if (!chatId) return null;
  return type === "event"
    ? db.collection("events").doc(chatId).collection("messages")
    : db.collection("chats").doc(chatId).collection("messages");
}

/**
 * Two people have "crossed paths" if they were both on the participant
 * list of the same event in the last 24h. If not, the first message is
 * an icebreaker: one message only, until the other side replies.
 */
export async function checkCrossedPaths(uidA, uidB) {
  const cutoff = Date.now() - DAY_MS;
  try {
    const snap = await db.collection("events")
      .where("participantUids", "array-contains", uidA)
      .where("expiresAt", ">", cutoff)
      .get();
    return snap.docs.some((doc) => (doc.data().participantUids || []).includes(uidB));
  } catch (e) {
    console.error("Crossed-paths check failed:", e.code || e.message);
    return false;
  }
}

// ---------- Entry points ----------
export async function startChat(rawUsername = null) {
  const typed = rawUsername || document.getElementById("chatUser")?.value;
  const handle = normalizeUsername(typed);
  if (!handle) return alert("Please enter a username.");
  if (handle === state.username) return alert("You can't start a chat with yourself!");

  const otherUid = await resolveUsernameToUid(handle);
  if (!otherUid) return alert(`User "@${handle}" does not exist on campus.`);
  // Deliberately the same message as "no such user" — confirming a
  // block would tell the blocked person exactly what happened.
  if (isBlocked(otherUid)) return alert(`User "@${handle}" does not exist on campus.`);

  const input = document.getElementById("chatUser");
  if (input && !rawUsername) input.value = "";

  startChatWithUid(otherUid);
}

export function startChatWithUid(otherUid) {
  if (!safeId(otherUid) || otherUid === state.uid) return;
  if (isBlocked(otherUid)) return;
  openChat(directChatId(state.uid, otherUid), otherUid);
}

export function openChat(chatId, otherUid) {
  if (!safeId(otherUid)) return;

  state.currentChat = chatId;
  state.currentOtherUid = otherUid;
  state.currentChatType = "direct";
  state.replyingToMessage = null;

  const hAvatar = document.getElementById("chatHeaderAvatar");
  const hTitle = document.getElementById("chatWithTitle");
  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";
  if (hAvatar) hAvatar.innerHTML = renderAvatar("\u{1F464}");
  if (hTitle) hTitle.innerText = "Loading...";

  fetchUser(otherUid).then(() => {
    if (state.currentOtherUid !== otherUid) return;
    if (hAvatar) {
      hAvatar.innerHTML = renderAvatar(avatarFor(otherUid));
      hAvatar.style.cursor = "pointer";
      hAvatar.onclick = () => openProfileScreen(otherUid);
    }
    if (hTitle) {
      hTitle.innerText = displayNameFor(otherUid);
      hTitle.style.cursor = "pointer";
      hTitle.onclick = () => openProfileScreen(otherUid);
    }
  });

  document.querySelector(".topbar")?.classList.add("hidden");
  switchScreen("chatScreen");
  history.pushState({ modalOpen: true }, "", window.location.href);

  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  state.chatDocUnsubscribe = db.collection("chats").doc(chatId).onSnapshot((doc) => {
    if (!doc.exists) {
      state.currentChatData = null;
      state.currentChatStatus = "unlocked";
      state.currentChatInitiatorUid = "";
      updateChatFooterUI();
      return;
    }

    const data = doc.data();
    state.currentChatData = data;
    state.currentChatStatus = data.status || "unlocked";
    state.currentChatInitiatorUid = data.initiatedByUid || "";

    if (data.unreadByUid === state.uid) {
      db.collection("chats").doc(chatId)
        .set({ unreadByUid: "" }, { merge: true })
        .catch(() => {});
      state.currentChatData.unreadByUid = "";
    }

    updateReadReceipts();
    updateTypingIndicator();
    updateChatFooterUI();
  }, (err) => console.error("Chat doc error:", err.code || err.message));

  loadMessages();
}

export function openEventChat(eventId) {
  if (!safeId(eventId)) return;
  const cached = state.eventCache[eventId] || {};

  state.currentChat = eventId;
  state.currentChatType = "event";
  state.currentChatStatus = "unlocked";
  state.currentChatInitiatorUid = "";
  state.currentChatData = null;
  state.replyingToMessage = null;

  const hAvatar = document.getElementById("chatHeaderAvatar");
  const hTitle = document.getElementById("chatWithTitle");
  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";
  if (hAvatar) {
    hAvatar.innerText = "\u{1F4C5}";
    hAvatar.style.cursor = "default";
    hAvatar.onclick = null;
  }
  // innerText, not innerHTML — the title is user-supplied.
  if (hTitle) {
    hTitle.innerText = cached.title || "Event chat";
    // Tapping the title returns you to the event itself.
    hTitle.style.cursor = "pointer";
    hTitle.onclick = () => {
      closeChat({ silent: true });
      switchScreen("home");
      showTab("events");
      setTimeout(() => window.focusEvent?.(eventId), 80);
    };
  }

  document.querySelector(".topbar")?.classList.add("hidden");
  switchScreen("chatScreen");
  history.pushState({ modalOpen: true }, "", window.location.href);

  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  state.chatDocUnsubscribe = db.collection("events").doc(eventId).onSnapshot((doc) => {
    if (!doc.exists) return;
    state.currentEventData = doc.data();
    if (hTitle) hTitle.innerText = state.currentEventData.title || "Event chat";
  }, (err) => console.error("Event chat error:", err.code || err.message));

  // Typing lives in a subcollection so only this chat pays for it.
  if (state.typingUnsubscribe) state.typingUnsubscribe();
  state.typingUnsubscribe = db.collection("events").doc(eventId).collection("typing")
    .onSnapshot((snap) => {
      const fresh = Date.now() - 6000;
      state.eventTypingUids = snap.docs
        .filter((d) => (d.data().at || 0) > fresh)
        .map((d) => d.id)
        .filter((u) => u !== state.uid);
      updateTypingIndicator();
    }, () => {});

  updateChatFooterUI();
  loadMessages();
}

export function closeChat({ silent = false } = {}) {
  const chatId = state.currentChat;
  const type = state.currentChatType;

  stopTyping();

  if (state.messagesUnsubscribe) state.messagesUnsubscribe();
  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  if (state.typingUnsubscribe) state.typingUnsubscribe();
  state.messagesUnsubscribe = null;
  state.chatDocUnsubscribe = null;
  state.typingUnsubscribe = null;
  state.eventTypingUids = [];

  state.currentChat = null;
  state.currentChatData = null;
  state.currentEventData = null;
  state.currentOtherUid = "";
  state.replyingToMessage = null;

  document.querySelector(".topbar")?.classList.remove("hidden");
  if (!silent) switchScreen("home");
}

// ---------- Sending ----------
export async function sendMessage() {
  const input = document.getElementById("msgInput");
  if (!input || !auth.currentUser) return;

  const text = input.value.trim();
  if (!text || !state.currentChat) return;
  if (text.length > 2000) return alert("That message is too long.");

  const replyData = state.replyingToMessage
    ? {
        senderUid: state.replyingToMessage.senderUid,
        text: state.replyingToMessage.text.slice(0, 200),
        time: state.replyingToMessage.time
      }
    : null;

  input.value = "";
  state.replyingToMessage = null;
  updateChatFooterUI();

  try {
    if (state.currentChatType === "event") {
      await messagesRef().add({
        senderUid: state.uid,
        text,
        time: Date.now(),
        replyTo: replyData
      });
      stopTyping();
      return;
    }

    // ---- Direct chat: the parent doc must exist before the message,
    // because the rules read it to authorise the write. ----
    const otherUid = state.currentOtherUid;
    const chatRef = db.collection("chats").doc(state.currentChat);
    const chatDoc = await chatRef.get();

    let status = state.currentChatStatus;
    let initiatedByUid = state.currentChatInitiatorUid;

    if (!chatDoc.exists) {
      const crossed = await checkCrossedPaths(state.uid, otherUid);
      status = crossed ? "unlocked" : "icebreaker";
      initiatedByUid = state.uid;
      await chatRef.set({
        userUids: [state.uid, otherUid].sort(),
        createdAt: Date.now(),
        initiatedByUid,
        status,
        unreadByUid: otherUid,
        typingUid: "",
        lastUpdated: Date.now()
      });
    } else {
      if (status === "icebreaker" && initiatedByUid === otherUid) status = "unlocked";
      await chatRef.set({
        unreadByUid: otherUid,
        lastUpdated: Date.now(),
        status,
        typingUid: ""
      }, { merge: true });
    }

    await messagesRef().add({
      senderUid: state.uid,
      text,
      time: Date.now(),
      replyTo: replyData
    });
  } catch (error) {
    console.error("Send failed:", error.code || error.message);
    input.value = text;
    alert(
      error.code === "permission-denied"
        ? "You can't send a message in this chat."
        : "Message failed to send."
    );
  } finally {
    updateChatFooterUI();
  }
}

// A typing indicator is a nicety; it must not cost a write per
// keystroke. One write starts it, one clears it, and nothing in
// between — so a 40-character message costs 2 writes, not 40.
const TYPING_REFRESH_MS = 4000;
let typingActive = false;
let typingWroteAt = 0;

function typingRef() {
  if (!state.currentChat) return null;
  return state.currentChatType === "event"
    ? db.collection("events").doc(state.currentChat).collection("typing").doc(state.uid)
    : db.collection("chats").doc(state.currentChat);
}

function writeTyping(on) {
  const ref = typingRef();
  if (!ref) return;

  if (state.currentChatType === "event") {
    if (on) ref.set({ at: Date.now() }).catch(() => {});
    else ref.delete().catch(() => {});
  } else {
    ref.set({ typingUid: on ? state.uid : "" }, { merge: true }).catch(() => {});
  }
}

export function handleTyping() {
  if (!state.currentChat) return;

  const now = Date.now();
  // Only announce on the first keystroke, then refresh occasionally so
  // the indicator doesn't expire mid-sentence.
  if (!typingActive || now - typingWroteAt > TYPING_REFRESH_MS) {
    typingActive = true;
    typingWroteAt = now;
    writeTyping(true);
  }

  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => {
    typingActive = false;
    writeTyping(false);
  }, 2200);
}

/** Called when a chat closes or a message is sent. */
export function stopTyping() {
  clearTimeout(state.typingTimer);
  if (!typingActive) return;
  typingActive = false;
  writeTyping(false);
}

// ---------- Replies ----------
export function initiateReply(senderUid, text, time) {
  state.replyingToMessage = { senderUid, text, time };
  updateChatFooterUI();
  setTimeout(() => {
    const input = document.getElementById("msgInput");
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, 50);
}

export function cancelReply() {
  state.replyingToMessage = null;
  updateChatFooterUI();
  document.getElementById("msgInput")?.focus();
}

export function scrollToMessage(time) {
  const targetMsg = document.getElementById(`msg-${time}`);
  const bubble = targetMsg?.querySelector(".msg-bubble");
  if (!bubble) return;

  targetMsg.scrollIntoView({ behavior: "smooth", block: "center" });
  const flashClass = bubble.classList.contains("msg-sent") ? "flash-sent" : "flash-received";
  bubble.classList.remove("flash-sent", "flash-received");
  void bubble.offsetWidth;
  bubble.classList.add(flashClass);
  setTimeout(() => bubble.classList.remove(flashClass), 1600);
}

/**
 * Tap handler. Reads everything it needs from data-* attributes on the
 * element, so no user text is ever interpolated into the onclick markup.
 */
export function handleMessageTap(event, element) {
  const replyBox = event.target.closest(".msg-replied-to");
  if (replyBox) {
    const targetTime = replyBox.getAttribute("data-target-time");
    if (targetTime) scrollToMessage(targetTime);
    return;
  }

  const now = Date.now();
  const tapLength = now - state.lastTapTime;
  state.lastTapTime = now;

  if (tapLength < 300 && tapLength > 0) {
    event.preventDefault();
    initiateReply(
      element.getAttribute("data-sender-uid"),
      decodeURIComponent(element.getAttribute("data-text") || ""),
      parseInt(element.getAttribute("data-time"), 10)
    );
    if (navigator.vibrate) navigator.vibrate(50);
  } else {
    toggleTime(element);
  }
}

// ---------- Chrome ----------
export function handleChatScroll() {
  const box = document.getElementById("messages");
  if (!box) return;

  let floatingDate = document.getElementById("floatingDate");
  if (!floatingDate) {
    floatingDate = document.createElement("div");
    floatingDate.id = "floatingDate";
    floatingDate.className = "floating-date";
    document.getElementById("chatScreen")?.appendChild(floatingDate);
  }

  let activeDateText = "";
  const boxRect = box.getBoundingClientRect();
  for (const el of box.getElementsByClassName("date-separator")) {
    if (el.getBoundingClientRect().top <= boxRect.top + 60) activeDateText = el.innerText;
  }

  if (activeDateText) {
    floatingDate.innerText = activeDateText;
    floatingDate.classList.add("visible");
    clearTimeout(state.scrollTimeout);
    state.scrollTimeout = setTimeout(() => floatingDate.classList.remove("visible"), 1200);
  }
}

export function updateReadReceipts() {
  const receipt = document.getElementById("readReceipt");
  if (!receipt || !state.currentChatData) return;
  receipt.innerHTML = state.currentChatData.unreadByUid === ""
    ? `Read <i class='bx bx-check-double'></i>`
    : `Sent <i class='bx bx-check'></i>`;
}

export function updateTypingIndicator() {
  const bubble = document.getElementById("typingBubble");
  const nameEl = document.getElementById("typingName");
  const box = document.getElementById("messages");
  if (!bubble || !box) return;

  const show = () => {
    bubble.classList.remove("hidden");
    box.scrollTop = box.scrollHeight;
  };

  if (state.currentChatType === "event") {
    const typists = state.eventTypingUids || [];
    if (!typists.length) return bubble.classList.add("hidden");
    if (nameEl) {
      nameEl.innerText = typists.length === 1
        ? `${displayNameFor(typists[0])} is typing`
        : `${typists.length} people typing`;
    }
    show();
  } else if (state.currentChatType === "direct" && state.currentChatData) {
    if (state.currentChatData.typingUid !== state.currentOtherUid) return bubble.classList.add("hidden");
    if (nameEl) nameEl.innerText = "";
    show();
  }
}

export function updateChatFooterUI() {
  const icebreakerMsg = document.getElementById("icebreakerMsg");
  const inputWrapper = document.getElementById("inputWrapper");
  const previewContainer = document.getElementById("replyPreviewContainer");
  if (!icebreakerMsg || !inputWrapper || !previewContainer) return;

  // A blocked thread is read-only. The rules refuse the write anyway;
  // this is so the person isn't left typing into a dead box.
  if (state.currentChatType === "direct" && isBlocked(state.currentOtherUid)) {
    icebreakerMsg.innerHTML = `<i class='bx bx-block'></i> You can't message this person.`;
    icebreakerMsg.classList.remove("hidden");
    inputWrapper.classList.add("hidden");
    previewContainer.classList.add("hidden");
    return;
  }
  icebreakerMsg.innerHTML = `<i class='bx bxs-lock-alt'></i> Icebreaker sent — waiting for a reply`;

  const lockedOut =
    state.currentChatType === "direct" &&
    state.currentChatStatus === "icebreaker" &&
    state.currentChatInitiatorUid === state.uid &&
    state.myMessageCount >= 1;

  icebreakerMsg.classList.toggle("hidden", !lockedOut);
  inputWrapper.classList.toggle("hidden", lockedOut);
  previewContainer.classList.toggle("hidden", lockedOut);
  if (lockedOut) return;

  if (state.replyingToMessage) {
    const name = state.replyingToMessage.senderUid === state.uid
      ? "Yourself"
      : displayNameFor(state.replyingToMessage.senderUid);
    previewContainer.innerHTML = `
      <div style="background: var(--bone); border-left: 2px solid var(--periwinkle); padding: 10px 16px; border-radius: 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
        <div style="font-size: 14px; font-weight: 350; color: var(--aubergine); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
          <b>Replying to ${escapeHtml(name)}:</b><br>${escapeHtml(state.replyingToMessage.text)}
        </div>
        <div onclick="window.cancelReply()" style="cursor: pointer; margin-left: 10px; font-size: 20px;"><i class='bx bx-x'></i></div>
      </div>`;
  } else {
    previewContainer.innerHTML = "";
  }
}

// ---------- Message stream ----------
export function loadMessages() {
  if (state.messagesUnsubscribe) state.messagesUnsubscribe();

  const box = document.getElementById("messages");
  const ref = messagesRef();
  if (!box || !ref) return;

  if (!box.dataset.hasScrollListener) {
    box.addEventListener("scroll", handleChatScroll);
    box.dataset.hasScrollListener = "true";
  }

  const openedChat = state.currentChat;

  state.messagesUnsubscribe = ref.orderBy("time", "asc").limitToLast(60).onSnapshot(
    async (snapshot) => {
      if (state.currentChat !== openedChat) return;

      const msgs = [];
      snapshot.forEach((doc) => msgs.push({ id: doc.id, ...doc.data() }));

      await primeUsers(msgs.map((m) => m.senderUid));
      if (state.currentChat !== openedChat) return;

      state.myMessageCount = 0;
      let theirMessageCount = 0;
      let lastDateString = "";
      let html = "";

      msgs.forEach((m, i) => {
        const isMe = m.senderUid === state.uid;
        if (isMe) state.myMessageCount++;
        else theirMessageCount++;

        // ---- Date separator ----
        const msgDate = new Date(m.time).toLocaleDateString();
        if (msgDate !== lastDateString) {
          const today = new Date().toLocaleDateString();
          const y = new Date();
          y.setDate(y.getDate() - 1);
          const yesterday = y.toLocaleDateString();

          const displayDate = msgDate === today
            ? "Today"
            : msgDate === yesterday
              ? "Yesterday"
              : new Date(m.time).toLocaleDateString([], { month: "short", day: "numeric" });

          html += `<div class="date-wrapper"><div class="date-separator">${escapeHtml(displayDate)}</div></div>`;
          lastDateString = msgDate;
        }

        // ---- Bubble grouping ----
        const prev = msgs[i - 1];
        const next = msgs[i + 1];
        const samePrev = prev && prev.senderUid === m.senderUid;
        const sameNext = next && next.senderUid === m.senderUid;
        const shape = samePrev && sameNext ? "middle" : !samePrev && sameNext ? "first" : samePrev && !sameNext ? "last" : "single";

        const rawText = String(m.text || "").trim();
        const encodedText = encodeURIComponent(rawText);
        const isMediaOnly =
          /^https?:\/\/[^\s]+$/.test(rawText) &&
          /(youtube\.com|youtu\.be|open\.spotify\.com)/.test(rawText);

        // ---- Quoted reply ----
        let replyBlock = "";
        if (m.replyTo) {
          const replyName = m.replyTo.senderUid === state.uid ? "You" : displayNameFor(m.replyTo.senderUid);
          const timeAttr = m.replyTo.time ? `data-target-time="${escapeHtml(m.replyTo.time)}"` : "";
          replyBlock = `<div class="msg-replied-to" ${timeAttr}><b>${escapeHtml(replyName)}:</b> ${escapeHtml(m.replyTo.text)}</div>`;
        }

        const swipeIconHTML = isMe
          ? `<div class="swipe-reply-icon right"><i class='bx bx-reply' style="transform: scaleX(-1);"></i></div>`
          : `<div class="swipe-reply-icon left"><i class='bx bx-reply'></i></div>`;

        // ---- Sender label in event chats ----
        let nameTagHTML = "";
        if (state.currentChatType === "event" && !isMe && !samePrev) {
          const uid = safeId(m.senderUid);
          const label = escapeHtml(displayNameFor(m.senderUid));
          nameTagHTML = uid
            ? `<div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-left: 14px; margin-bottom: 2px; cursor: pointer; display: inline-block;" onclick="event.stopPropagation(); window.openProfileScreen('${uid}')">${label}</div>`
            : `<div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-left: 14px; margin-bottom: 2px;">${label}</div>`;
        }

        const enterDelay = Math.min(i, 12) * 0.022;
        html += `
          <div id="msg-${escapeHtml(m.time)}" class="msg-wrapper" style="animation-delay:${enterDelay}s;"
               data-sender-uid="${escapeHtml(m.senderUid)}"
               data-time="${escapeHtml(m.time)}"
               data-text="${escapeHtml(encodedText)}"
               data-align="${isMe ? "end" : "start"}"
               onclick="window.handleMessageTap(event, this)">
            ${swipeIconHTML}
            ${nameTagHTML}
            <div class="${isMediaOnly ? "msg-bubble media-only" : "msg-bubble"} ${isMe ? "msg-sent" : "msg-received"} ${shape}">
               ${replyBlock}
               ${formatMessage(rawText, isMediaOnly)}
            </div>
            <div class="msg-time" style="text-align: ${isMe ? "right" : "left"}">
               ${formatTime(m.time)}
            </div>
          </div>`;

        if (i === msgs.length - 1 && isMe && state.currentChatType === "direct") {
          const statusHtml = state.currentChatData && state.currentChatData.unreadByUid === ""
            ? `Read <i class='bx bx-check-double'></i>`
            : `Sent <i class='bx bx-check'></i>`;
          html += `<div class="msg-status" id="readReceipt">${statusHtml}</div>`;
        }
      });

      html += `
        <div id="typingBubble" class="typing-indicator hidden" style="align-items: center; margin-top: 8px;">
          <span id="typingName" style="font-size: 12px; font-weight: 700; color: var(--primary); margin-right: 8px;"></span>
          <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
        </div>`;

      box.innerHTML = html;

      // The icebreaker unlocks as soon as the other side replies.
      if (
        state.currentChatType === "direct" &&
        state.currentChatStatus === "icebreaker" &&
        theirMessageCount > 0 &&
        state.currentChatInitiatorUid === state.uid
      ) {
        db.collection("chats").doc(state.currentChat)
          .set({ status: "unlocked" }, { merge: true })
          .catch(() => {});
      }

      box.scrollTop = box.scrollHeight;
      updateChatFooterUI();
      updateReadReceipts();
      updateTypingIndicator();
    },
    (error) => console.error("Messages error:", error.code || error.message)
  );
}

/** The unread dot appears in the mobile bottom nav and the desktop sidebar. */
function setUnreadBadge(hasUnread) {
  ["chatBadge", "sideBadge"].forEach((id) => {
    document.getElementById(id)?.classList.toggle("hidden", !hasUnread);
  });
}

// ---------- Inbox ----------
export function loadChatList() {
  if (state.chatListUnsubscribe) state.chatListUnsubscribe();

  const listEl = document.getElementById("chatList");
  if (listEl && !listEl.children.length) {
    listEl.innerHTML = Array.from({ length: 3 }, () => `
      <div class="skel-card" style="padding:12px">
        <div class="skel-row" style="margin:0">
          <div class="skel skel-avatar"></div>
          <div style="flex:1"><div class="skel skel-line w-40"></div></div>
        </div>
      </div>`).join("");
  }

  state.chatListUnsubscribe = db
    .collection("chats")
    .where("userUids", "array-contains", state.uid)
    .onSnapshot(
      async (snapshot) => {
        inboxRetries = 0;
        const list = document.getElementById("chatList");
        if (!list) return;

        snapshot.docChanges().forEach((change) => {
          if (change.type !== "modified") return;
          const data = change.doc.data();
          if (data.unreadByUid === state.uid && state.currentChat !== change.doc.id) {
            const senderUid = (data.userUids || []).find((u) => u !== state.uid);
            if (senderUid && !isBlocked(senderUid)) showNotification(senderUid, change.doc.id, openChat);
          }
        });

        const chats = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          const other = (data.userUids || []).find((u) => u !== state.uid);
          if (isBlocked(other)) return;   // blocked conversations disappear
          chats.push({ id: doc.id, ...data });
        });
        chats.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

        // Never let a profile lookup failure stop the inbox rendering.
        try {
          await primeUsers(chats.map((c) => (c.userUids || []).find((u) => u !== state.uid)).filter(Boolean));
        } catch (e) {
          console.error("Inbox profile prefetch failed:", e.code || e.message);
        }

        if (!chats.length) {
          list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;
          setUnreadBadge(false);
          document.title = "livesociya";
          return;
        }

        let hasGlobalUnread = false;
        let html = "";

        chats.forEach((chat) => {
          const otherUid = (chat.userUids || []).find((u) => u !== state.uid);
          const id = safeId(chat.id);
          const otherId = safeId(otherUid);
          if (!id || !otherId) return;

          let isUnread = chat.unreadByUid === state.uid;
          if (isUnread && state.currentChat === chat.id) {
            db.collection("chats").doc(chat.id).set({ unreadByUid: "" }, { merge: true }).catch(() => {});
            isUnread = false;
          }
          if (isUnread) hasGlobalUnread = true;

          html += `
            <div class="chat-item" onclick="window.openChat('${id}', '${otherId}')" style="${isUnread ? "background: #e0e7ff; border-left: 4px solid var(--primary);" : ""}">
              <div class="chat-avatar" style="background: transparent; border: 1px solid var(--border); padding: 0; overflow: hidden;">
                  ${renderAvatar(avatarFor(otherUid))}
              </div>
              <div class="chat-name" style="${isUnread ? "font-weight: 800;" : ""} flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayNameFor(otherUid))}</div>
              ${isUnread ? `<div class="unread-pulse-dot"></div>` : ""}
            </div>`;
        });

        list.innerHTML = html;

        setUnreadBadge(hasGlobalUnread);
        document.title = hasGlobalUnread ? "(1) New Message - livesociya" : "livesociya";
      },
      (error) => {
        // A Firestore listener that errors is DEAD: it never retries on
        // its own. That is why a chat could be sent successfully and
        // still never appear in the inbox — the query had been killed
        // earlier (by the old rules) and nothing re-attached it.
        console.error("Inbox error:", error.code || error.message);
        state.chatListUnsubscribe = null;
        retryInbox();
      }
    );
}

let inboxRetries = 0;
function retryInbox() {
  if (inboxRetries >= 5) {
    const list = document.getElementById("chatList");
    if (list) {
      list.innerHTML = `<div class="empty-state"><h4>Can't load your chats</h4><p>Check your connection, then reload the page.</p></div>`;
    }
    return;
  }
  const wait = 1200 * Math.pow(2, inboxRetries);
  inboxRetries++;
  setTimeout(() => { if (state.uid) loadChatList(); }, wait);
}


/* ---------------------------------------------------------------------
   Inbox search — replaces the old "type the exact handle" box
   ------------------------------------------------------------------- */

let inboxDebounce = 0;
let inboxQuery = "";

export function onInboxSearch(value) {
  const q = String(value || "").trim();
  inboxQuery = q;
  document.getElementById("inboxSearchClear")?.classList.toggle("hidden", q.length === 0);

  clearTimeout(inboxDebounce);

  // Empty box means "show me my conversations again".
  if (q.length < 2) {
    state.chatListUnsubscribe ? renderInboxFromCache() : loadChatList();
    return;
  }

  inboxDebounce = setTimeout(async () => {
    const uids = await searchPeople(q);
    if (inboxQuery !== q) return;

    const list = document.getElementById("chatList");
    if (!list) return;

    if (!uids.length) {
      list.innerHTML = `<div class="empty-state"><p>No one matches “${escapeHtml(q)}”.</p></div>`;
      return;
    }

    list.innerHTML = uids.map((uid) => {
      const id = safeId(uid);
      if (!id) return "";
      return `
        <div class="chat-item" onclick="window.startChatWithUid('${id}')">
          <div class="chat-avatar">${renderAvatar(avatarFor(uid))}</div>
          <div style="flex:1;min-width:0;">
            <div class="chat-name">${escapeHtml(displayNameFor(uid))}</div>
            <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
          </div>
          <i class='bx bx-message-rounded-dots' style="color:var(--fog);font-size:20px;"></i>
        </div>`;
    }).join("");
  }, 260);
}

export function clearInboxSearch() {
  const input = document.getElementById("chatUser");
  if (input) input.value = "";
  onInboxSearch("");
  input?.focus();
}

/** Re-render the inbox from the live listener's last snapshot. */
function renderInboxFromCache() {
  // Simplest correct thing: re-attach. The listener fires immediately
  // with the cached snapshot, so this costs nothing.
  loadChatList();
}
