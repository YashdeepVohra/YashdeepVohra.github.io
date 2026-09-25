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
import { displayNameFor, usernameFor, avatarFor, primeUsers } from './userService.js';
import { searchPeople } from './searchService.js';
import { sendDirectText } from './chatService.js';
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
   ---------------------------------------------------------------------
   PICK, THEN SEND. The sheet used to be a row of the eight people you
   last talked to, and tapping a face sent the event there and then:
   one person per open, nobody you hadn't already messaged, and a
   misplaced thumb was a message you couldn't take back. It works the
   way every other app's does now: search anyone, tick as many people
   as you like, add a line if you want, and Send. Nothing leaves until
   Send is pressed.

   Who is offered, for free: everyone you have a conversation with
   (the inbox listener already knows, newest first), then the people
   you follow. Typing two letters also asks the people search, which is
   the same one-or-two query batches the search screen costs.

   Below the list, the ways OUT of the app: copy the link, WhatsApp
   (where a campus actually talks), and the phone's own share sheet.
   ------------------------------------------------------------------- */

let sharingId = "";
const picked = new Set();        // uids ticked, in the order they were ticked
let pickOrder = [];
let searchQ = "";
let remoteHits = [];             // uids from the people search, best first
let searchTimer = 0;
const CANDIDATE_CAP = 40;        // rows offered before you type anything
const PRIME_CAP = 24;            // profiles worth a read to put names on them

const svg = (body, extra = "") =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
const GLYPH = {
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>`),
  link: svg(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>`),
  chat: svg(`<path d="M20.5 11.6a8.4 8.4 0 0 1-12.3 7.5L3.5 20.5l1.4-4.5A8.4 8.4 0 1 1 20.5 11.6z"/>`),
  more: svg(`<path d="M12 3.5v11"/><path d="M8 7.5l4-4 4 4"/><path d="M5.5 12.5v6a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-6"/>`),
  close: svg(`<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`),
  tick: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
};

function sheetEl() {
  let el = document.getElementById("shareSheet");
  if (el) return el;

  el = document.createElement("div");
  el.id = "shareSheet";
  el.className = "modal-overlay share-overlay hidden";
  el.innerHTML = `
    <div class="modal-content share-sheet" role="dialog" aria-modal="true" aria-labelledby="shareHeading">
      <div class="share-grab" aria-hidden="true"></div>
      <div class="share-head">
        <div class="share-head-text">
          <b id="shareHeading">Share</b>
          <span id="shareTitle"></span>
        </div>
        <button class="share-x" data-share="cancel" aria-label="Close">${GLYPH.close}</button>
      </div>
      <label class="search-field share-search">
        ${GLYPH.search}
        <input id="shareSearch" type="search" placeholder="Search people" autocomplete="off"
               autocapitalize="none" spellcheck="false" enterkeyhint="search">
      </label>
      <div class="share-list" id="sharePeople" role="listbox" aria-multiselectable="true"></div>
      <div class="share-foot">
        <div class="share-send hidden" id="shareSendBar">
          <input id="shareNote" type="text" maxlength="300" placeholder="Write a message…" autocomplete="off">
          <button class="share-send-btn" data-share="send" id="shareSendBtn">Send</button>
        </div>
        <div class="share-out" id="shareOut">
          <button class="share-out-btn" data-share="copy"><span class="share-out-ico">${GLYPH.link}</span><span>Copy link</span></button>
          <button class="share-out-btn" data-share="whatsapp"><span class="share-out-ico wa">${GLYPH.chat}</span><span>WhatsApp</span></button>
          <button class="share-out-btn" data-share="more" id="shareMore"><span class="share-out-ico">${GLYPH.more}</span><span>More</span></button>
        </div>
      </div>
    </div>`;

  el.addEventListener("click", (e) => {
    if (e.target === el) return closeShare();
    const who = e.target.closest("[data-uid]");
    if (who) return togglePick(who.getAttribute("data-uid"));
    const btn = e.target.closest("[data-share]");
    if (!btn) return;
    const act = btn.getAttribute("data-share");
    if (act === "cancel") return closeShare();
    if (act === "send") return sendPicked();
    if (act === "copy") return copyLink();
    if (act === "whatsapp") return shareWhatsApp();
    if (act === "more") return shareLink();
  });
  // Send keeps the keyboard where it is, like the chat composer.
  el.querySelector("#shareSendBtn").addEventListener("mousedown", (e) => e.preventDefault());

  const search = el.querySelector("#shareSearch");
  search.addEventListener("input", () => onShareSearch(search.value));
  const note = el.querySelector("#shareNote");
  note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendPicked(); } });

  document.body.appendChild(el);
  return el;
}

/** Everyone offered before you type: conversations first, then who you follow. */
function candidates() {
  const seen = new Set();
  const out = [];
  const add = (uid) => {
    if (!uid || uid === state.uid || seen.has(uid) || isBlocked(uid) || !safeId(uid)) return;
    seen.add(uid);
    out.push(uid);
  };
  (state.recentChatUids || []).forEach(add);
  (state.following || []).forEach(add);
  return out.slice(0, CANDIDATE_CAP);
}

function matchesLocal(uid, q) {
  const needle = q.toLowerCase().replace(/^@/, "");
  return displayNameFor(uid).toLowerCase().includes(needle)
      || usernameFor(uid).toLowerCase().includes(needle);
}

/** The rows on screen right now, in order. */
function visibleUids() {
  const q = searchQ.trim();
  const base = candidates();
  if (!q) {
    // Anyone ticked from a search stays on the list after you clear it.
    const extra = pickOrder.filter((u) => !base.includes(u));
    return [...extra, ...base];
  }
  const local = base.filter((u) => matchesLocal(u, q));
  const seen = new Set(local);
  const remote = remoteHits.filter((u) => !seen.has(u) && u !== state.uid && !isBlocked(u));
  return [...local, ...remote];
}

function personRow(uid) {
  const id = safeId(uid);
  if (!id) return "";
  const on = picked.has(uid);
  return `
    <button class="share-row${on ? " on" : ""}" data-uid="${id}" role="option" aria-selected="${on}">
      <span class="share-face">${renderAvatar(avatarFor(uid))}</span>
      <span class="share-who">
        <b>${escapeHtml(displayNameFor(uid))}</b>
        <small>@${escapeHtml(usernameFor(uid))}</small>
      </span>
      <span class="share-check" aria-hidden="true">${GLYPH.tick}</span>
    </button>`;
}

function paintList() {
  const box = document.getElementById("sharePeople");
  if (!box) return;
  const uids = visibleUids();
  if (uids.length) {
    box.innerHTML = uids.map(personRow).join("");
    return;
  }
  const q = searchQ.trim();
  box.innerHTML = q
    ? (q.length < 2
        ? `<p class="share-empty">Keep typing to search everyone.</p>`
        : `<p class="share-empty">${searchTimer ? "Searching…" : "Nobody by that name yet."}</p>`)
    : `<p class="share-empty">Search for someone above, or send the link below.</p>`;
}

function paintFoot() {
  const n = picked.size;
  document.getElementById("shareSendBar")?.classList.toggle("hidden", n === 0);
  document.getElementById("shareOut")?.classList.toggle("hidden", n > 0);
  const btn = document.getElementById("shareSendBtn");
  if (btn) btn.textContent = n > 1 ? `Send to ${n}` : "Send";
}

function togglePick(uid) {
  if (!safeId(uid)) return;
  if (picked.has(uid)) {
    picked.delete(uid);
    pickOrder = pickOrder.filter((u) => u !== uid);
  } else {
    picked.add(uid);
    pickOrder.push(uid);
  }
  // Flip the one row rather than repaint the list: the list must not
  // jump under the finger that is ticking down it.
  const row = document.querySelector(`#sharePeople [data-uid="${safeId(uid)}"]`);
  if (row) {
    row.classList.toggle("on", picked.has(uid));
    row.setAttribute("aria-selected", String(picked.has(uid)));
  }
  paintFoot();
}

function onShareSearch(value) {
  searchQ = String(value || "");
  clearTimeout(searchTimer);
  searchTimer = 0;
  remoteHits = [];
  const q = searchQ.trim();
  if (q.length >= 2) {
    const asked = searchQ;
    searchTimer = setTimeout(async () => {
      let hits = [];
      try { hits = await searchPeople(q); } catch (e) { hits = []; }
      if (asked !== searchQ) return;         // a newer keystroke won
      searchTimer = 0;
      remoteHits = hits;
      paintList();
    }, 260);
  }
  paintList();
}

export function openShare(eventId) {
  if (!isEventId(eventId)) return;
  const e = state.eventCache[eventId];
  if (!e) return;

  sharingId = eventId;
  picked.clear();
  pickOrder = [];
  searchQ = "";
  remoteHits = [];
  clearTimeout(searchTimer);
  searchTimer = 0;

  const el = sheetEl();
  const title = document.getElementById("shareTitle");
  if (title) title.innerText = String(e.title || "");
  const search = el.querySelector("#shareSearch");
  if (search) search.value = "";
  const note = el.querySelector("#shareNote");
  if (note) note.value = "";
  // The phone's own sheet only where there is one.
  el.querySelector("#shareMore")?.classList.toggle("hidden", typeof navigator.share !== "function");

  paintList();
  paintFoot();
  openOverlay("shareSheet", {
    onClose: () => {
      sharingId = "";
      clearTimeout(searchTimer);
      searchTimer = 0;
    }
  });

  // Names for people who are only a uid so far (someone you follow but
  // have never opened). Capped, and most are in the 6h profile cache.
  const missing = candidates().filter((u) => !state.userCache[u]).slice(0, PRIME_CAP);
  if (missing.length) {
    primeUsers(missing).then(() => { if (sharingId === eventId) paintList(); }).catch(() => {});
  }
}

export function closeShare() {
  const active = document.activeElement;
  if (active && active.closest && active.closest("#shareSheet")) active.blur();
  closeOverlay("shareSheet");
}

function sentLabel(uids) {
  const first = displayNameFor(uids[0]);
  if (uids.length === 1) return first;
  if (uids.length === 2) return `${first} and ${displayNameFor(uids[1])}`;
  return `${first} and ${uids.length - 1} others`;
}

/**
 * Send the event to everyone ticked. The sheet closes first and the
 * sends run behind it — the screen never waits on the network — and
 * one toast says how it went.
 */
async function sendPicked() {
  const eventId = sharingId;
  const e = state.eventCache[eventId];
  const who = pickOrder.filter((u) => picked.has(u));
  if (!e || !who.length) return;

  const noteEl = document.getElementById("shareNote");
  const note = String((noteEl && noteEl.value) || "").trim().slice(0, 300);
  const link = eventLink(eventId);
  // The note goes in the SAME message as the link: to a stranger the
  // opener is a single message, and a second one would be refused.
  const text = note ? `${note}\n${link}` : link;

  closeShare();

  const results = await Promise.allSettled(who.map((uid) => sendDirectText(uid, text)));
  const ok = who.filter((_, i) => results[i].status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason || {});
  failed.forEach((err) => console.error("Share to chat failed:", err.code || err.message));

  if (!failed.length) return toast("Sent to " + sentLabel(ok) + ".");
  const waiting = failed.some((err) => err.code === "icebreaker-used" || err.code === "permission-denied");
  if (!ok.length) {
    return toast(waiting && failed.length === 1
      ? "Wait for them to reply before sending another."
      : "Couldn't send that.");
  }
  toast(`Sent to ${sentLabel(ok)}. ${failed.length} couldn't be sent${waiting ? " — they haven't replied yet" : ""}.`);
}

async function copyToClipboard(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const pad = document.createElement("textarea");
  pad.value = url;
  pad.setAttribute("readonly", "");
  pad.style.cssText = "position:fixed;top:-1000px;opacity:0;";
  document.body.appendChild(pad);
  pad.select();
  document.execCommand("copy");
  pad.remove();
}

async function copyLink() {
  const eventId = sharingId;
  if (!state.eventCache[eventId]) return closeShare();
  closeShare();
  try {
    await copyToClipboard(eventLink(eventId));
    toast("Link copied.");
  } catch (err) {
    toast("Couldn't copy that link.");
  }
}

function shareWhatsApp() {
  const eventId = sharingId;
  const e = state.eventCache[eventId];
  closeShare();
  if (!e) return;
  const msg = `${shareText(e)}\n${eventLink(eventId)}`;
  const url = "https://wa.me/?text=" + encodeURIComponent(msg);
  // Not "noopener" in the features: with it, window.open returns null
  // even on success, and this would then navigate away as well.
  const win = window.open(url, "_blank");
  if (win) { try { win.opener = null; } catch (e) {} }
  else window.location.href = url;
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
    await copyToClipboard(url);
    toast("Link copied.");
  } catch (err) {
    toast("Couldn't copy that link.");
  }
}
