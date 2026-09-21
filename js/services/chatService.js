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
import { renderAvatar, formatTime, formatMessage, escapeHtml, safeId, msOf } from '../utils/formatters.js';
import { switchScreen, showTab, showNotification, toggleTime, toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { openOverlay, closeOverlay, isOverlayOpen } from '../utils/overlays.js';
import {
  isDeleted, isEdited, canEdit, canRetract, messageActions, editWindowLabel,
  REACTIONS, reactionOf, canReact, nextReaction, reactionSummary,
  hostActions, pinPayload
} from './messageRules.js';
import { eventIdFromUrl } from './shareRules.js';
import { primeEvent } from './shareService.js';
import { openProfileScreen } from './profileService.js';
import { isBlocked } from './blockService.js';
import { vibeColor } from './eventsService.js';
import { inRecap } from './recapRules.js';
import { searchPeople } from './searchService.js';
import {
  primeUsers, fetchUser, displayNameFor, usernameFor, avatarFor,
  resolveUsernameToUid, directChatId, normalizeUsername
} from './userService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Only the newest messages get a live listener. Older ones are fetched
// once, on demand, when you scroll back. Opening a conversation used
// to cost 300 reads, then 60; now it costs 25, and you only pay for
// history you actually look at.
//
// Messages are near enough immutable for that to hold: the only
// writes to one are its sender's own edit or retraction, and when
// those land on a message outside the live window we patch the copy
// on screen ourselves (patchLocalMessage) rather than widen the
// listener, which would re-read the whole thread. The other person
// sees it on their next open. That is the price of not paying for a
// listener over history nobody is looking at.
const LIVE_WINDOW = 25;
const OLDER_PAGE = 25;

// The inbox listener used to ask for EVERY conversation you have ever
// had, with no limit and no order — a live listener over all of them,
// re-read on every launch and billing a read per change for the rest of
// time. Nobody scrolls past the last few dozen threads, and the sort
// this used to do in memory is the one the server can do from an index.
const INBOX_LIMIT = 40;

// One shared event is all "have we crossed paths" asks for. Without a
// bound, somebody who joined forty things yesterday made their first
// message to a stranger cost forty reads.
const CROSSED_PATHS_SCAN = 20;

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
      .limit(CROSSED_PATHS_SCAN)
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
  if (!handle) return toast("Type a handle first.");
  if (handle === state.username) return toast("That's you.");

  const otherUid = await resolveUsernameToUid(handle);
  if (!otherUid) return toast("No @" + handle + " on campus.");
  // Deliberately the same message as "no such user" — confirming a
  // block would tell the blocked person exactly what happened.
  if (isBlocked(otherUid)) return toast("No @" + handle + " on campus.");

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
  state.currentChatLoaded = false;
  // Back to a blank slate BEFORE the listener answers. Without this the
  // previous conversation's icebreaker state carried over: leave a
  // thread where you had used your one opening message, open another,
  // and until that chat's document arrived the composer was hidden and
  // the bar read "Icebreaker sent — waiting for a reply" at the wrong
  // person. openEventChat has always cleared these; openChat did not.
  state.currentChatStatus = "unlocked";
  state.currentChatInitiatorUid = "";
  state.myMessageCount = 0;
  state.replyingToMessage = null;
  state.editingMessage = null;
  state.pinnedMessage = null;
  renderPinnedBar();

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
    state.currentChatLoaded = true;
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
  state.editingMessage = null;
  // Cleared before the listener attaches, so the previous event's pin
  // never flashes at the top of this one.
  state.pinnedMessage = null;
  renderPinnedBar();

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

  // The pinned message, same reasoning as typing: a subcollection, so
  // only the people in this chat pay for it.
  if (state.pinnedUnsubscribe) state.pinnedUnsubscribe();
  state.pinnedUnsubscribe = db.collection("events").doc(eventId)
    .collection("pinned").doc("current")
    .onSnapshot((doc) => {
      state.pinnedMessage = doc.exists ? doc.data() : null;
      renderPinnedBar();
    }, () => {});

  // Typing lives in a subcollection so only this chat pays for it.
  if (state.typingUnsubscribe) state.typingUnsubscribe();
  state.typingUnsubscribe = db.collection("events").doc(eventId).collection("typing")
    .onSnapshot((snap) => {
      const fresh = Date.now() - 6000;
      state.eventTypingUids = snap.docs
        // The stamp is the server's now, so it comes back as a
        // Timestamp — comparing that to a number is always false, and
        // the indicator would never have shown at all.
        .filter((d) => msOf(d.data().at) > fresh)
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
  if (state.pinnedUnsubscribe) state.pinnedUnsubscribe();
  state.messagesUnsubscribe = null;
  state.chatDocUnsubscribe = null;
  state.typingUnsubscribe = null;
  state.pinnedUnsubscribe = null;
  state.pinnedMessage = null;
  renderPinnedBar();
  state.eventTypingUids = [];

  state.currentChat = null;
  state.currentChatData = null;
  state.currentChatLoaded = false;
  state.currentEventData = null;
  state.currentOtherUid = "";
  state.replyingToMessage = null;
  state.editingMessage = null;
  closeMessageActions();

  document.querySelector(".topbar")?.classList.remove("hidden");
  if (!silent) switchScreen("home");
}

// ---------- Sending ----------
export async function sendMessage() {
  const input = document.getElementById("msgInput");
  if (!input || !auth.currentUser) return;

  // Same box, same Enter key — but if the composer is in edit mode it
  // is rewriting something already sent, not adding to the thread.
  if (state.editingMessage) return commitEdit();

  const text = input.value.trim();
  if (!text || !state.currentChat) return;
  if (text.length > 2000) return toast("That message is too long.");

  const replyData = state.replyingToMessage
    ? {
        senderUid: state.replyingToMessage.senderUid,
        text: state.replyingToMessage.text.slice(0, 200),
        id: state.replyingToMessage.id || ""
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
        // TWO STAMPS, on purpose. `time` is the client's own number:
        // the thread is ordered by it, it paints the instant you hit
        // send, and a message written with no signal still carries
        // one. `sentAt` is the server's, and the rules require it to
        // equal request.time — so anything that must not be gameable
        // (the fifteen minutes to edit) is measured against that one.
        time: Date.now(),
        sentAt: FieldValue.serverTimestamp(),
        replyTo: replyData
      });
      stopTyping();
      return;
    }

    // ---- Direct chat: the parent doc must exist before the message,
    // because the rules read it to authorise the write. ----
    const otherUid = state.currentOtherUid;
    const chatRef = db.collection("chats").doc(state.currentChat);

    // This document already has a live listener on it. Reading it again
    // here was a billed read on EVERY message sent, for data we were
    // holding — it roughly doubled what a conversation costs. Only go to
    // the network while that listener still has not delivered.
    let chatData = state.currentChatData;
    let chatExists = !!chatData;
    if (!state.currentChatLoaded) {
      const chatDoc = await chatRef.get();
      chatExists = chatDoc.exists;
      chatData = chatExists ? (chatDoc.data() || {}) : null;
    }

    let status = state.currentChatStatus;
    let initiatedByUid = state.currentChatInitiatorUid;

    let usedIcebreaker = false;

    if (!chatExists) {
      const crossed = await checkCrossedPaths(state.uid, otherUid);
      status = crossed ? "unlocked" : "icebreaker";
      initiatedByUid = state.uid;
      await chatRef.set({
        userUids: [state.uid, otherUid].sort(),
        createdAt: FieldValue.serverTimestamp(),
        initiatedByUid,
        status,
        icebreakerUsed: false,
        unreadByUid: otherUid,
        typingUid: "",
        lastUpdated: Date.now()
      });
      usedIcebreaker = status === "icebreaker";
    } else {
      if (status === "icebreaker" && initiatedByUid === otherUid) status = "unlocked";
      usedIcebreaker = status === "icebreaker"
        && chatData.initiatedByUid === state.uid
        && chatData.icebreakerUsed !== true;
      await chatRef.set({
        unreadByUid: otherUid,
        lastUpdated: Date.now(),
        status,
        typingUid: ""
      }, { merge: true });
    }

    // THE ICEBREAKER. One opening message to somebody who has never
    // replied, and the rules enforce it now rather than the app: the
    // message only goes through if this same batch flips icebreakerUsed
    // from false to true, and the flag can never go back. So there is
    // exactly one such message, ever. Everything after it is an
    // ordinary send, once they have written back.
    const msgRef = messagesRef().doc();
    const body = {
      senderUid: state.uid,
      text,
      time: Date.now(),
      sentAt: FieldValue.serverTimestamp(),
      replyTo: replyData
    };

    if (usedIcebreaker) {
      const batch = db.batch();
      batch.set(chatRef, { icebreakerUsed: true }, { merge: true });
      batch.set(msgRef, body);
      await batch.commit();
    } else {
      await msgRef.set(body);
    }
  } catch (error) {
    console.error("Send failed:", error.code || error.message);
    input.value = text;
    toast(error.code === "permission-denied"
      ? "Wait for them to reply before sending another."
      : "Message failed to send.");
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
    if (on) ref.set({ at: FieldValue.serverTimestamp() }).catch(() => {});
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
/**
 * Quote a message.
 *
 * Identified by its DOCUMENT ID, not by when it was sent. Two messages
 * written in the same millisecond used to collide: they shared a DOM
 * id, and a reply to the second one scrolled to the first. The id is
 * Firestore's, it is already on every bubble as `data-msg-id`, and it
 * does not change when the clock does.
 */
export function initiateReply(senderUid, text, messageId) {
  if (!text) return;            // a retracted message has nothing to quote
  state.editingMessage = null;  // the two composer modes are exclusive
  state.replyingToMessage = { senderUid, text, id: messageId || "" };
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

// ---------- Editing, and taking a message back ----------
//
// One message at a time, held here in `actionTargetId` instead of
// being passed through markup — so the sheet's buttons carry an action
// name and nothing else: no ids, and certainly no message text.
//
// The two things you can do are deliberately not symmetrical. An edit
// has 15 minutes on it and always leaves "edited" behind; a deletion
// has no clock but leaves the bubble in place, reading "This message
// was deleted". js/services/messageRules.js says why, and
// firestore.rules enforces both — the sheet only decides what to
// offer.

let actionTargetId = "";

/** The copy of a message we have on screen: live window or history. */
function findMessage(id) {
  if (!id) return null;
  return state.olderMessages.concat(state.liveMessages).find((m) => m.id === id) || null;
}

/**
 * Apply a change to the copy on screen and repaint without moving the
 * view.
 *
 * Inside the live window the listener would do this a moment later
 * anyway, and doing it here is what makes the tap feel instant. For an
 * older message — fetched once with get(), never watched — this is the
 * only thing that updates it.
 */
function patchLocalMessage(id, fields) {
  let found = false;
  [state.olderMessages, state.liveMessages].forEach((list) => {
    const m = list.find((x) => x.id === id);
    if (m) { Object.assign(m, fields); found = true; }
  });
  if (!found) return;

  const box = document.getElementById("messages");
  const keepScroll = box
    ? { heightBefore: box.scrollHeight, topBefore: box.scrollTop }
    : null;
  renderMessages(state.olderMessages.concat(state.liveMessages), { keepScroll });
}

const ACTION_LABELS = {
  reply:  { icon: "bx-reply",    label: "Reply" },
  copy:   { icon: "bx-copy",     label: "Copy text" },
  pin:    { icon: "bx-pin",      label: "Pin to the top" },
  unpin:  { icon: "bx-pin",      label: "Unpin" },
  edit:   { icon: "bx-edit-alt", label: "Edit" },
  delete: { icon: "bx-trash",    label: "Delete", danger: true }
};

/** True when you are hosting the event this chat belongs to. */
function amHostHere() {
  return state.currentChatType === "event"
    && !!state.currentEventData
    && state.currentEventData.hostUid === state.uid;
}

/** Built here rather than in index.html, the same way confirm.js does. */
function actionSheetEl() {
  let el = document.getElementById("msgActionSheet");
  if (el) return el;

  el = document.createElement("div");
  el.id = "msgActionSheet";
  el.className = "modal-overlay hidden";
  el.innerHTML = `
      <div class="modal-content action-sheet">
        <div class="react-row" id="msgReactRow"></div>
        <div class="action-quote" id="msgActionQuote"></div>
        <div class="action-list" id="msgActionList"></div>
        <button class="btn-ghost" data-act="cancel">Cancel</button>
      </div>`;
  el.addEventListener("click", (e) => {
    if (e.target === el) return closeMessageActions();

    const pick = e.target.closest("[data-react]");
    if (pick) {
      const id = actionTargetId;
      closeMessageActions();
      return toggleReaction(id, Number(pick.getAttribute("data-react")));
    }

    const btn = e.target.closest("[data-act]");
    if (btn) runMessageAction(btn.getAttribute("data-act"));
  });
  document.body.appendChild(el);
  return el;
}

/** Opened by a long press, or a right-click on a desktop. */
export function openMessageActions(messageId) {
  if (isOverlayOpen("msgActionSheet")) return;

  const msg = findMessage(messageId);
  const acts = messageActions(msg, state.uid);
  if (!acts.length) return;          // nothing to offer on a tombstone

  // The host's own row, which is about the thread rather than about
  // who wrote the message. It goes after Copy and before Edit, so the
  // destructive one stays last.
  const host = hostActions(msg, {
    isHost: amHostHere(),
    pinnedId: state.pinnedMessage ? state.pinnedMessage.messageId : ""
  });
  if (host.length) acts.splice(2, 0, ...host);

  actionTargetId = messageId;
  actionSheetEl();

  // innerText, not innerHTML — this is somebody's own words.
  const quote = document.getElementById("msgActionQuote");
  if (quote) quote.innerText = String(msg.text || "").slice(0, 140);

  // The emoji row carries indexes into the fixed list, never the
  // emoji itself, for the same reason the chips do.
  const row = document.getElementById("msgReactRow");
  if (row) {
    const mine = reactionOf(msg, state.uid);
    row.classList.toggle("hidden", !canReact(msg));
    row.innerHTML = REACTIONS.map((emoji, i) => `
      <span class="react-pick${emoji === mine ? " on" : ""}" role="button"
            data-react="${i}">${emoji}</span>`).join("");
  }

  const list = document.getElementById("msgActionList");
  if (list) {
    list.innerHTML = acts.map((key) => {
      const a = ACTION_LABELS[key];
      const note = key === "edit" ? editWindowLabel(msg) : "";
      return `
        <button class="action-row ${a.danger ? "danger" : ""}" data-act="${key}">
          <i class='bx ${a.icon}'></i>
          <span>${a.label}</span>
          ${note ? `<em>${escapeHtml(note)}</em>` : ""}
        </button>`;
    }).join("");
  }

  openOverlay("msgActionSheet", { onClose: () => { actionTargetId = ""; } });
}

export function closeMessageActions() {
  if (isOverlayOpen("msgActionSheet")) closeOverlay("msgActionSheet");
}

function runMessageAction(key) {
  const id = actionTargetId;
  const msg = findMessage(id);
  // Close first: askConfirm opens a layer of its own, and the overlay
  // stack is happier with one out before the next goes in.
  closeMessageActions();
  if (!msg || key === "cancel") return;

  if (key === "reply") return initiateReply(msg.senderUid, String(msg.text || ""), msg.id);
  if (key === "copy") return copyMessageText(msg);
  if (key === "pin") return pinMessage(id);
  if (key === "unpin") return unpinMessage();
  if (key === "edit") return startEditMessage(id);
  if (key === "delete") return confirmRetractMessage(id);
}

// ---------- The pinned message ----------
//
// Only in an event chat, only the host, and only ever one. Tapping the
// bar jumps to the message if it is still on screen; if it has
// scrolled past the live window it is not loaded, so the bar's own
// copy of the text is all there is — which is exactly why it keeps
// one.

function pinnedRef(eventId = state.currentChat) {
  if (!eventId) return null;
  return db.collection("events").doc(eventId).collection("pinned").doc("current");
}

export async function pinMessage(messageId) {
  if (!amHostHere()) return;
  const body = pinPayload(findMessage(messageId), state.uid);
  if (!body) return;

  const ref = pinnedRef();
  if (!ref) return;

  const before = state.pinnedMessage;
  state.pinnedMessage = body;
  renderPinnedBar();

  try {
    await ref.set(body);
    toast("Pinned to the top.");
  } catch (e) {
    console.error("Pin failed:", e.code || e.message);
    state.pinnedMessage = before;
    renderPinnedBar();
    toast("Couldn't pin that.");
  }
}

export async function unpinMessage() {
  if (!amHostHere()) return;
  const ref = pinnedRef();
  if (!ref) return;

  const before = state.pinnedMessage;
  state.pinnedMessage = null;
  renderPinnedBar();

  try {
    await ref.delete();
  } catch (e) {
    console.error("Unpin failed:", e.code || e.message);
    state.pinnedMessage = before;
    renderPinnedBar();
    toast("Couldn't unpin that.");
  }
}

/** Tapping the bar. Jumps to the message when it is loaded. */
export function jumpToPinned() {
  const pin = state.pinnedMessage;
  if (!pin) return;
  const msg = findMessage(pin.messageId);
  if (!msg) return toast("That message is further back in the chat.");
  scrollToMessage(msg.id);
}

export function renderPinnedBar() {
  const bar = document.getElementById("pinnedBar");
  if (!bar) return;

  const pin = state.pinnedMessage;
  if (!pin || state.currentChatType !== "event") {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  const who = pin.senderUid === state.uid ? "You" : displayNameFor(pin.senderUid);
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <div class="pinned-body" onclick="window.jumpToPinned()">
      <b><i class='bx bx-pin'></i>Pinned \u00b7 ${escapeHtml(who)}</b>
      <span>${escapeHtml(pin.text)}</span>
    </div>
    ${amHostHere()
      ? `<div class="pinned-x" role="button" aria-label="Unpin" onclick="window.unpinMessage()">\u00d7</div>`
      : ""}`;
}

/** The async clipboard needs a secure context; the old way always works. */
async function copyMessageText(msg) {
  const text = String(msg.text || "");
  if (!text) return;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const pad = document.createElement("textarea");
      pad.value = text;
      pad.setAttribute("readonly", "");
      pad.style.cssText = "position:fixed;top:-1000px;opacity:0;";
      document.body.appendChild(pad);
      pad.select();
      document.execCommand("copy");
      pad.remove();
    }
    toast("Copied.");
  } catch (e) {
    toast("Couldn't copy that.");
  }
}

/**
 * Set your reaction, or clear it if you tap the one you already gave.
 * Optimistic, like follow and hype: a button that waits for a round
 * trip reads as broken.
 */
export function toggleReaction(messageId, emojiIndex) {
  const emoji = REACTIONS[Number(emojiIndex)];
  const msg = findMessage(messageId);
  if (!emoji || !canReact(msg)) return;

  const want = nextReaction(msg, state.uid, emoji);
  if (want === null) return;

  const before = Object.assign({}, msg.reactions || {});
  const after = Object.assign({}, before);
  if (want) after[state.uid] = want;
  else delete after[state.uid];

  patchLocalMessage(messageId, { reactions: after });
  if (navigator.vibrate) navigator.vibrate(12);

  const chatId = state.currentChat;
  const type = state.currentChatType;
  // A dotted path so two people reacting at once don't overwrite each
  // other's key — which is exactly what writing the whole map would do.
  const field = "reactions." + state.uid;

  messagesRef(chatId, type).doc(messageId)
    .update({ [field]: want || FieldValue.delete() })
    .catch((e) => {
      console.error("Reaction failed:", e.code || e.message);
      patchLocalMessage(messageId, { reactions: before });
      toast("Couldn't add that reaction.");
    });
}

export function startEditMessage(messageId) {
  const msg = findMessage(messageId);
  if (!canEdit(msg, state.uid)) return toast("The 15 minutes to edit that are up.");

  state.replyingToMessage = null;
  state.editingMessage = { id: msg.id, text: String(msg.text || ""), time: msg.time };

  const input = document.getElementById("msgInput");
  if (input) {
    input.value = state.editingMessage.text;
    // Caret at the end, not the start — you are almost always fixing
    // the last few characters.
    setTimeout(() => {
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }, 50);
  }
  updateChatFooterUI();
}

export function cancelEdit() {
  state.editingMessage = null;
  const input = document.getElementById("msgInput");
  if (input) input.value = "";
  updateChatFooterUI();
  input?.focus();
}

/** Send, when the composer is in edit mode. */
async function commitEdit() {
  const input = document.getElementById("msgInput");
  const target = state.editingMessage;
  if (!input || !target) return;

  const text = input.value.trim();
  if (!text) return toast("An empty message isn't an edit — delete it instead.");
  if (text.length > 2000) return toast("That message is too long.");
  if (text === target.text) return cancelEdit();

  // The window can close while the box is open.
  const current = findMessage(target.id) || target;
  if (!canEdit(current, state.uid)) {
    cancelEdit();
    return toast("The 15 minutes to edit that are up.");
  }

  // The chat can change under a slow write, so pin down which one.
  const chatId = state.currentChat;
  const type = state.currentChatType;
  const before = { text: current.text, editedAt: current.editedAt };
  // The copy on screen gets a number so it paints now; the write gets
  // the server's clock, which is what the rules check.
  const shown = { text, editedAt: Date.now() };
  const written = { text, editedAt: FieldValue.serverTimestamp() };

  input.value = "";
  state.editingMessage = null;
  updateChatFooterUI();
  patchLocalMessage(target.id, shown);

  try {
    await messagesRef(chatId, type).doc(target.id).update(written);
  } catch (e) {
    console.error("Edit failed:", e.code || e.message);
    patchLocalMessage(target.id, before);
    toast(e.code === "permission-denied"
      ? "The 15 minutes to edit that are up."
      : "Couldn't save that edit.");
  }
}

async function confirmRetractMessage(messageId) {
  const msg = findMessage(messageId);
  if (!canRetract(msg, state.uid)) return;

  const yes = await askConfirm({
    title: "Delete this message?",
    body: "Both of you will see “This message was deleted” in its place. It can't be undone.",
    confirm: "Delete",
    cancel: "Keep it",
    danger: true
  });
  if (!yes) return;

  const chatId = state.currentChat;
  const type = state.currentChatType;
  const before = { text: msg.text, replyTo: msg.replyTo || null, deleted: false, deletedAt: null };
  // The quoted reply goes too: a tombstone that still quotes somebody
  // is half a message, and it is the half you didn't mean to keep.
  const shown = { text: "", replyTo: null, deleted: true, deletedAt: Date.now() };
  const written = { text: "", replyTo: null, deleted: true, deletedAt: FieldValue.serverTimestamp() };

  patchLocalMessage(messageId, shown);

  try {
    await messagesRef(chatId, type).doc(messageId).update(written);
  } catch (e) {
    console.error("Delete failed:", e.code || e.message);
    patchLocalMessage(messageId, before);
    toast("Couldn't delete that message.");
  }
}

export function scrollToMessage(messageId) {
  const targetMsg = document.getElementById(`msg-${messageId}`);
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
  // A long press opens the sheet and the browser then sends the click
  // on the way up. Swallow exactly that one.
  if (state.suppressNextTap) {
    state.suppressNextTap = false;
    return;
  }

  const replyBox = event.target.closest(".msg-replied-to");
  if (replyBox) {
    const targetId = replyBox.getAttribute("data-target-id");
    if (targetId) scrollToMessage(targetId);
    return;
  }

  const now = Date.now();
  const tapLength = now - state.lastTapTime;
  state.lastTapTime = now;

  if (tapLength < 300 && tapLength > 0) {
    event.preventDefault();
    if (element.getAttribute("data-deleted") === "1") return;
    initiateReply(
      element.getAttribute("data-sender-uid"),
      decodeURIComponent(element.getAttribute("data-text") || ""),
      element.getAttribute("data-msg-id")
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

  // Near the top? Pull in the previous page of history.
  if (box.scrollTop < 120) loadOlderMessages();

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

/**
 * One page of history, fetched once. Older messages are immutable, so a
 * plain get() is correct — and far cheaper than widening the listener,
 * which would re-read everything already on screen.
 */
export async function loadOlderMessages() {
  if (state.loadingOlder || state.noMoreMessages) return;

  const ref = messagesRef();
  const oldest = (state.olderMessages[0] || state.liveMessages[0]);
  if (!ref || !oldest) return;

  state.loadingOlder = true;
  const box = document.getElementById("messages");
  const openedChat = state.currentChat;

  // Remember where we are so the view doesn't jump when we prepend.
  const heightBefore = box ? box.scrollHeight : 0;
  const topBefore = box ? box.scrollTop : 0;
  showHistorySpinner(true);

  try {
    const snap = await ref
      .orderBy("time", "asc")
      .endBefore(oldest.time)
      .limitToLast(OLDER_PAGE)
      .get();

    if (state.currentChat !== openedChat) return;

    const older = [];
    snap.forEach((doc) => older.push({ id: doc.id, ...doc.data() }));

    if (older.length < OLDER_PAGE) state.noMoreMessages = true;
    if (!older.length) return;

    state.olderMessages = older.concat(state.olderMessages);
    await primeUsers(older.map((m) => m.senderUid));
    if (state.currentChat !== openedChat) return;

    renderMessages(state.olderMessages.concat(state.liveMessages), { keepScroll: { heightBefore, topBefore } });
  } catch (e) {
    console.error("History load failed:", e.code || e.message);
  } finally {
    state.loadingOlder = false;
    showHistorySpinner(false);
  }
}

function showHistorySpinner(on) {
  const box = document.getElementById("messages");
  if (!box) return;
  let el = document.getElementById("historySpinner");
  if (on && !el) {
    el = document.createElement("div");
    el.id = "historySpinner";
    el.className = "history-spinner";
    el.innerHTML = `<div class="spinner" style="width:22px;height:22px;border-width:2px;"></div>`;
    box.prepend(el);
  } else if (!on && el) {
    el.remove();
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

  // The composer is in one of three modes, and the note above it says
  // which: writing something new, quoting, or rewriting.
  const sendIcon = inputWrapper.querySelector("button i");
  inputWrapper.classList.toggle("editing", !!state.editingMessage);
  if (sendIcon) {
    sendIcon.className = state.editingMessage ? "bx bx-check" : "bx bxs-send";
  }

  if (state.editingMessage) {
    previewContainer.innerHTML = composeNote({
      icon: "bx-edit-alt",
      title: "Editing message",
      body: state.editingMessage.text,
      cancel: "window.cancelEdit()",
      variant: "editing"
    });
  } else if (state.replyingToMessage) {
    const name = state.replyingToMessage.senderUid === state.uid
      ? "Yourself"
      : displayNameFor(state.replyingToMessage.senderUid);
    previewContainer.innerHTML = composeNote({
      icon: "bx-reply",
      title: "Replying to " + name,
      body: state.replyingToMessage.text,
      cancel: "window.cancelReply()"
    });
  } else {
    previewContainer.innerHTML = "";
  }
}

/** The little bar above the input. Text in, escaped, no colours here. */
function composeNote({ icon, title, body, cancel, variant = "" }) {
  return `
    <div class="compose-note ${variant}">
      <div class="compose-note-body">
        <b><i class='bx ${icon}'></i>${escapeHtml(title)}</b>
        <span>${escapeHtml(body)}</span>
      </div>
      <div class="compose-note-x" onclick="${cancel}" role="button" aria-label="Cancel">×</div>
    </div>`;
}

// ---------- Message stream ----------
export function loadMessages() {
  if (state.messagesUnsubscribe) state.messagesUnsubscribe();

  // Fresh conversation, fresh paging state.
  state.liveMessages = [];
  state.olderMessages = [];
  state.noMoreMessages = false;
  state.loadingOlder = false;

  const box = document.getElementById("messages");
  const ref = messagesRef();
  if (!box || !ref) return;

  if (!box.dataset.hasScrollListener) {
    box.addEventListener("scroll", handleChatScroll);
    box.dataset.hasScrollListener = "true";
  }

  const openedChat = state.currentChat;

  state.messagesUnsubscribe = ref.orderBy("time", "asc").limitToLast(LIVE_WINDOW).onSnapshot(
    async (snapshot) => {
      if (state.currentChat !== openedChat) return;

      const wasLive = state.liveMessages;
      state.liveMessages = [];
      snapshot.forEach((doc) => state.liveMessages.push({ id: doc.id, ...doc.data() }));

      // ---- A MESSAGE USED TO VANISH OUT OF THE MIDDLE OF A THREAD ----
      //
      // The live window is the newest 25; history is fetched with
      // endBefore(the oldest message on screen). Both were right on
      // their own and wrong together: when a new message arrived the
      // window slid forward, and the message that fell off the FRONT of
      // it belonged to neither list — history stopped strictly before
      // where the window used to start, so nothing ever fetched it
      // again. Scroll up in a long thread, receive one message, and a
      // message disappeared from the middle of what you were reading.
      //
      // So anything that leaves the window is carried into history. The
      // test is its TIME, not merely its absence: a message deleted
      // from inside the window is absent too, but the window refills
      // from below, so the new first message is EARLIER than it and it
      // is correctly left to go. Only a message older than the new
      // start of the window actually fell off the front.
      if (state.olderMessages.length && wasLive.length) {
        const nowLive = new Set(state.liveMessages.map((m) => m.id));
        const edge = state.liveMessages.length ? state.liveMessages[0].time : Infinity;
        const fellOff = wasLive.filter((m) => !nowLive.has(m.id) && m.time < edge);
        if (fellOff.length) {
          const seen = new Set(state.olderMessages.map((m) => m.id));
          state.olderMessages = state.olderMessages
            .concat(fellOff.filter((m) => !seen.has(m.id)))
            .sort((a, b) => a.time - b.time);
        }
      }

      // Nothing older than the window can exist if the window isn't full.
      if (state.liveMessages.length < LIVE_WINDOW && !state.olderMessages.length) {
        state.noMoreMessages = true;
      }

      const msgs = state.olderMessages.concat(state.liveMessages);
      await primeUsers(msgs.map((m) => m.senderUid));
      if (state.currentChat !== openedChat) return;

      renderMessages(msgs);
    },
    (error) => console.error("Messages error:", error.code || error.message)
  );
}

/**
 * Paint the thread. Shared by the live listener and the history
 * loader, so both produce identical markup.
 *
 * `keepScroll` is passed when prepending older messages: without it
 * the view would jump to the bottom and throw you out of the history
 * you were reading.
 */
/* ---------------------------------------------------------------------
   Painting a thread without throwing it away
   ---------------------------------------------------------------------
   This used to be one `box.innerHTML = html` per snapshot, and every
   snapshot is every incoming message. `.msg-wrapper` carries
   `animation: rise`, so one message arriving replayed the entry
   animation on the whole visible thread — the same flicker the feed was
   diffed to remove, still here. It also threw away anything the reader
   had done to the nodes: a tapped-open timestamp (`.show-time`) closed
   itself, and a text selection vanished mid-copy.

   fillEventEmbeds' comment already claimed "the message diffing
   compares markup". It does now. Each message's block is remembered by
   its document id, and a re-render only touches the blocks whose markup
   genuinely differs. A quiet repaint writes nothing.
   ------------------------------------------------------------------- */

// A block is everything one message owns: its date separator when it
// starts a new day, its bubble, and the read receipt when it is the
// last thing you sent. Keyed by the message's document id, remembered
// as BOTH the markup and the nodes it produced — the nodes, because a
// block is more than one element and reusing only the bubble would
// leave its separator behind.
let paintedMsgs = new Map();    // key -> html
let paintedNodes = new Map();   // key -> Node[]
let paintedChat = "";

function forgetPaintedMessages() {
  paintedMsgs = new Map();
  paintedNodes = new Map();
  paintedChat = "";
}

// The chat whose icebreaker unlock is already on its way.
let unlockingChat = "";

function renderMessages(msgs, { keepScroll = null } = {}) {
  const box = document.getElementById("messages");
  if (!box) return;

  state.myMessageCount = 0;
  let theirMessageCount = 0;
  let lastDateString = "";
  let html = "";
  // [{ key, html }] — one entry per message, carrying its date
  // separator so a separator can never be orphaned by the diff.
  const blocks = [];
  let blockStart = 0;

  msgs.forEach((m, i) => {
    blockStart = html.length;
    const isMe = m.senderUid === state.uid;
    if (isMe) state.myMessageCount++;
    else theirMessageCount++;

    // ---- Date separator ----
    const msgDate = new Date(msOf(m.time)).toLocaleDateString();
    if (msgDate !== lastDateString) {
      const today = new Date().toLocaleDateString();
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = y.toLocaleDateString();

      const displayDate = msgDate === today
        ? "Today"
        : msgDate === yesterday
          ? "Yesterday"
          : new Date(msOf(m.time)).toLocaleDateString([], { month: "short", day: "numeric" });

      html += `<div class="date-wrapper"><div class="date-separator">${escapeHtml(displayDate)}</div></div>`;
      lastDateString = msgDate;
    }

    // ---- Bubble grouping ----
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const samePrev = prev && prev.senderUid === m.senderUid;
    const sameNext = next && next.senderUid === m.senderUid;
    const shape = samePrev && sameNext ? "middle" : !samePrev && sameNext ? "first" : samePrev && !sameNext ? "last" : "single";

    // A retracted message keeps its place in the thread as a tombstone.
    // Nothing about it is interactive any more: no quoted reply, no
    // swipe, no long press, no text to copy.
    const gone = isDeleted(m);
    const rawText = gone ? "" : String(m.text || "").trim();
    const encodedText = encodeURIComponent(rawText);
    // A message that is ONLY a link gets a bare bubble around the
    // embed instead of a chat bubble with a URL in it. An event link
    // counts: sharing an event is the message.
    const isMediaOnly = !gone &&
      /^https?:\/\/[^\s]+$/.test(rawText) &&
      (/(youtube\.com|youtu\.be|open\.spotify\.com)/.test(rawText) || !!eventIdFromUrl(rawText));

    // ---- Quoted reply ----
    let replyBlock = "";
    if (m.replyTo && !gone) {
      const replyName = m.replyTo.senderUid === state.uid ? "You" : displayNameFor(m.replyTo.senderUid);
      const target = safeId(m.replyTo.id);
      const timeAttr = target ? `data-target-id="${target}"` : "";
      replyBlock = `<div class="msg-replied-to" ${timeAttr}><b>${escapeHtml(replyName)}:</b> ${escapeHtml(m.replyTo.text)}</div>`;
    }

    const swipeIconHTML = gone
      ? ""
      : isMe
        ? `<div class="swipe-reply-icon right"><i class='bx bx-reply' style="transform: scaleX(-1);"></i></div>`
        : `<div class="swipe-reply-icon left"><i class='bx bx-reply'></i></div>`;

    // "edited" rides inside the bubble, where it is read as part of
    // the message. An embed-only bubble has no room, so its tag goes
    // on the timestamp line instead.
    const edited = isEdited(m);
    const editedTag = edited && !isMediaOnly
      ? `<span class="msg-edited">edited</span>`
      : "";

    const bodyHTML = gone
      ? `<span class="msg-gone"><i class='bx bx-block'></i>This message was deleted</span>`
      : formatMessage(rawText, isMediaOnly);

    // Reaction chips sit under the bubble, on the bubble's own side.
    // The emoji is never written into the handler — the chip carries
    // the message id and the emoji's INDEX in the fixed list, so the
    // markup still holds ids and numbers only.
    const reacts = gone ? [] : reactionSummary(m, state.uid);
    const reactsHTML = reacts.length
      ? `<div class="msg-reacts">` + reacts.map((r) => `
          <span class="react-chip${r.mine ? " mine" : ""}" role="button"
                onclick="event.stopPropagation(); window.toggleReaction('${safeId(m.id)}', ${REACTIONS.indexOf(r.emoji)})"
                >${r.emoji}<b>${r.count}</b></span>`).join("") + `</div>`
      : "";

    // Tapping shows when it was sent — and, if it was rewritten, when.
    // The edit time does NOT repeat the day. formatTime() always spells
    // one out ("Today at 22:48"), so an edited message read "Today at
    // 22:48 · edited Today at 22:51" — the word Today twice, in mono,
    // on a line under a bubble. A message is almost always edited on
    // the day it was sent (the window is fifteen minutes), so the day
    // is said once and the second stamp is just the clock. On the rare
    // edit that crosses midnight it falls back to the full form,
    // because then the day genuinely is new information.
    const sameDay = edited &&
      new Date(msOf(m.time)).toDateString() === new Date(msOf(m.editedAt)).toDateString();
    const editStamp = edited
      ? (sameDay
          ? new Date(msOf(m.editedAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : formatTime(m.editedAt))
      : "";
    const timeLine = edited
      ? `${escapeHtml(formatTime(m.time))} \u00b7 edited ${escapeHtml(editStamp)}`
      : escapeHtml(formatTime(m.time));

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
      <div id="msg-${safeId(m.id)}" class="msg-wrapper" style="animation-delay:${enterDelay}s;"
           data-sender-uid="${escapeHtml(m.senderUid)}"
           data-time="${escapeHtml(msOf(m.time))}"
           data-msg-id="${safeId(m.id)}"
           data-text="${escapeHtml(encodedText)}"
           data-deleted="${gone ? "1" : ""}"
           data-align="${isMe ? "end" : "start"}"
           onclick="window.handleMessageTap(event, this)">
        ${swipeIconHTML}
        ${nameTagHTML}
        <div class="${isMediaOnly ? "msg-bubble media-only" : "msg-bubble"} ${gone ? "msg-gone-bubble" : ""} ${isMe ? "msg-sent" : "msg-received"} ${shape}">
           ${replyBlock}
           ${bodyHTML}
           ${editedTag}
        </div>
        ${reactsHTML}
        <div class="msg-time" style="text-align: ${isMe ? "right" : "left"}">
           ${timeLine}
        </div>
      </div>`;

    if (i === msgs.length - 1 && isMe && state.currentChatType === "direct") {
      const statusHtml = state.currentChatData && state.currentChatData.unreadByUid === ""
        ? `Read <i class='bx bx-check-double'></i>`
        : `Sent <i class='bx bx-check'></i>`;
      html += `<div class="msg-status" id="readReceipt">${statusHtml}</div>`;
    }

    blocks.push({ key: safeId(m.id) || ("t" + i), html: html.slice(blockStart) });
  });

  const typingHTML = `
    <div id="typingBubble" class="typing-indicator hidden" style="align-items: center; margin-top: 8px;">
      <span id="typingName" style="font-size: 12px; font-weight: 700; color: var(--primary); margin-right: 8px;"></span>
      <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
    </div>`;

  // A different conversation is not a re-render; it is a fresh page.
  if (paintedChat !== state.currentChat) forgetPaintedMessages();
  paintedChat = state.currentChat;

  // Chase the bottom only if that is where the reader already was.
  // Yanking somebody who had scrolled up back down to the newest
  // message is the other half of the rudeness this diff removes.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const holder = document.createElement("div");
  const keep = new Set();
  let prev = null;

  blocks.forEach((b) => {
    const was = paintedNodes.get(b.key);
    const reusable = paintedMsgs.get(b.key) === b.html
      && Array.isArray(was) && was.length
      && was.every((n) => n.isConnected && n.parentNode === box);

    let nodes;
    if (reusable) {
      nodes = was;
    } else {
      if (Array.isArray(was)) was.forEach((n) => { if (n.parentNode === box) n.remove(); });
      holder.innerHTML = b.html.trim();
      nodes = Array.from(holder.children);
    }

    nodes.forEach((node) => {
      const slot = prev ? prev.nextElementSibling : box.firstElementChild;
      if (node !== slot) box.insertBefore(node, slot);
      prev = node;
      keep.add(node);
    });

    paintedMsgs.set(b.key, b.html);
    paintedNodes.set(b.key, nodes);
  });

  // Whatever the blocks no longer claim: messages that went, and the
  // leftovers of any block that was rebuilt.
  Array.from(box.children).forEach((el) => {
    if (el.id === "typingBubble" || keep.has(el)) return;
    el.remove();
  });
  [...paintedMsgs.keys()].forEach((key) => {
    if (blocks.some((b) => b.key === key)) return;
    paintedMsgs.delete(key);
    paintedNodes.delete(key);
  });

  // The typing bubble always sits last.
  let typing = document.getElementById("typingBubble");
  if (!typing) box.insertAdjacentHTML("beforeend", typingHTML);
  else if (typing !== box.lastElementChild) box.appendChild(typing);

  fillEventEmbeds(box);

  if (keepScroll) {
    // Stay anchored to the message you were looking at.
    box.scrollTop = box.scrollHeight - keepScroll.heightBefore + keepScroll.topBefore;
  } else if (atBottom) {
    box.scrollTop = box.scrollHeight;
  }

  // The icebreaker unlocks as soon as the other side replies.
  //
  // Guarded, because this is a WRITE inside a render: renderMessages
  // runs on every snapshot, on every local patch and on every page of
  // history, and the condition stays true until the chat document's own
  // listener echoes the new status back. That was one redundant write
  // per repaint in the gap.
  if (
    state.currentChatType === "direct" &&
    state.currentChatStatus === "icebreaker" &&
    theirMessageCount > 0 &&
    state.currentChatInitiatorUid === state.uid &&
    unlockingChat !== state.currentChat
  ) {
    const chatId = state.currentChat;
    unlockingChat = chatId;
    db.collection("chats").doc(chatId)
      .set({ status: "unlocked" }, { merge: true })
      .catch(() => { if (unlockingChat === chatId) unlockingChat = ""; });
  }

  updateChatFooterUI();
  updateReadReceipts();
  updateTypingIndicator();
}

/**
 * Turn the empty event placeholders into real cards.
 *
 * The markup for a shared event is deliberately identical for everyone
 * — just the id — because the message diffing compares markup, and a
 * card that rendered differently depending on what the viewer happened
 * to have cached would churn. So the filling happens here, after the
 * thread is painted, from the cache when it is there and from one read
 * when it is not. primeEvent de-duplicates, so ten messages about the
 * same event cost one read between them.
 */
function fillEventEmbeds(box) {
  const nodes = box.querySelectorAll("[data-event-embed]");
  if (!nodes.length) return;

  // A finished event is not automatically a dead one: it keeps a stub
  // in Recap for as long as recapRules says it earned. So the card has
  // THREE states, not two, and the button has to name which — View for
  // something still on, Recap for something that has a stub to go to,
  // and nothing at all once there is no card anywhere to land on. The
  // `dead` class is what stops it looking tappable; showSharedEvent
  // refuses the trip either way, but a card that looks like a link and
  // does nothing is its own small bug.
  const paint = (el, e) => {
    if (!e) {
      el.classList.add("gone", "dead");
      el.querySelector(".event-embed-title").innerText = "This event has ended";
      el.querySelector(".event-embed-go").innerText = "";
      return;
    }
    const now = Date.now();
    const live = now >= e.startTime && e.expiresAt > now;
    const ended = e.expiresAt <= now;
    const stub = ended && inRecap(e, now, state.uid);
    el.classList.toggle("gone", ended);
    el.classList.toggle("dead", ended && !stub);
    el.style.setProperty("--vibe", vibeColor(e.tag));
    el.querySelector(".event-embed-tag").innerText = e.tag || "";
    el.querySelector(".event-embed-title").innerText = e.title || "";
    el.querySelector(".event-embed-meta").innerText =
      [ended ? "Ended" : live ? "Happening now" : "Starting soon", e.place].filter(Boolean).join(" \u00b7 ");
    el.querySelector(".event-embed-go").innerText = ended ? (stub ? "Recap" : "") : "View";
  };

  nodes.forEach((el) => {
    const id = el.getAttribute("data-event-embed");
    const cached = state.eventCache[id];
    if (cached) return paint(el, cached);
    primeEvent(id).then((e) => { if (el.isConnected) paint(el, e); });
  });
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
    // Newest conversation first, bounded. Needs the composite index in
    // firestore.indexes.json (userUids CONTAINS + lastUpdated DESC) —
    // without it deployed this listener errors and retryInbox() gives
    // up after five tries.
    .orderBy("lastUpdated", "desc")
    .limit(INBOX_LIMIT)
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

        // The share sheet offers these. Recording them here means it
        // costs nothing: this listener is already open and already has
        // the answer, in the right order.
        state.recentChatUids = chats
          .map((c) => (c.userUids || []).find((u) => u !== state.uid))
          .filter(Boolean);

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
            <div class="chat-item" onclick="window.openChat('${id}', '${otherId}')" style="${isUnread ? "background: var(--unread-bg); border-left: 4px solid var(--primary);" : ""}">
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
