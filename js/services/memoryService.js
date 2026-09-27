/**
 * MEMORIES — what an event becomes once it is over.
 *
 * Photos from the people who went (three each), likes, and comments,
 * on the event page of any finished event. Nothing here exists while
 * an event is live: that is what hype and the group chat are for.
 *
 *   events/{id}/memories/{uid_n}   { uid, photo, createdAt }
 *   events/{id}/social/likes       { uids: [...] }      one doc, one read
 *   events/{id}/comments/{cid}     { uid, text, createdAt }
 *
 * COST. Read once when the page opens (three gets, ~30 photos and the
 * newest 50 comments at most) and never listened to: a finished event
 * does not change fast enough to be worth a listener on every phone.
 * Your own writes are painted straight away and not read back.
 *
 * Likes and comments work now. Adding photos needs features.photos.
 */
import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { features } from '../config/features.js';
import { toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { renderAvatar, escapeHtml, safeId, formatInboxTime, msOf } from '../utils/formatters.js';
import { displayNameFor, avatarFor, primeUsers } from './userService.js';
import { isBlocked } from './blockService.js';
import { PHOTO, isOurPhotoUrl } from './photoRules.js';
import { pickImages, compressImage, uploadPhoto, deletePhotoByUrl, photoError } from './photoService.js';
import { isHidden, onHiddenChange } from './hiddenService.js';

export const COMMENT_MAX = 300;
const cache = new Map();   // eventId -> { loaded, loading, photos, likes, comments }
let repaint = () => {};

/** eventPage registers its painter here, so this file needs no import of it. */
export function onMemoriesChange(fn) { repaint = fn; }
onHiddenChange(() => repaint());

function entry(eventId) {
  if (!cache.has(eventId)) cache.set(eventId, { loaded: false, loading: false, failed: false, photos: [], likes: [], comments: [] });
  return cache.get(eventId);
}

const eventRef = (id) => db.collection("events").doc(id);

export function loadMemories(eventId, { force = false } = {}) {
  const m = entry(eventId);
  if (m.loading || (m.loaded && !force)) return;
  m.loading = true;
  const ref = eventRef(eventId);
  Promise.all([
    ref.collection("memories").orderBy("createdAt").limit(30).get(),
    ref.collection("social").doc("likes").get(),
    ref.collection("comments").orderBy("createdAt", "desc").limit(50).get()
  ]).then(([photos, likes, comments]) => {
    m.photos = photos.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    m.likes = (likes.exists && Array.isArray(likes.data().uids)) ? likes.data().uids : [];
    // Newest 50, shown oldest first, like any thread.
    m.comments = comments.docs.map((d) => Object.assign({ id: d.id }, d.data())).reverse();
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

/* ---------------------------------------------------------------- */
/* What the event page paints                                         */
/* ---------------------------------------------------------------- */

const HEART = (on) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
  fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="${on ? 0 : 1.8}" stroke-linejoin="round">
  <path d="M12 20.3S3.8 15.4 3.8 9.3A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.2 2.3c0 6.1-8.2 11-8.2 11Z"/></svg>`;

function visiblePhotos(e, m) {
  return m.photos.filter((p) => isOurPhotoUrl(p.photo, "memories", p.uid)
    && !isBlocked(p.uid) && !isHidden("memory", `${e.id}_${p.id}`));
}
function visibleComments(e, m) {
  return m.comments.filter((c) => !isBlocked(c.uid) && !isHidden("comment", `${e.id}_${c.id}`));
}

/** How many photos you may still add to this event. */
function roomFor(e, m) {
  if (!(e.participantUids || []).includes(state.uid)) return 0;
  return PHOTO.MEMORY_PER_PERSON - m.photos.filter((p) => p.uid === state.uid).length;
}

export function memoriesHtml(e) {
  const id = safeId(e.id);
  if (!id) return "";
  const m = entry(id);
  if (!m.loaded) {
    return `
      <div class="ep-section mem">
        <div class="ep-label">Memories</div>
        <div class="mem-note">${m.failed
          ? `Couldn't load these. <button type="button" class="mem-link" onclick="window.retryMemories('${id}')">Try again</button>`
          : "Loading…"}</div>
      </div>`;
  }

  const photos = visiblePhotos(e, m);
  const room = features.photos ? roomFor(e, m) : 0;
  const liked = m.likes.includes(state.uid);
  const likeCount = m.likes.filter((u) => !isBlocked(u)).length;
  const comments = visibleComments(e, m);

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
    : `<div class="mem-note">No photos from this one yet.</div>`;

  const list = comments.map((c) => {
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
          <div class="cmt-text">${escapeHtml(c.text)}</div>
          <div class="cmt-acts">
            ${canRemove ? `<button type="button" class="mem-link" onclick="window.deleteComment('${id}', '${cid}')">Delete</button>` : ""}
            ${mine ? "" : `<button type="button" class="mem-link" onclick="window.reportComment('${id}', '${cid}')">Report</button>`}
          </div>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="ep-section mem">
      <div class="ep-label">Memories</div>
      ${grid}
      <div class="mem-bar">
        <button type="button" class="mem-like${liked ? " on" : ""}" aria-pressed="${liked}" onclick="window.toggleMemoryLike('${id}')">
          ${HEART(liked)} <span>${likeCount || "Like"}</span>
        </button>
        <span class="mem-count">${comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "No comments yet"}</span>
      </div>
      ${list ? `<div class="cmt-list">${list}</div>` : ""}
    </div>`;
}

/* ---------------------------------------------------------------- */
/* Doing things                                                       */
/* ---------------------------------------------------------------- */

/** Optimistic, then the network, then back if it failed (feed.md). */
export function toggleMemoryLike(eventId) {
  const m = entry(eventId);
  if (!m.loaded || !state.uid) return;
  const was = m.likes.includes(state.uid);
  m.likes = was ? m.likes.filter((u) => u !== state.uid) : m.likes.concat(state.uid);
  repaint();
  const ref = eventRef(eventId).collection("social").doc("likes");
  const write = was
    ? ref.update({ uids: FieldValue.arrayRemove(state.uid) })
    : ref.set({ uids: FieldValue.arrayUnion(state.uid) }, { merge: true });
  write.catch((e) => {
    console.error("Like failed:", e.code || e.message);
    m.likes = was ? m.likes.concat(state.uid) : m.likes.filter((u) => u !== state.uid);
    repaint();
    toast("Couldn't save that.");
  });
}

export async function postComment(eventId) {
  const input = document.getElementById("epCommentInput");
  const text = (input?.value || "").trim().slice(0, COMMENT_MAX);
  const m = entry(eventId);
  if (!text || !state.uid || !m.loaded) return;
  const ref = eventRef(eventId).collection("comments").doc();
  const local = { id: ref.id, uid: state.uid, text, createdAt: Date.now() };
  m.comments = m.comments.concat(local);
  input.value = "";
  repaint();
  try {
    await ref.set({ uid: state.uid, text, createdAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.error("Comment failed:", e.code || e.message);
    m.comments = m.comments.filter((c) => c.id !== ref.id);
    if (input && !input.value) input.value = text;
    repaint();
    toast(e.code === "permission-denied" ? "You can't comment on this one." : "Couldn't post that. Try again.");
  }
}

export async function deleteComment(eventId, commentId) {
  const m = entry(eventId);
  const c = m.comments.find((x) => x.id === commentId);
  if (!c) return;
  const yes = await askConfirm({ title: "Delete this comment?", body: "It can't be undone.", confirm: "Delete", danger: true });
  if (!yes) return;
  m.comments = m.comments.filter((x) => x.id !== commentId);
  repaint();
  eventRef(eventId).collection("comments").doc(commentId).delete().catch((e) => {
    console.error("Comment delete failed:", e.code || e.message);
    m.comments = m.comments.concat(c).sort((a, b) => (msOf(a.createdAt) || 0) - (msOf(b.createdAt) || 0));
    repaint();
    toast("Couldn't delete that.");
  });
}

export function reportComment(eventId, commentId) {
  const c = entry(eventId).comments.find((x) => x.id === commentId);
  if (!c) return;
  window.openReport?.(c.uid, { type: "comment", id: `${eventId}_${commentId}`, excerpt: c.text });
}

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

export function retryMemories(eventId) {
  loadMemories(eventId, { force: true });
}
