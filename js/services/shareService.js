// ==========================================
// SHARING AN EVENT
// ==========================================
//
// Two routes out of a card, and they are deliberately different
// things:
//
//   INTO A CHAT   the event is posted as a LIVE CARD in the thread,
//                 with a Join button. Your friend joins from the
//                 conversation instead of being bounced out of it.
//   OUT OF THE APP  a livesociya.com link, handed to the phone's own
//                 share sheet.
//
// The in-chat card needs no schema change and no rules change. The
// message is an ordinary message whose text is the link; the renderer
// in utils/formatters.js turns a link we recognise into a card, the
// same way it already does for YouTube and Spotify. That also means a
// link somebody pastes by hand renders identically, and a client that
// has not been updated still shows something useful — the link.
//
// COST. Rendering a shared card costs ONE read, once, for an event the
// viewer does not already have in the cache, and nothing at all for one
// that is already in their feed — which is the common case, since the
// people you share with are on the same campus looking at the same
// sixty events.
// ==========================================

import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { toast } from '../utils/ui.js';
import { escapeHtml, safeId } from '../utils/formatters.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { eventLink, eventIdFromUrl, shareText, isEventId } from './shareRules.js';
import { displayNameFor, avatarFor, directChatId } from './userService.js';
import { renderAvatar } from '../utils/formatters.js';
import { isBlocked } from './blockService.js';

/* ---------------------------------------------------------------------
   Opening a link
   ------------------------------------------------------------------- */

// A link can land before there is an app to show it in: the page may
// still be booting, or the person may not be signed in yet. So the id
// is taken off the URL immediately and held until the feed exists.
let pendingEventId = "";

/**
 * Read the event id off the current URL and clean it away.
 *
 * Cleaning matters: leave `?e=` in the address bar and every later
 * reload re-opens the same event, which feels broken the second time.
 * replaceState so it does not add a history entry to go back through.
 */
export function capturePendingEvent(loc = window.location) {
  const id = eventIdFromUrl(loc.href);
  if (!id) return "";
  pendingEventId = id;
  try {
    history.replaceState(history.state, "", loc.pathname);
  } catch (e) { /* never worth failing a boot over */ }
  return id;
}

export function peekPendingEvent() {
  return pendingEventId;
}

/**
 * Show whatever the link pointed at, once the app is usable.
 *
 * Two cases. Usually the event is still live and already in the feed,
 * so this is a scroll and a flash — no read. Otherwise it is fetched
 * once, which covers an event that has moved to Recap, or one outside
 * the sixty the feed carries.
 */
export async function consumePendingEvent(open) {
  const id = pendingEventId;
  pendingEventId = "";
  if (!id || !state.uid) return false;

  if (state.eventCache[id]) { open(id); return true; }

  try {
    const doc = await db.collection("events").doc(id).get();
    if (!doc.exists) { toast("That event has ended."); return false; }
    state.eventCache[id] = { id: doc.id, ...doc.data() };
    open(id);
    return true;
  } catch (e) {
    console.error("Shared event fetch failed:", e.code || e.message);
    toast("Couldn't open that event.");
    return false;
  }
}

/* ---------------------------------------------------------------------
   Filling in cards for events the viewer has never seen
   ------------------------------------------------------------------- */

// Ids already fetched or in flight, so ten messages linking the same
// event cost one read between them rather than ten.
const pendingFetches = new Map();

export function primeEvent(eventId) {
  if (!isEventId(eventId)) return Promise.resolve(null);
  if (state.eventCache[eventId]) return Promise.resolve(state.eventCache[eventId]);
  if (pendingFetches.has(eventId)) return pendingFetches.get(eventId);

  const p = db.collection("events").doc(eventId).get()
    .then((doc) => {
      if (!doc.exists) return null;
      state.eventCache[eventId] = { id: doc.id, ...doc.data() };
      return state.eventCache[eventId];
    })
    .catch((e) => {
      console.error("Shared card fetch failed:", e.code || e.message);
      return null;
    })
    .finally(() => { pendingFetches.delete(eventId); });

  pendingFetches.set(eventId, p);
  return p;
}

/* ---------------------------------------------------------------------
   The share sheet
   ------------------------------------------------------------------- */

let sharingId = "";

function sheetEl() {
  let el = document.getElementById("shareSheet");
  if (el) return el;

  el = document.createElement("div");
  el.id = "shareSheet";
  el.className = "modal-overlay hidden";
  el.innerHTML = `
    <div class="modal-content share-sheet">
      <div class="share-head">
        <b>Send this to</b>
        <span id="shareTitle"></span>
      </div>
      <div class="share-people" id="sharePeople"></div>
      <div class="action-list">
        <button class="action-row" data-share="link"><i class='bx bx-link'></i><span>Share a link</span></button>
      </div>
      <button class="btn-ghost" data-share="cancel">Cancel</button>
    </div>`;
  el.addEventListener("click", (e) => {
    if (e.target === el) return closeShare();
    const who = e.target.closest("[data-uid]");
    if (who) return sendToChat(who.getAttribute("data-uid"));
    const btn = e.target.closest("[data-share]");
    if (!btn) return;
    const act = btn.getAttribute("data-share");
    if (act === "cancel") return closeShare();
    if (act === "link") return shareLink();
  });
  document.body.appendChild(el);
  return el;
}

/** The people you already talk to, newest conversation first. */
function recentPeople() {
  return (state.recentChatUids || [])
    .filter((uid) => uid && uid !== state.uid && !isBlocked(uid))
    .slice(0, 8);
}

export function openShare(eventId) {
  if (!isEventId(eventId)) return;
  const e = state.eventCache[eventId];
  if (!e) return;

  sharingId = eventId;
  sheetEl();

  const title = document.getElementById("shareTitle");
  if (title) title.innerText = String(e.title || "");

  const people = document.getElementById("sharePeople");
  if (people) {
    const uids = recentPeople();
    people.innerHTML = uids.length
      ? uids.map((uid) => {
          const id = safeId(uid);
          if (!id) return "";
          return `
            <button class="share-person" data-uid="${id}">
              <span class="share-face">${renderAvatar(avatarFor(uid))}</span>
              <span>${escapeHtml(displayNameFor(uid))}</span>
            </button>`;
        }).join("")
      : `<p class="share-empty">No conversations yet — share a link instead.</p>`;
  }

  openOverlay("shareSheet", { onClose: () => { sharingId = ""; } });
}

export function closeShare() {
  closeOverlay("shareSheet");
}

/** Post the event into a direct chat as a card. */
async function sendToChat(otherUid) {
  const eventId = sharingId;
  const e = state.eventCache[eventId];
  closeShare();
  if (!e || !safeId(otherUid)) return;

  const chatId = directChatId(state.uid, otherUid);
  const link = eventLink(eventId);

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) {
      // Sharing an event with somebody you have never messaged is the
      // friendliest possible opener, so it goes through the same
      // icebreaker rules as any other first message rather than around
      // them — status is decided by the chat document, not here.
      await chatRef.set({
        userUids: [state.uid, otherUid].sort(),
        createdAt: Date.now(),
        initiatedByUid: state.uid,
        status: "icebreaker",
        icebreakerUsed: false,
        unreadByUid: otherUid,
        typingUid: "",
        lastUpdated: Date.now()
      });
      const batch = db.batch();
      batch.set(chatRef, { icebreakerUsed: true }, { merge: true });
      batch.set(chatRef.collection("messages").doc(),
        { senderUid: state.uid, text: link, time: Date.now(), replyTo: null });
      await batch.commit();
    } else {
      await chatRef.set({ unreadByUid: otherUid, lastUpdated: Date.now(), typingUid: "" }, { merge: true });
      await chatRef.collection("messages").doc()
        .set({ senderUid: state.uid, text: link, time: Date.now(), replyTo: null });
    }
    toast("Sent to " + displayNameFor(otherUid) + ".");
  } catch (err) {
    console.error("Share to chat failed:", err.code || err.message);
    toast(err.code === "permission-denied"
      ? "Wait for them to reply before sending another."
      : "Couldn't send that.");
  }
}

/** Out of the app: the phone's own share sheet, or the clipboard. */
export async function shareLink() {
  const eventId = sharingId;
  const e = state.eventCache[eventId];
  closeShare();
  if (!e) return;

  const url = eventLink(eventId);
  const text = shareText(e);

  if (navigator.share) {
    try {
      await navigator.share({ title: "livesociya", text, url });
      return;
    } catch (err) {
      // Dismissing the sheet throws AbortError. That is a decision,
      // not a failure, so it must not fall through to copying.
      if (err && err.name === "AbortError") return;
    }
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const pad = document.createElement("textarea");
      pad.value = url;
      pad.setAttribute("readonly", "");
      pad.style.cssText = "position:fixed;top:-1000px;opacity:0;";
      document.body.appendChild(pad);
      pad.select();
      document.execCommand("copy");
      pad.remove();
    }
    toast("Link copied.");
  } catch (err) {
    toast("Couldn't copy that link.");
  }
}
