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
import { switchScreen, showNotification, toggleTime } from '../utils/ui.js';
import { openProfileScreen } from './profileService.js';
import {
  primeUsers, fetchUser, displayNameFor, avatarFor,
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

  const input = document.getElementById("chatUser");
  if (input && !rawUsername) input.value = "";

  startChatWithUid(otherUid);
}

export function startChatWithUid(otherUid) {
  if (!safeId(otherUid) || otherUid === state.uid) return;
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
    hTitle.style.cursor = "default";
    hTitle.onclick = null;
  }

  document.querySelector(".topbar")?.classList.add("hidden");
  switchScreen("chatScreen");
  history.pushState({ modalOpen: true }, "", window.location.href);

  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  state.chatDocUnsubscribe = db.collection("events").doc(eventId).onSnapshot((doc) => {
    if (!doc.exists) return;
    state.currentEventData = doc.data();
    if (hTitle) hTitle.innerText = state.currentEventData.title || "Event chat";
    updateTypingIndicator();
  }, (err) => console.error("Event chat error:", err.code || err.message));

  updateChatFooterUI();
  loadMessages();
}

export function closeChat() {
  const chatId = state.currentChat;
  const type = state.currentChatType;

  if (chatId && type === "direct") {
    db.collection("chats").doc(chatId).set({ typingUid: "" }, { merge: true }).catch(() => {});
  } else if (chatId && type === "event") {
    db.collection("events").doc(chatId)
      .update({ typingUids: FieldValue.arrayRemove(state.uid) })
      .catch(() => {});
  }

  if (state.messagesUnsubscribe) state.messagesUnsubscribe();
  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  state.messagesUnsubscribe = null;
  state.chatDocUnsubscribe = null;

  state.currentChat = null;
  state.currentChatData = null;
  state.currentEventData = null;
  state.currentOtherUid = "";
  state.replyingToMessage = null;

  document.querySelector(".topbar")?.classList.remove("hidden");
  switchScreen("home");
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
      await db.collection("events").doc(state.currentChat)
        .update({ typingUids: FieldValue.arrayRemove(state.uid) })
        .catch(() => {});
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

export function handleTyping() {
  if (!state.currentChat) return;
  clearTimeout(state.typingTimer);

  if (state.currentChatType === "event") {
    const ref = db.collection("events").doc(state.currentChat);
    ref.update({ typingUids: FieldValue.arrayUnion(state.uid) }).catch(() => {});
    state.typingTimer = setTimeout(() => {
      if (state.currentChat) ref.update({ typingUids: FieldValue.arrayRemove(state.uid) }).catch(() => {});
    }, 1500);
  } else {
    const ref = db.collection("chats").doc(state.currentChat);
    ref.set({ typingUid: state.uid }, { merge: true }).catch(() => {});
    state.typingTimer = setTimeout(() => {
      if (state.currentChat) ref.set({ typingUid: "" }, { merge: true }).catch(() => {});
    }, 1500);
  }
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
    ? `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>`
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

  if (state.currentChatType === "event" && state.currentEventData) {
    const typists = (state.currentEventData.typingUids || []).filter((u) => u !== state.uid);
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
      <div style="background: rgba(79, 70, 229, 0.1); padding: 8px 12px; border-radius: 12px; border-left: 4px solid var(--primary); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
        <div style="color: var(--primary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
          <b>Replying to ${escapeHtml(name)}:</b><br>${escapeHtml(state.replyingToMessage.text)}
        </div>
        <div onclick="window.cancelReply()" style="cursor: pointer; color: var(--danger); margin-left: 10px; font-size: 20px;"><i class='bx bx-x'></i></div>
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

  state.messagesUnsubscribe = ref.orderBy("time", "asc").limitToLast(300).onSnapshot(
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

        html += `
          <div id="msg-${escapeHtml(m.time)}" class="msg-wrapper"
               data-sender-uid="${escapeHtml(m.senderUid)}"
               data-time="${escapeHtml(m.time)}"
               data-text="${escapeHtml(encodedText)}"
               style="align-items: ${isMe ? "flex-end" : "flex-start"};"
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
            ? `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>`
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

// ---------- Inbox ----------
export function loadChatList() {
  if (state.chatListUnsubscribe) state.chatListUnsubscribe();

  state.chatListUnsubscribe = db
    .collection("chats")
    .where("userUids", "array-contains", state.uid)
    .onSnapshot(
      async (snapshot) => {
        const list = document.getElementById("chatList");
        if (!list) return;

        snapshot.docChanges().forEach((change) => {
          if (change.type !== "modified") return;
          const data = change.doc.data();
          if (data.unreadByUid === state.uid && state.currentChat !== change.doc.id) {
            const senderUid = (data.userUids || []).find((u) => u !== state.uid);
            if (senderUid) showNotification(senderUid, change.doc.id, openChat);
          }
        });

        const chats = [];
        snapshot.forEach((doc) => chats.push({ id: doc.id, ...doc.data() }));
        chats.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

        await primeUsers(
          chats.map((c) => (c.userUids || []).find((u) => u !== state.uid)).filter(Boolean)
        );

        if (!chats.length) {
          list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;
          document.getElementById("chatBadge")?.classList.add("hidden");
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

        const badge = document.getElementById("chatBadge");
        badge?.classList.toggle("hidden", !hasGlobalUnread);
        document.title = hasGlobalUnread ? "(1) New Message - livesociya" : "livesociya";
      },
      (error) => console.error("Inbox error:", error.code || error.message)
    );
}
