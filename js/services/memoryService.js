/**
 * MEMORIES — what an event becomes once it is over.
 *
 * Photos from the people who went (three each), likes, and comments.
 * Nothing here exists while an event is live: that is what hype and the
 * group chat are for.
 *
 *   events/{id}/memories/{uid_n}   { uid, photo, createdAt }
 *   events/{id}/social/likes       { uids: [...], comments: n, lastCommentId }
 *   events/{id}/comments/{cid}     { uid, text, createdAt }
 *
 * LIKE AND COMMENT FROM WHERE YOU ARE. A Recap card and a profile row
 * carry a like button and a comment button of their own, so nobody has
 * to open an event to react to it: the heart works in place, and the
 * comment button opens a sheet over whatever you were looking at.
 *
 * COST. The bar on a card needs ONE document, social/likes, which holds
 * both the likes and the comment COUNT — the count moves in the same
 * batch as the comment it counts, and the rules check that it does. It
 * is read only when the card scrolls into view, once per session. The
 * comments themselves (newest 50) and the photos are read only when
 * somebody opens them. Nothing here is a listener: a finished event is
 * not busy enough to be worth one on every phone.
 *
 * Likes and comments work now. Adding photos needs features.photos.
 */
import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { features } from '../config/features.js';
import { toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { openOverlay, closeOverlay, isOverlayOpen } from '../utils/overlays.js';
import { renderAvatar, escapeHtml, safeId, formatInboxTime, msOf } from '../utils/formatters.js';
import { displayNameFor, usernameFor, avatarFor, primeUsers, resolveUsernameToUid } from './userService.js';
import { isBlocked } from './blockService.js';
import { PHOTO, isOurPhotoUrl } from './photoRules.js';
import { pickImages, compressImage, uploadPhoto, deletePhotoByUrl, photoError } from './photoService.js';
import { isHidden, onHiddenChange } from './hiddenService.js';
import { stampPost, msUntilPostAllowed } from './limitsService.js';

export const COMMENT_MAX = 300;
const cache = new Map();   // eventId -> entry
const listeners = [];

/** Anything that shows memories registers its painter here. */
export function onMemoriesChange(fn) { listeners.push(fn); }
function repaint() {
  listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  paintSocial(document);
  paintSheet();
}
onHiddenChange(() => repaint());

function entry(eventId) {
  if (!cache.has(eventId)) {
    cache.set(eventId, {
      loaded: false, loading: false, failed: false,
      summaryLoaded: false, summaryLoading: false,
      photos: [], likes: [], comments: [], commentCount: 0
    });
  }
  return cache.get(eventId);
}

const eventRef = (id) => db.collection("events").doc(id);
const socialRef = (id) => eventRef(id).collection("social").doc("likes");

function takeSocial(m, doc) {
  const d = doc && doc.exists ? (doc.data() || {}) : {};
  m.likes = Array.isArray(d.uids) ? d.uids : [];
  m.commentCount = Math.max(0, Number(d.comments) || 0);
  m.summaryLoaded = true;
}

/** Just the bar: who liked it and how many comments. One read. */
export function loadSummary(eventId) {
  const m = entry(eventId);
  if (m.loaded || m.summaryLoaded || m.summaryLoading || m.loading) return;
  m.summaryLoading = true;
  socialRef(eventId).get()
    .then((doc) => takeSocial(m, doc))
    .catch((e) => console.warn("Likes failed to load:", e.code || e.message))
    .finally(() => { m.summaryLoading = false; repaint(); });
}

/** Everything: photos, the bar, and the newest 50 comments. */
export function loadMemories(eventId, { force = false } = {}) {
  const m = entry(eventId);
  if (m.loading || (m.loaded && !force)) return;
  m.loading = true;
  const ref = eventRef(eventId);
  Promise.all([
    ref.collection("memories").orderBy("createdAt").limit(30).get(),
    socialRef(eventId).get(),
    ref.collection("comments").orderBy("createdAt", "desc").limit(50).get()
  ]).then(([photos, social, comments]) => {
    m.photos = photos.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    takeSocial(m, social);
    // Newest 50, shown oldest first, like any thread.
    m.comments = comments.docs.map((d) => Object.assign({ id: d.id }, d.data()))
      .sort((a, b) => (msOf(a.createdAt) || 0) - (msOf(b.createdAt) || 0));
    // A count that has never been kept (or has drifted) is at least
    // what is on screen.
    m.commentCount = Math.max(m.commentCount, m.comments.length);
    m.loaded = true;
    m.failed = false;
    primeUsers([...new Set(m.photos.map((p) => p.uid).concat(m.comments.map((c) => c.uid)))])
      .then(() => repaint()).catch(() => {});
  }).catch((e) => {
    console.error("Memories failed to load:", e.code || e.message);
    m.failed = true;
  }).finally(() => {
    m.loading = false;
    repaint();
  });
}

export function retryMemories(eventId) {
  loadMemories(eventId, { force: true });
}

/* ---------------------------------------------------------------- */
/* Pieces of markup                                                   */
/* ---------------------------------------------------------------- */

const HEART = (on) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
  fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="${on ? 0 : 1.8}" stroke-linejoin="round">
  <path d="M12 20.3S3.8 15.4 3.8 9.3A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.2 2.3c0 6.1-8.2 11-8.2 11Z"/></svg>`;
const BUBBLE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 1 3.4 6.3L4.5 19.5l1.1-3.6A7.4 7.4 0 0 1 4.5 12Z"/></svg>`;

function visiblePhotos(e, m) {
  return m.photos.filter((p) => isOurPhotoUrl(p.photo, "memories", p.uid)
    && !isBlocked(p.uid) && !isHidden("memory", `${e.id}_${p.id}`));
}
function visibleComments(e, m) {
  return m.comments.filter((c) => !isBlocked(c.uid) && !isHidden("comment", `${e.id}_${c.id}`));
}
function likeCountOf(m) {
  return m.likes.filter((u) => !isBlocked(u)).length;
}

/** How many photos you may still add to this event. */
function roomFor(e, m) {
  if (!(e.participantUids || []).includes(state.uid)) return 0;
  return PHOTO.MEMORY_PER_PERSON - m.photos.filter((p) => p.uid === state.uid).length;
}

/**
 * @handles in a comment become a tap to that profile. The handle is
 * looked up only when tapped (one read), never to draw the comment.
 * Runs on ESCAPED text, and a handle is [A-Za-z0-9_] only, so the
 * handler never holds anything but those characters.
 */
function withMentions(escaped) {
  return escaped.replace(/(^|[\s(])@([A-Za-z0-9_]{3,20})\b/g,
    (all, pre, handle) => `${pre}<span class="mention" role="link" tabindex="0" onclick="event.stopPropagation(); window.openProfileByHandle('${handle.toLowerCase()}')">@${handle}</span>`);
}

/**
 * The like + comment buttons, in the same voice as a live card's
 * action row (`.act`: a glyph and a number, no box, colour is the only
 * feedback). `variant`:
 *   "card"  a Recap card: like, comment, and View at the right
 *   "mini"  a journal card on a profile: like and comment, small
 */
export function socialBarHtml(e, variant = "card") {
  const id = safeId(e.id);
  if (!id) return "";
  const m = entry(id);
  const ready = m.loaded || m.summaryLoaded;
  const liked = ready && m.likes.includes(state.uid);
  const likes = ready ? likeCountOf(m) : 0;
  const comments = ready ? m.commentCount : 0;
  const like = `
    <button type="button" class="act soc-btn${liked ? " on" : ""}" aria-pressed="${liked}"
            aria-label="${liked ? "Unlike" : "Like"}${likes ? `, ${likes}` : ""}"
            onclick="event.stopPropagation(); window.toggleMemoryLike('${id}')" ${ready ? "" : "disabled"}>
      ${HEART(liked)}<span>${likes || (variant === "mini" ? "" : "Like")}</span>
    </button>`;
  const comment = `
    <button type="button" class="act soc-btn" aria-label="Comments${comments ? `, ${comments}` : ""}"
            onclick="event.stopPropagation(); window.openComments('${id}')">
      ${BUBBLE}<span>${comments || (variant === "mini" ? "" : "Comment")}</span>
    </button>`;
  const view = variant === "card" ? `
    <button type="button" class="act soc-view" onclick="event.stopPropagation(); window.openEventPage('${id}')">
      View <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>` : "";
  return like + comment + view;
}

/**
 * Fill every [data-social] slot under `root`. The slot is EMPTY in the
 * card's own markup and filled here, after the feed's diff — the same
 * trick as the data-vt time slots — so a like arriving never makes the
 * card itself look changed and get rebuilt. Each slot asks for its one
 * read only when it scrolls into view.
 */
let watcher = null;
function watch(el) {
  if (!("IntersectionObserver" in window)) { loadSummary(el.dataset.social); return; }
  if (!watcher) {
    watcher = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        watcher.unobserve(en.target);
        loadSummary(en.target.dataset.social);
      });
    }, { rootMargin: "200px 0px" });
  }
  watcher.observe(el);
}

export function paintSocial(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("[data-social]").forEach((slot) => {
    const id = slot.dataset.social;
    const e = state.eventCache[id];
    if (!e) return;
    const html = socialBarHtml(e, slot.dataset.variant || "card");
    if (slot.dataset.html !== html) { slot.innerHTML = html; slot.dataset.html = html; }
    const m = entry(id);
    if (!m.loaded && !m.summaryLoaded && !slot.dataset.watched) {
      slot.dataset.watched = "1";
      watch(slot);
    }
  });
}

/** The comment list, for the event page or the sheet. */
function commentsHtml(e, m, where) {
  const id = safeId(e.id);
  const comments = visibleComments(e, m);
  if (!comments.length) {
    return `<div class="mem-note">${where === "sheet" ? "No comments yet. Say something." : "No comments yet."}</div>`;
  }
  return `<div class="cmt-list">${comments.map((c) => {
    const cid = safeId(c.id);
    const who = safeId(c.uid);
    const mine = c.uid === state.uid;
    const canRemove = mine || e.hostUid === state.uid;
    return `
      <div class="cmt">
        <div class="cmt-av tappable" onclick="window.openProfileScreen('${who}')">${renderAvatar(avatarFor(c.uid))}</div>
        <div class="cmt-body">
          <div class="cmt-head">
            <span class="cmt-name tappable" onclick="window.openProfileScreen('${who}')">${escapeHtml(displayNameFor(c.uid))}</span>
            <span class="cmt-when">${escapeHtml(formatInboxTime(msOf(c.createdAt) || Date.now()))}</span>
          </div>
          <div class="cmt-text">${withMentions(escapeHtml(c.text))}</div>
          <div class="cmt-acts">
            <button type="button" class="mem-link" onclick="window.replyToComment('${id}', '${cid}', '${where}')">Reply</button>
            ${canRemove ? `<button type="button" class="mem-link" onclick="window.deleteComment('${id}', '${cid}')">Delete</button>` : ""}
            ${mine ? "" : `<button type="button" class="mem-link" onclick="window.reportComment('${id}', '${cid}')">Report</button>`}
          </div>
        </div>
      </div>`;
  }).join("")}</div>`;
}

/** The whole memories block for the event page's side column. */
export function memoriesHtml(e) {
  const id = safeId(e.id);
  if (!id) return "";
  const m = entry(id);
  if (!m.loaded) {
    return `
      <div class="mem">
        <div class="ep-label">Memories</div>
        <div class="mem-note">${m.failed
          ? `Couldn't load these. <button type="button" class="mem-link" onclick="window.retryMemories('${id}')">Try again</button>`
          : "Loading…"}</div>
      </div>`;
  }

  const photos = visiblePhotos(e, m);
  const room = features.photos ? roomFor(e, m) : 0;
  const liked = m.likes.includes(state.uid);
  const likeCount = likeCountOf(m);
  const count = visibleComments(e, m).length;

  const tiles = photos.map((p) => `
    <button type="button" class="mem-tile" aria-label="Photo from ${escapeHtml(displayNameFor(p.uid))}"
            onclick="window.openMemoryPhoto('${id}', '${safeId(p.id)}')">
      <img src="${escapeHtml(p.photo)}" alt="" loading="lazy" decoding="async">
    </button>`).join("");
  const add = room > 0 ? `
    <button type="button" class="mem-add" onclick="window.addMemoryPhotos('${id}')">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span>Add yours</span>
    </button>` : "";
  const grid = tiles || add
    ? `<div class="mem-grid">${tiles}${add}</div>`
    : (features.photos ? `<div class="mem-note">No photos from this one yet.</div>` : "");

  // With no photos to show (and none to add), there is no "Memories"
  // heading over an empty space — just the likes and the comments.
  return `
    <div class="mem">
      ${grid ? `<div class="ep-label">Memories</div>${grid}` : ""}
      <div class="card-actions mem-bar${grid ? "" : " bare"}">
        <button type="button" class="act soc-btn mem-like${liked ? " on" : ""}" aria-pressed="${liked}" onclick="window.toggleMemoryLike('${id}')">
          ${HEART(liked)}<span>${likeCount || "Like"}</span>
        </button>
        <button type="button" class="act soc-btn" onclick="window.focusCommentBox()">
          ${BUBBLE}<span>${count ? `${count} comment${count === 1 ? "" : "s"}` : "Comment"}</span>
        </button>
      </div>
      ${count ? commentsHtml(e, m, "page") : ""}
    </div>`;
}

/* ---------------------------------------------------------------- */
/* The comment sheet: comments without leaving where you are          */
/* ---------------------------------------------------------------- */
let sheetId = "";
let sheetPainted = "";

export function openComments(eventId) {
  const id = safeId(eventId);
  const e = id && state.eventCache[id];
  if (!e) return;
  sheetId = id;
  sheetPainted = "";
  loadMemories(id);
  const title = document.getElementById("csTitle");
  if (title) title.textContent = e.title || "Comments";
  const input = document.getElementById("csInput");
  if (input) input.value = "";
  hideMentions("sheet");
  openOverlay("commentSheet", { onClose: () => { sheetId = ""; sheetPainted = ""; } });
  paintSheet();
}

export function postSheetComment() {
  if (sheetId) postComment(sheetId, "sheet");
}

export function closeComments() {
  if (isOverlayOpen("commentSheet")) closeOverlay("commentSheet");
}

/** From the sheet to the whole event page. */
export function openCommentsEvent() {
  const id = sheetId;
  closeComments();
  if (id) setTimeout(() => window.openEventPage?.(id), 60);
}

function paintSheet() {
  if (!sheetId) return;
  const list = document.getElementById("csList");
  const e = state.eventCache[sheetId];
  if (!list || !e) return;
  const m = entry(sheetId);
  const html = !m.loaded
    ? `<div class="mem-note">${m.failed
        ? `Couldn't load these. <button type="button" class="mem-link" onclick="window.retryMemories('${safeId(sheetId)}')">Try again</button>`
        : "Loading…"}</div>`
    : commentsHtml(e, m, "sheet");
  if (html === sheetPainted) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = html;
  sheetPainted = html;
  // New comments arrive at the bottom; follow them if you were there.
  if (atBottom) list.scrollTop = list.scrollHeight;
}

/* ---------------------------------------------------------------- */
/* Doing things                                                       */
/* ---------------------------------------------------------------- */

/** Optimistic, then the network, then back if it failed (feed.md). */
export function toggleMemoryLike(eventId) {
  const m = entry(eventId);
  if (!(m.loaded || m.summaryLoaded) || !state.uid) return;
  const was = m.likes.includes(state.uid);
  m.likes = was ? m.likes.filter((u) => u !== state.uid) : m.likes.concat(state.uid);
  repaint();
  const write = was
    ? socialRef(eventId).update({ uids: FieldValue.arrayRemove(state.uid) })
    : socialRef(eventId).set({ uids: FieldValue.arrayUnion(state.uid) }, { merge: true });
  write.catch((e) => {
    console.error("Like failed:", e.code || e.message);
    m.likes = was ? m.likes.concat(state.uid) : m.likes.filter((u) => u !== state.uid);
    repaint();
    toast("Couldn't save that.");
  });
}

const INPUT = { page: "epCommentInput", sheet: "csInput" };

/**
 * Post from the page's box or the sheet's. The comment and the count
 * go in ONE batch — the rules refuse a comment whose count did not
 * move with it, so the number on every card stays true.
 */
export async function postComment(eventId, where = "page") {
  const input = document.getElementById(INPUT[where] || INPUT.page);
  const text = (input?.value || "").trim().slice(0, COMMENT_MAX);
  const m = entry(eventId);
  if (!text || !state.uid) return;
  if (!m.loaded) { loadMemories(eventId); return; }
  // The rules want a few seconds between posts; say so before trying.
  if (msUntilPostAllowed() > 0) return toast("Slow down a moment — try again in a few seconds.");
  const ref = eventRef(eventId).collection("comments").doc();
  const local = { id: ref.id, uid: state.uid, text, createdAt: Date.now() };
  m.comments = m.comments.concat(local);
  m.commentCount += 1;
  input.value = "";
  hideMentions(where);
  repaint();
  const list = document.getElementById("csList");
  if (where === "sheet" && list) list.scrollTop = list.scrollHeight;
  try {
    const batch = db.batch();
    batch.set(ref, { uid: state.uid, text, createdAt: FieldValue.serverTimestamp() });
    batch.set(socialRef(eventId), { comments: FieldValue.increment(1), lastCommentId: ref.id }, { merge: true });
    stampPost(batch);
    await batch.commit();
  } catch (e) {
    console.error("Comment failed:", e.code || e.message);
    m.comments = m.comments.filter((c) => c.id !== ref.id);
    m.commentCount = Math.max(0, m.commentCount - 1);
    if (input && !input.value) input.value = text;
    repaint();
    toast(e.code === "permission-denied" ? "You can't comment on this one." : "Couldn't post that. Try again.");
  }
}

/** Delete, with the count, in one batch. Used by the admin screen too. */
export function deleteCommentBatch(eventId, commentId) {
  const batch = db.batch();
  batch.delete(eventRef(eventId).collection("comments").doc(commentId));
  batch.set(socialRef(eventId), { comments: FieldValue.increment(-1), lastCommentId: commentId }, { merge: true });
  return batch.commit();
}

export async function deleteComment(eventId, commentId) {
  const m = entry(eventId);
  const c = m.comments.find((x) => x.id === commentId);
  if (!c) return;
  const yes = await askConfirm({ title: "Delete this comment?", body: "It can't be undone.", confirm: "Delete", danger: true });
  if (!yes) return;
  m.comments = m.comments.filter((x) => x.id !== commentId);
  m.commentCount = Math.max(0, m.commentCount - 1);
  repaint();
  deleteCommentBatch(eventId, commentId).catch((e) => {
    console.error("Comment delete failed:", e.code || e.message);
    m.comments = m.comments.concat(c).sort((a, b) => (msOf(a.createdAt) || 0) - (msOf(b.createdAt) || 0));
    m.commentCount += 1;
    repaint();
    toast("Couldn't delete that.");
  });
}

export function reportComment(eventId, commentId) {
  const c = entry(eventId).comments.find((x) => x.id === commentId);
  if (!c) return;
  window.openReport?.(c.uid, { type: "comment", id: `${eventId}_${commentId}`, excerpt: c.text });
}

/** Reply = "@handle " at the front of the box you're in, and the cursor after it. */
export function replyToComment(eventId, commentId, where = "page") {
  const c = entry(eventId).comments.find((x) => x.id === commentId);
  const input = document.getElementById(INPUT[where] || INPUT.page);
  if (!c || !input) return;
  const handle = usernameFor(c.uid);
  const tag = handle ? `@${handle} ` : "";
  if (tag && !input.value.startsWith(tag)) input.value = tag + input.value.replace(/^@\S+\s*/, "");
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* not a text input */ }
}

/* ---------- @mentions: suggestions while you type ----------
   From people already on this event — the host, who went, who has
   commented — so suggesting costs no reads. Anybody else can still be
   tagged by typing their whole handle. */
function mentionCandidates(eventId) {
  const e = state.eventCache[eventId];
  const m = entry(eventId);
  const uids = new Set([e && e.hostUid].concat((e && e.participantUids) || [], m.comments.map((c) => c.uid)));
  uids.delete(state.uid);
  return [...uids].filter((u) => u && !isBlocked(u) && usernameFor(u));
}

function hideMentions(where) {
  const box = document.getElementById(where === "sheet" ? "csMentions" : "epMentions");
  if (box) { box.innerHTML = ""; box.classList.add("hidden"); }
}

export function onCommentInput(where, eventId) {
  const id = eventId || (where === "sheet" ? sheetId : "");
  const input = document.getElementById(INPUT[where] || INPUT.page);
  const box = document.getElementById(where === "sheet" ? "csMentions" : "epMentions");
  if (!input || !box || !id) return;
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = /(^|\s)@([A-Za-z0-9_]{0,20})$/.exec(upto);
  if (!m) return hideMentions(where);
  const q = m[2].toLowerCase();
  const hits = mentionCandidates(id).filter((u) =>
    usernameFor(u).toLowerCase().startsWith(q) || displayNameFor(u).toLowerCase().startsWith(q)).slice(0, 6);
  if (!hits.length) return hideMentions(where);
  box.innerHTML = hits.map((u) => `
    <button type="button" class="mention-pick" onmousedown="event.preventDefault()"
            onclick="window.pickMention('${where}', '${safeId(u)}')">
      <span class="cmt-av">${renderAvatar(avatarFor(u))}</span>
      <span><b>${escapeHtml(displayNameFor(u))}</b> <small>@${escapeHtml(usernameFor(u))}</small></span>
    </button>`).join("");
  box.classList.remove("hidden");
}

export function pickMention(where, uid) {
  const input = document.getElementById(INPUT[where] || INPUT.page);
  const handle = usernameFor(uid);
  if (!input || !handle) return;
  const at = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, at).replace(/@([A-Za-z0-9_]{0,20})$/, `@${handle} `);
  input.value = before + input.value.slice(at);
  input.focus();
  try { input.setSelectionRange(before.length, before.length); } catch (e) { /* fine */ }
  hideMentions(where);
}

/** A tap on @handle in a comment: one lookup, then their profile. */
export async function openProfileByHandle(handle) {
  const uid = await resolveUsernameToUid(handle);
  if (!uid) return toast(`No one is called @${handle}.`);
  closeComments();
  window.openProfileScreen?.(uid);
}

/* ---------- Photos ---------- */

/** Up to your three, compressed and uploaded, each a memory doc. */
export async function addMemoryPhotos(eventId) {
  const e = state.eventCache[eventId];
  const m = entry(eventId);
  if (!features.photos || !e || !m.loaded) return;
  const room = roomFor(e, m);
  if (room <= 0) return;
  const files = await pickImages({ multiple: true });
  if (!files.length) return;
  if (files.length > room) toast(`Up to ${PHOTO.MEMORY_PER_PERSON} each — kept the first ${room}.`);
  toast("Adding your photos…");
  const used = new Set(m.photos.filter((p) => p.uid === state.uid).map((p) => p.id));
  let added = 0;
  for (const file of files.slice(0, room)) {
    const n = [0, 1, 2].find((i) => !used.has(`${state.uid}_${i}`));
    if (n === undefined) break;
    const memId = `${state.uid}_${n}`;
    let url = "";
    try {
      const blob = await compressImage(file, { edge: PHOTO.EVENT_EDGE });
      url = await uploadPhoto("memories", blob);
      await eventRef(eventId).collection("memories").doc(memId)
        .set({ uid: state.uid, photo: url, createdAt: FieldValue.serverTimestamp() });
      used.add(memId);
      m.photos = m.photos.concat({ id: memId, uid: state.uid, photo: url, createdAt: Date.now() });
      added++;
      repaint();
    } catch (err) {
      console.error("Memory photo failed:", err.code || err.message);
      if (url) deletePhotoByUrl(url);
      toast(photoError(err));
      break;
    }
  }
  if (added) toast(added === 1 ? "Photo added." : `${added} photos added.`);
}

/** Tap a memory: the photo whole, with Remove or Report under it. */
export function openMemoryPhoto(eventId, memId) {
  const e = state.eventCache[eventId];
  const p = entry(eventId).photos.find((x) => x.id === memId);
  if (!e || !p) return;
  const mine = p.uid === state.uid;
  const actions = [];
  if (mine || e.hostUid === state.uid) actions.push({ label: "Remove", danger: true, run: () => removeMemoryPhoto(eventId, memId) });
  if (!mine) actions.push({ label: "Report", run: () => window.openReport?.(p.uid, { type: "memory", id: `${eventId}_${memId}`, excerpt: p.photo }) });
  window.openPhoto?.(p.photo, { caption: `From ${displayNameFor(p.uid)}`, actions });
}

async function removeMemoryPhoto(eventId, memId) {
  const m = entry(eventId);
  const p = m.photos.find((x) => x.id === memId);
  if (!p) return;
  const yes = await askConfirm({ title: "Remove this photo?", body: "It comes off the event for everyone.", confirm: "Remove", danger: true });
  if (!yes) return;
  m.photos = m.photos.filter((x) => x.id !== memId);
  repaint();
  try {
    await eventRef(eventId).collection("memories").doc(memId).delete();
    // Only the owner can delete the file itself; a host removing
    // somebody else's photo takes it off the event and no further.
    if (p.uid === state.uid) deletePhotoByUrl(p.photo);
  } catch (e) {
    console.error("Memory remove failed:", e.code || e.message);
    m.photos = m.photos.concat(p);
    repaint();
    toast("Couldn't remove that.");
  }
}
