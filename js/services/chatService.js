import { auth, db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar, formatTime, formatMessage } from '../utils/formatters.js';
import { switchScreen, showNotification, toggleTime } from '../utils/ui.js';
import { openProfileScreen } from './profileService.js';

export async function checkCrossedPaths(user1, user2) {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const snap = await db.collection("events").where("participants", "array-contains", user1).get();
  for (let doc of snap.docs) {
    const e = doc.data();
    if (e.participants.includes(user2) && e.expiresAt > oneDayAgo) return true;
  }
  return false;
}

export async function startChat(clickedUsername = null) {
  let rawOther = clickedUsername || document.getElementById("chatUser")?.value.trim();
  if (!rawOther) return alert("Please enter a username.");
  const other = rawOther.toLowerCase();
  if (other === state.user) return alert("You can't start a chat with yourself!");

  try {
    const usernameDoc = await db.collection("usernames").doc(other).get();
    if (!usernameDoc.exists) return alert(`User "@${other}" does not exist on campus.`);
    const chatId = [state.user, other].sort().join("_");
    if (!clickedUsername && document.getElementById("chatUser")) document.getElementById("chatUser").value = "";
    openChat(chatId, other);
  } catch (error) {
    alert("Error finding user.");
  }
}

export function openChat(chatId, otherUser) {
  state.currentChat = chatId;
  state.currentOtherUser = otherUser;
  state.currentChatType = "direct";

  const hAvatar = document.getElementById("chatHeaderAvatar");
  const hTitle = document.getElementById("chatWithTitle");
  if (hAvatar) hAvatar.innerHTML = renderAvatar("👤");
  if (hTitle) hTitle.innerText = otherUser;

  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";

  db.collection("users").doc(otherUser).get().then(doc => {
    if (doc.exists) {
      const d = doc.data();
      state.userCache[otherUser] = d;
      if (hAvatar) {
        hAvatar.innerHTML = renderAvatar(d.avatar || "👤");
        hAvatar.style.cursor = "pointer";
        hAvatar.onclick = () => openProfileScreen(otherUser);
      }
      if (hTitle) {
        hTitle.innerText = d.displayName || otherUser;
        hTitle.style.cursor = "pointer";
        hTitle.onclick = () => openProfileScreen(otherUser);
      }
    }
  });

  document.querySelector(".topbar")?.classList.add("hidden");
  switchScreen("chatScreen");
  history.pushState({ modalOpen: true }, '', window.location.href);

  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  state.chatDocUnsubscribe = db.collection("chats").doc(chatId).onSnapshot(doc => {
    if (doc.exists) {
      state.currentChatData = doc.data();
      state.currentChatStatus = state.currentChatData.status || "unlocked";
      state.currentChatInitiator = state.currentChatData.initiatedBy || "";

      if (state.currentChatData.unreadBy === state.user) {
        db.collection("chats").doc(chatId).set({ unreadBy: "" }, { merge: true });
        state.currentChatData.unreadBy = "";
      }

      updateReadReceipts();
      updateTypingIndicator();
      updateChatFooterUI();
    }
  });

  loadMessages();
}

export function openEventChat(eventId, eventTitle) {
  state.currentChat = eventId;
  state.currentChatType = "event";
  state.currentChatStatus = "unlocked";
  state.currentChatData = { status: "unlocked", typing: "" };

  const hAvatar = document.getElementById("chatHeaderAvatar");
  const hTitle = document.getElementById("chatWithTitle");
  if (hAvatar) hAvatar.innerText = "📅";
  if (hTitle) hTitle.innerText = eventTitle;

  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";

  document.querySelector(".topbar")?.classList.add("hidden");
  switchScreen("chatScreen");

  if (state.chatDocUnsubscribe) { state.chatDocUnsubscribe(); state.chatDocUnsubscribe = null; }
  state.chatDocUnsubscribe = db.collection("events").doc(eventId).onSnapshot(doc => {
    if (doc.exists) {
      state.currentEventData = doc.data();
      updateTypingIndicator();
    }
  });

  updateChatFooterUI();
  loadMessages();
}

export function closeChat() {
  if (state.currentChat) db.collection("chats").doc(state.currentChat).set({ typing: "" }, { merge: true });
  state.currentChat = null;
  state.currentChatData = null;
  state.currentOtherUser = "";
  if (state.messagesUnsubscribe) state.messagesUnsubscribe();
  if (state.chatDocUnsubscribe) state.chatDocUnsubscribe();
  document.querySelector(".topbar")?.classList.remove("hidden");
  switchScreen("home");
}

export async function sendMessage() {
  const input = document.getElementById("msgInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text || !state.currentChat) return;

  const replyData = state.replyingToMessage ? {
    sender: state.replyingToMessage.sender,
    text: state.replyingToMessage.text,
    time: state.replyingToMessage.time
  } : null;
  state.replyingToMessage = null;

  await db.collection("messages").add({
    chatId: state.currentChat,
    sender: state.user,
    text: text,
    time: Date.now(),
    replyTo: replyData,
    uid: auth.currentUser.uid
  });

  if (state.currentChatType === "event") {
    await db.collection("events").doc(state.currentChat).update({
      typingUsers: firebase.firestore.FieldValue.arrayRemove(state.user)
    }).catch(() => {});
  } else {
    const otherUser = state.currentOtherUser;
    const chatRef = db.collection("chats").doc(state.currentChat);
    const chatDoc = await chatRef.get();
    let newStatus = state.currentChatStatus;

    if (!chatDoc.exists || !chatDoc.data().status) {
      const crossedPaths = await checkCrossedPaths(state.user, otherUser);
      newStatus = crossedPaths ? "unlocked" : "icebreaker";
    } else {
      if (state.currentChatStatus === "icebreaker" && state.currentChatInitiator === otherUser) {
        newStatus = "unlocked";
      }
    }

    await chatRef.set({
      users: [state.user, otherUser],
      unreadBy: otherUser,
      lastUpdated: Date.now(),
      status: newStatus,
      typing: ""
    }, { merge: true });
  }

  input.value = "";
  updateChatFooterUI();
}

export function handleTyping() {
  if (!state.currentChat) return;

  if (state.currentChatType === "event") {
    db.collection("events").doc(state.currentChat).update({
      typingUsers: firebase.firestore.FieldValue.arrayUnion(state.user)
    });

    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      if (state.currentChat) {
        db.collection("events").doc(state.currentChat).update({
          typingUsers: firebase.firestore.FieldValue.arrayRemove(state.user)
        }).catch(() => {});
      }
    }, 1500);
  } else {
    db.collection("chats").doc(state.currentChat).set({ typing: state.user }, { merge: true });

    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      if (state.currentChat) {
        db.collection("chats").doc(state.currentChat).set({ typing: "" }, { merge: true });
      }
    }, 1500);
  }
}

export function initiateReply(sender, text, time) {
  state.replyingToMessage = { sender, text, time };
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
  const input = document.getElementById("msgInput");
  if (input) input.focus();
}

export function scrollToMessage(time) {
  const targetMsg = document.getElementById(`msg-${time}`);
  if (!targetMsg) return;

  const bubble = targetMsg.querySelector(".msg-bubble");
  if (!bubble) return;

  targetMsg.scrollIntoView({ behavior: "smooth", block: "center" });
  const isSent = bubble.classList.contains("msg-sent");
  const flashClass = isSent ? "flash-sent" : "flash-received";

  bubble.classList.remove("flash-sent", "flash-received");
  void bubble.offsetWidth;
  bubble.classList.add(flashClass);

  setTimeout(() => {
    bubble.classList.remove(flashClass);
  }, 1600);
}

export function handleMessageTap(event, element, sender, encodedText, time) {
  const replyBox = event.target.closest('.msg-replied-to');
  if (replyBox) {
    const targetTime = replyBox.getAttribute('data-target-time');
    if (targetTime) scrollToMessage(targetTime);
    return;
  }

  const currentTime = new Date().getTime();
  const tapLength = currentTime - state.lastTapTime;
  state.lastTapTime = currentTime;

  if (tapLength < 300 && tapLength > 0) {
    event.preventDefault();
    initiateReply(sender, decodeURIComponent(encodedText), time);
    if (navigator.vibrate) navigator.vibrate(50);
  } else {
    toggleTime(element);
  }
}

export function handleChatScroll() {
  const box = document.getElementById("messages");
  let floatingDate = document.getElementById("floatingDate");

  if (!floatingDate) {
    floatingDate = document.createElement("div");
    floatingDate.id = "floatingDate";
    floatingDate.className = "floating-date";
    document.getElementById("chatScreen").appendChild(floatingDate);
  }

  const dateWrappers = box.getElementsByClassName("date-separator");
  let activeDateText = "";
  const boxRect = box.getBoundingClientRect();

  for (let el of dateWrappers) {
    const rect = el.getBoundingClientRect();
    if (rect.top <= boxRect.top + 60) {
      activeDateText = el.innerText;
    }
  }

  if (activeDateText) {
    floatingDate.innerText = activeDateText;
    floatingDate.classList.add("visible");
    clearTimeout(state.scrollTimeout);
    state.scrollTimeout = setTimeout(() => {
      floatingDate.classList.remove("visible");
    }, 1200);
  }
}

export function updateReadReceipts() {
  const receipt = document.getElementById("readReceipt");
  if (receipt && state.currentChatData) {
    if (state.currentChatData.unreadBy === "") {
      receipt.innerHTML = `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>`;
    } else {
      receipt.innerHTML = `Sent <i class='bx bx-check'></i>`;
    }
  }
}

export function updateTypingIndicator() {
  const bubble = document.getElementById("typingBubble");
  const nameEl = document.getElementById("typingName");
  const box = document.getElementById("messages");
  if (!bubble || !box) return;

  if (state.currentChatType === "event" && state.currentEventData) {
    const typists = (state.currentEventData.typingUsers || []).filter(u => u !== state.user);
    if (typists.length > 0) {
      if (nameEl) {
        const displayName = state.userCache[typists[0]]?.displayName || typists[0];
        nameEl.innerText = typists.length === 1 ? `${displayName} is typing` : `${typists.length} people typing`;
      }
      bubble.classList.remove("hidden");
      box.scrollTop = box.scrollHeight;
    } else {
      bubble.classList.add("hidden");
    }
  } else if (state.currentChatType === "direct" && state.currentChatData) {
    if (state.currentChatData.typing === state.currentOtherUser) {
      if (nameEl) nameEl.innerText = "";
      bubble.classList.remove("hidden");
      box.scrollTop = box.scrollHeight;
    } else {
      bubble.classList.add("hidden");
    }
  }
}

export function updateChatFooterUI() {
  const icebreakerMsg = document.getElementById("icebreakerMsg");
  const inputWrapper = document.getElementById("inputWrapper");
  const previewContainer = document.getElementById("replyPreviewContainer");
  if (!icebreakerMsg || !inputWrapper || !previewContainer) return;

  if (state.currentChatStatus === "icebreaker" && state.currentChatInitiator === state.user && state.myMessageCount >= 1) {
    icebreakerMsg.classList.remove("hidden");
    inputWrapper.classList.add("hidden");
    previewContainer.classList.add("hidden");
    return;
  } else {
    icebreakerMsg.classList.add("hidden");
    inputWrapper.classList.remove("hidden");
    previewContainer.classList.remove("hidden");
  }

  if (state.replyingToMessage) {
    const name = state.replyingToMessage.sender === state.user ? "Yourself" : state.replyingToMessage.sender;
    previewContainer.innerHTML = `
      <div style="background: rgba(79, 70, 229, 0.1); padding: 8px 12px; border-radius: 12px; border-left: 4px solid var(--primary); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
        <div style="color: var(--primary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
          <b>Replying to ${name}:</b><br>${state.replyingToMessage.text}
        </div>
        <div onclick="window.cancelReply()" style="cursor: pointer; color: var(--danger); margin-left: 10px; font-size: 20px;"><i class='bx bx-x'></i></div>
      </div>`;
  } else {
    previewContainer.innerHTML = "";
  }
}

export function loadMessages() {
  if (state.messagesUnsubscribe) state.messagesUnsubscribe();
  const box = document.getElementById("messages");
  if (!box) return;

  if (!box.dataset.hasScrollListener) {
    box.addEventListener("scroll", handleChatScroll);
    box.dataset.hasScrollListener = "true";
  }

  state.messagesUnsubscribe = db.collection("messages").where("chatId", "==", state.currentChat).onSnapshot(async (snapshot) => {
    let lastDateString = "";
    state.myMessageCount = 0;
    let theirMessageCount = 0;
    let msgs = [];
    
    snapshot.forEach(doc => msgs.push(doc.data()));
    msgs.sort((a, b) => a.time - b.time);

    const uniqueSenders = [...new Set(msgs.map(m => m.sender))];
    for (let s of uniqueSenders) {
      if (!state.userCache[s]) {
        const doc = await db.collection("users").doc(s).get();
        state.userCache[s] = doc.exists ? doc.data() : { displayName: s, avatar: "👤" };
      }
    }

    let newHTML = "";

    msgs.forEach((m, i) => {
      const isMe = m.sender === state.user;
      if (isMe) state.myMessageCount++;
      else theirMessageCount++;

      const msgDate = new Date(m.time).toLocaleDateString();
      if (msgDate !== lastDateString) {
        let displayDate = "";
        const today = new Date().toLocaleDateString();
        const yesterdayObj = new Date();
        yesterdayObj.setDate(yesterdayObj.getDate() - 1);
        const yesterday = yesterdayObj.toLocaleDateString();

        if (msgDate === today) displayDate = "Today";
        else if (msgDate === yesterday) displayDate = "Yesterday";
        else displayDate = new Date(m.time).toLocaleDateString([], { month: 'short', day: 'numeric' });

        newHTML += `<div class="date-wrapper"><div class="date-separator">${displayDate}</div></div>`;
        lastDateString = msgDate;
      }

      const prev = msgs[i - 1];
      const next = msgs[i + 1];
      const isSamePrev = prev && prev.sender === m.sender;
      const isSameNext = next && next.sender === m.sender;
      let shape = "single";
      if (isSamePrev && isSameNext) shape = "middle";
      else if (!isSamePrev && isSameNext) shape = "first";
      else if (isSamePrev && !isSameNext) shape = "last";

      const encodedText = encodeURIComponent(m.text);
      const rawText = m.text.trim();
      const isMediaOnly = /^https?:\/\/[^\s]+$/.test(rawText) && (rawText.includes("youtube.com") || rawText.includes("youtu.be") || rawText.includes("spotify.com"));
      const bubbleClass = isMediaOnly ? 'msg-bubble media-only' : 'msg-bubble';

      let replyBlock = "";
      if (m.replyTo) {
        const replyName = m.replyTo.sender === state.user ? "You" : (state.userCache[m.replyTo.sender]?.displayName || m.replyTo.sender);
        const timeData = m.replyTo.time ? `data-target-time="${m.replyTo.time}"` : "";
        replyBlock = `<div class="msg-replied-to" ${timeData}><b>${replyName}:</b> ${m.replyTo.text}</div>`;
      }

      const swipeIconHTML = isMe 
        ? `<div class="swipe-reply-icon right"><i class='bx bx-reply' style="transform: scaleX(-1);"></i></div>` 
        : `<div class="swipe-reply-icon left"><i class='bx bx-reply'></i></div>`;

      let nameTagHTML = "";
      if (state.currentChatType === "event" && !isMe && !isSamePrev) {
        const senderDisplayName = state.userCache[m.sender]?.displayName || m.sender;
        nameTagHTML = `<div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-left: 14px; margin-bottom: 2px; cursor: pointer; display: inline-block;" onclick="event.stopPropagation(); window.openProfileScreen('${m.sender}')">${senderDisplayName}</div>`;
      }

      newHTML += `
        <div id="msg-${m.time}" class="msg-wrapper" data-sender="${m.sender}" data-time="${m.time}" data-text="${encodedText}" style="align-items: ${isMe ? 'flex-end' : 'flex-start'};" onclick="window.handleMessageTap(event, this, '${m.sender}', '${encodedText}', ${m.time})">
          ${swipeIconHTML}
          ${nameTagHTML}
          <div class="${bubbleClass} ${isMe ? 'msg-sent' : 'msg-received'} ${shape}">
             ${replyBlock}
             ${formatMessage(m.text, isMediaOnly)}
          </div>
          <div class="msg-time" style="text-align: ${isMe ? 'right' : 'left'}">
             ${formatTime(m.time)}
          </div>
        </div>`;

      if (i === msgs.length - 1 && isMe && state.currentChatType === "direct") {
        let statusHtml = (state.currentChatData && state.currentChatData.unreadBy === "") 
          ? `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>` 
          : `Sent <i class='bx bx-check'></i>`;
        newHTML += `<div class="msg-status" id="readReceipt">${statusHtml}</div>`;
      }
    });

    newHTML += `
      <div id="typingBubble" class="typing-indicator hidden" style="align-items: center; margin-top: 8px;">
        <span id="typingName" style="font-size: 12px; font-weight: 700; color: var(--primary); margin-right: 8px;"></span>
        <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
      </div>`;

    box.innerHTML = newHTML;

    if (state.currentChatStatus === "icebreaker" && theirMessageCount > 0 && state.currentChatInitiator === state.user) {
      db.collection("chats").doc(state.currentChat).update({ status: "unlocked" });
    }

    box.scrollTop = box.scrollHeight;
    updateChatFooterUI();
    updateReadReceipts();
    updateTypingIndicator();
  });
}

export function loadChatList() {
  db.collection("chats").where("users", "array-contains", state.user).onSnapshot(async (snapshot) => {
    const list = document.getElementById("chatList");
    if (!list) return;

    let hasGlobalUnread = false;
    let chatsArray = [];

    snapshot.docChanges().forEach(change => {
      if (change.type === "modified") {
        const chatData = change.doc.data();
        if (chatData.unreadBy === state.user && state.currentChat !== change.doc.id) {
          const otherUser = (chatData.users && Array.isArray(chatData.users))
            ? chatData.users.find(u => u !== state.user)
            : change.doc.id.replace(state.user, "").replace("_", "");
          showNotification(otherUser, change.doc.id, openChat);
        }
      }
    });

    snapshot.forEach(doc => { chatsArray.push({ id: doc.id, ...doc.data() }); });
    chatsArray.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

    const uniqueOthers = [...new Set(chatsArray.map(chat =>
      (chat.users && Array.isArray(chat.users)) ? chat.users.find(u => u !== state.user) : chat.id.replace(state.user, "").replace("_", "")
    ))];

    for (let other of uniqueOthers) {
      if (!state.userCache[other]) {
        const doc = await db.collection("users").doc(other).get();
        state.userCache[other] = doc.exists ? doc.data() : { displayName: other, avatar: "👤" };
      }
    }

    list.innerHTML = "";
    if (chatsArray.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;
      return;
    }

    chatsArray.forEach(chat => {
      let other = (chat.users && Array.isArray(chat.users)) ? chat.users.find(u => u !== state.user) : chat.id.replace(state.user, "").replace("_", "");

      if (chat.unreadBy === state.user && state.currentChat === chat.id) {
        db.collection("chats").doc(chat.id).set({ unreadBy: "" }, { merge: true });
        chat.unreadBy = "";
      }

      const isUnread = chat.unreadBy === state.user;
      if (isUnread) hasGlobalUnread = true;

      const cachedUser = state.userCache[other] || {};
      const displayName = cachedUser.displayName || other;
      const avatarCode = cachedUser.avatar || "👤";

      const unreadStyles = isUnread ? 'background: #e0e7ff; border-left: 4px solid var(--primary);' : '';
      const nameStyles = isUnread ? 'font-weight: 800;' : '';
      const dotHTML = isUnread ? `<div class="unread-pulse-dot"></div>` : '';

      list.innerHTML += `
        <div class="chat-item" onclick="window.openChat('${chat.id}', '${other}')" style="${unreadStyles}">
          <div class="chat-avatar" style="background: transparent; border: 1px solid var(--border); padding: 0; overflow: hidden;">
              ${renderAvatar(avatarCode)}
          </div>
          <div class="chat-name" style="${nameStyles}; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayName}</div>
          ${dotHTML}
        </div>
      `;
    });

    const badge = document.getElementById("chatBadge");
    if (hasGlobalUnread) {
      if (badge) badge.classList.remove("hidden");
      document.title = "(1) New Message - livesociya";
    } else {
      if (badge) badge.classList.add("hidden");
      document.title = "livesociya";
    }
  });
}
