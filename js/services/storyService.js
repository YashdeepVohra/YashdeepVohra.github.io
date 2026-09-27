/**
 * STORIES — a photo that stays up for 2, 3, 6, 12 or 24 hours.
 *
 *   stories/{id}  { uid, photo, caption, hours, audience, song, createdAt }
 *
 * `audience` is "public", or "followers" for a private account (the
 * rules refuse a public story from a private account). When a story
 * ends is createdAt + hours, the server's clock plus the author's
 * choice — nobody can date one to stay up for a week.
 *
 * Rings sit at the head of the live rail, before the live events, in
 * forest rather than ember: a story is not happening this minute.
 *
 * COST, and why it is shaped like this: public stories come through
 * ONE listener (newest 60 of the last day), which bills each story once
 * and then only what changes; private accounts you follow are one get()
 * each, at most ten, every half hour. Nothing at all runs while
 * features.photos is off.
 */
import { db, FieldValue, Timestamp } from '../config/firebase.js';
import { state } from '../state/store.js';
import { features } from '../config/features.js';
import { toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { openOverlay, closeOverlay, isOverlayOpen } from '../utils/overlays.js';
import { renderAvatar, escapeHtml, safeId, msOf } from '../utils/formatters.js';
import { displayNameFor, avatarFor, primeUsers } from './userService.js';
import { isBlocked } from './blockService.js';
import { PHOTO, isOurPhotoUrl } from './photoRules.js';
import { pickImages, compressImage, uploadPhoto, deletePhotoByUrl, photoError } from './photoService.js';
import { isHidden, onHiddenChange } from './hiddenService.js';
import {
  STORY_HOURS, DEFAULT_HOURS, CAPTION_MAX, storyRings, isStoryLive, leftLabel, cleanSong,
  songService, spotifyEmbedFor
} from './storyRules.js';

const DAY = 24 * 3600 * 1000;
const SHOW_MS = 6000;               // how long one story stays on screen
const PRIVATE_EVERY = 30 * 60 * 1000;
const PRIVATE_MAX = 10;

const stories = new Map();          // id -> story
let publicUnsub = null;
let publicSince = 0;
let privateAt = 0;
let repaint = () => {};

export function onStoriesChange(fn) { repaint = fn; }
onHiddenChange(() => repaint());

/* ---------- Seen, per browser ---------- */
const SEEN_KEY = "ls-seen-stories-v1";
let seen = null;
function seenSet() {
  if (seen) return seen;
  try { seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch (e) { seen = new Set(); }
  return seen;
}
function markSeen(id) {
  const s = seenSet();
  if (s.has(id)) return;
  s.add(id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-400))); } catch (e) { /* this visit only */ }
}

/* ---------- Loading ---------- */
function take(docs, { replacePublic = false } = {}) {
  if (replacePublic) {
    [...stories.values()].forEach((s) => { if (s.audience === "public" && s.uid !== state.uid) stories.delete(s.id); });
  }
  docs.forEach((d) => {
    const s = Object.assign({ id: d.id }, d.data());
    if (isOurPhotoUrl(s.photo, "stories", s.uid)) stories.set(s.id, s);
  });
}

export function loadStories({ force = false } = {}) {
  if (!features.photos || !state.uid) return;
  const now = Date.now();
  const since = Timestamp.fromMillis(now - DAY);

  // Re-listen every hour so the 24-hour window moves with the clock.
  if (force || !publicUnsub || now - publicSince > 3600 * 1000) {
    if (publicUnsub) publicUnsub();
    publicSince = now;
    publicUnsub = db.collection("stories")
      .where("audience", "==", "public")
      .where("createdAt", ">", since)
      .orderBy("createdAt", "desc")
      .limit(60)
      .onSnapshot((snap) => {
        take(snap.docs, { replacePublic: true });
        primeUsers([...new Set([...stories.values()].map((s) => s.uid))]).then(() => repaint()).catch(() => {});
        repaint();
      }, (e) => console.error("Stories failed:", e.code || e.message));
  }

  if (force || now - privateAt > PRIVATE_EVERY) {
    privateAt = now;
    const privateFollowed = (state.following || [])
      .filter((u) => state.userCache[u] && state.userCache[u].private === true)
      .slice(0, PRIVATE_MAX);
    // Yours too: a private account's own stories are "followers" only,
    // so the public listener never brings them back.
    [state.uid].concat(privateFollowed).forEach((u) => {
      db.collection("stories").where("uid", "==", u).where("createdAt", ">", since).get()
        .then((snap) => { take(snap.docs); repaint(); })
        .catch((e) => console.warn("Stories for one person failed:", e.code || e.message));
    });
  }
}

export function stopStories() {
  if (publicUnsub) publicUnsub();
  publicUnsub = null;
  publicSince = 0;
  privateAt = 0;
  stories.clear();
}

function rings(now = Date.now()) {
  return storyRings([...stories.values()], {
    me: state.uid,
    seen: seenSet(),
    hidden: (id) => isHidden("story", id),
    blocked: (u) => isBlocked(u),
    now
  });
}

/* ---------- The rail ---------- */
const PLUS = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>`;

/** The story rings, to go at the head of the live rail. "" while off. */
export function storyRailHtml(now = Date.now()) {
  if (!features.photos || !state.uid) return "";
  const all = rings(now);
  const mine = all.find((r) => r.uid === state.uid);
  const me = `
    <button class="live-story story-item mine" onclick="window.${mine ? "openStories('" + safeId(state.uid) + "')" : "addStory()"}" title="Your story">
      <span class="story-ring ${mine ? (mine.allSeen ? "seen" : "photo") : "none"}">
        <span class="story-inner">${renderAvatar(avatarFor(state.uid))}</span>
      </span>
      <span class="story-plus" role="button" aria-label="Add to your story" onclick="event.stopPropagation(); window.addStory()">${PLUS}</span>
      <span class="story-label">You</span>
    </button>`;
  const others = all.filter((r) => r.uid !== state.uid).map((r) => {
    const uid = safeId(r.uid);
    if (!uid) return "";
    return `
      <button class="live-story story-item" onclick="window.openStories('${uid}')" title="${escapeHtml(displayNameFor(r.uid))}'s story">
        <span class="story-ring ${r.allSeen ? "seen" : "photo"}">
          <span class="story-inner">${renderAvatar(avatarFor(r.uid))}</span>
        </span>
        <span class="story-label">${escapeHtml(displayNameFor(r.uid))}</span>
      </button>`;
  }).join("");
  return me + others + `<span class="rail-divider" aria-hidden="true"></span>`;
}

/* ---------- Watching ---------- */
const view = { ring: -1, index: 0, timer: 0, list: [] };

function clearTimer() { clearTimeout(view.timer); view.timer = 0; }

export function openStories(uid) {
  if (!features.photos) return;
  view.list = rings();
  view.ring = view.list.findIndex((r) => r.uid === uid);
  if (view.ring === -1) return;
  // Start at the first one you haven't seen.
  const r = view.list[view.ring];
  const firstNew = r.stories.findIndex((s) => !seenSet().has(s.id));
  view.index = firstNew === -1 ? 0 : firstNew;
  if (!isOverlayOpen("storyViewer")) {
    openOverlay("storyViewer", { onClose: () => { clearTimer(); view.ring = -1; repaint(); } });
  }
  showStory();
}

export function closeStories() {
  clearTimer();
  if (isOverlayOpen("storyViewer")) closeOverlay("storyViewer");
}

function current() {
  const r = view.list[view.ring];
  return r ? { ring: r, story: r.stories[view.index] } : null;
}

function showStory() {
  clearTimer();
  const c = current();
  if (!c || !c.story) return closeStories();
  const { ring, story } = c;
  const now = Date.now();
  markSeen(story.id);

  const $ = (id) => document.getElementById(id);
  const img = $("svImg");
  if (img) img.src = story.photo;
  // The next one starts loading now, so the tap to it is instant.
  const next = ring.stories[view.index + 1] || (view.list[view.ring + 1] && view.list[view.ring + 1].stories[0]);
  if (next) { const pre = new Image(); pre.src = next.photo; }

  const bars = $("svBars");
  if (bars) {
    bars.innerHTML = ring.stories.map((s, i) =>
      `<span class="sv-bar${i < view.index ? " done" : ""}${i === view.index ? " on" : ""}"><span></span></span>`).join("");
    bars.style.setProperty("--sv-ms", SHOW_MS + "ms");
  }
  const who = $("svWho");
  if (who) {
    const mins = Math.max(1, Math.round((now - msOf(story.createdAt)) / 60000));
    const ago = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
    who.innerHTML = `
      <span class="sv-av tappable" onclick="window.openStoryAuthor()">${renderAvatar(avatarFor(ring.uid))}</span>
      <span class="sv-name tappable" onclick="window.openStoryAuthor()">${escapeHtml(ring.uid === state.uid ? "Your story" : displayNameFor(ring.uid))}</span>
      <span class="sv-meta">${escapeHtml(ago)} · ${escapeHtml(leftLabel(story, now))}</span>`;
  }
  const cap = $("svCaption");
  if (cap) { cap.textContent = story.caption || ""; cap.classList.toggle("hidden", !story.caption); }

  const song = $("svSong");
  if (song) {
    const service = story.song ? songService(story.song.url) : "";
    song.classList.toggle("hidden", !service);
    song.innerHTML = service ? `
      <button type="button" class="sv-song-card" onclick="event.stopPropagation(); window.playStorySong()">
        <span class="sv-note" aria-hidden="true">♪</span>
        <span class="sv-song-text"><b>${escapeHtml(story.song.title)}</b><small>Listen on ${escapeHtml(service)}</small></span>
      </button>` : "";
  }

  const acts = $("svActs");
  if (acts) {
    acts.innerHTML = ring.uid === state.uid
      ? `<button type="button" class="pv-act" onclick="event.stopPropagation(); window.addStory()">Add another</button>
         <button type="button" class="pv-act danger" onclick="event.stopPropagation(); window.deleteStory()">Delete</button>`
      : `<button type="button" class="pv-act" onclick="event.stopPropagation(); window.reportStory()">Report</button>`;
  }

  view.timer = setTimeout(storyNext, SHOW_MS);
}

export function storyNext() {
  const c = current();
  if (!c) return;
  if (view.index < c.ring.stories.length - 1) { view.index++; return showStory(); }
  if (view.ring < view.list.length - 1) { view.ring++; view.index = 0; return showStory(); }
  closeStories();
}

export function storyPrev() {
  if (view.index > 0) { view.index--; return showStory(); }
  if (view.ring > 0) { view.ring--; view.index = view.list[view.ring].stories.length - 1; return showStory(); }
  showStory();
}

/** Tapping the sticker. Spotify plays in its own player, right here —
    started by YOU, never under the photo on its own. Anything else
    opens on its own site. Either way the story stops advancing. */
export function playStorySong() {
  const c = current();
  if (!c || !c.story.song) return;
  clearTimer();
  document.querySelector("#svBars .sv-bar.on")?.classList.add("paused");
  const url = c.story.song.url;
  const embed = spotifyEmbedFor(url);
  const song = document.getElementById("svSong");
  if (embed && song) {
    song.innerHTML = `<iframe class="sv-player" src="${escapeHtml(embed)}" title="Spotify" height="80"
      allow="autoplay; encrypted-media" loading="lazy"></iframe>`;
    return;
  }
  window.open(url, "_blank", "noopener");
}

export function openStoryAuthor() {
  const c = current();
  if (!c) return;
  closeStories();
  setTimeout(() => window.openProfileScreen?.(c.ring.uid), 80);
}

export async function deleteStory() {
  const c = current();
  if (!c || c.ring.uid !== state.uid) return;
  clearTimer();
  const yes = await askConfirm({ title: "Delete this story?", body: "It comes down for everyone now.", confirm: "Delete", danger: true });
  if (!yes) { view.timer = setTimeout(storyNext, SHOW_MS); return; }
  const s = c.story;
  stories.delete(s.id);
  closeStories();
  repaint();
  try {
    await db.collection("stories").doc(s.id).delete();
    deletePhotoByUrl(s.photo);
  } catch (e) {
    console.error("Story delete failed:", e.code || e.message);
    stories.set(s.id, s);
    repaint();
    toast("Couldn't delete that story.");
  }
}

export function reportStory() {
  const c = current();
  if (!c) return;
  closeStories();
  setTimeout(() => window.openReport?.(c.story.uid, {
    type: "story", id: c.story.id, excerpt: [c.story.caption || "", c.story.photo].filter(Boolean).join("\n")
  }), 80);
}

/* ---------- Making one ---------- */
const draft = { file: null, preview: "", hours: DEFAULT_HOURS };

export async function addStory() {
  if (!features.photos || !state.uid) return;
  closeStories();
  const [file] = await pickImages();
  if (!file) return;
  if (draft.preview) URL.revokeObjectURL(draft.preview);
  draft.file = file;
  draft.preview = URL.createObjectURL(file);
  draft.hours = DEFAULT_HOURS;
  const $ = (id) => document.getElementById(id);
  if ($("scPreview")) $("scPreview").src = draft.preview;
  ["scCaption", "scSongUrl", "scSongTitle"].forEach((id) => { if ($(id)) $(id).value = ""; });
  paintHours();
  onStoryCaption();
  openOverlay("storyComposer", { onClose: () => {
    if (draft.preview) URL.revokeObjectURL(draft.preview);
    draft.file = null; draft.preview = "";
  } });
}

function paintHours() {
  const row = document.getElementById("scHours");
  if (!row) return;
  row.innerHTML = STORY_HOURS.map((h) => `
    <button type="button" class="sc-hour${h === draft.hours ? " on" : ""}" aria-pressed="${h === draft.hours}"
            onclick="window.pickStoryHours(${h})">${h}h</button>`).join("");
}

export function pickStoryHours(h) {
  if (!STORY_HOURS.includes(Number(h))) return;
  draft.hours = Number(h);
  paintHours();
}

export function onStoryCaption() {
  const el = document.getElementById("scCaption");
  const count = document.getElementById("scCaptionCount");
  if (el && count) count.innerText = `${el.value.length}/${CAPTION_MAX}`;
}

/** Paste a Spotify link and, if the title is empty, fill it from Spotify. */
export async function onStorySongUrl() {
  const url = (document.getElementById("scSongUrl")?.value || "").trim();
  const title = document.getElementById("scSongTitle");
  const hint = document.getElementById("scSongHint");
  const service = songService(url);
  if (hint) hint.innerText = url && !service
    ? "That link isn't one we can use — try Spotify, YouTube Music, JioSaavn, Apple Music, Gaana or Wynk."
    : service ? `On ${service}. People tap the sticker to listen there.` : "";
  if (service !== "Spotify" || !title || title.value.trim()) return;
  try {
    const res = await fetch("https://open.spotify.com/oembed?url=" + encodeURIComponent(url));
    const data = await res.json();
    if (data && typeof data.title === "string" && !title.value.trim()) title.value = data.title.slice(0, 100);
  } catch (e) { /* they can type it */ }
}

export function closeStoryComposer() {
  if (isOverlayOpen("storyComposer")) closeOverlay("storyComposer");
}

let posting = false;
export async function postStory() {
  if (!features.photos || !draft.file || posting) return;
  const $ = (id) => document.getElementById(id);
  const caption = ($("scCaption")?.value || "").replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX);
  const songUrl = ($("scSongUrl")?.value || "").trim();
  const song = songUrl ? cleanSong(songUrl, $("scSongTitle")?.value) : null;
  if (songUrl && !song) {
    return toast(songService(songUrl) ? "Add the song's name too." : "That song link isn't one we can use.");
  }
  posting = true;
  const btn = $("scPost");
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i>`; }
  let url = "";
  try {
    const blob = await compressImage(draft.file, { edge: PHOTO.EVENT_EDGE });
    url = await uploadPhoto("stories", blob);
    const ref = db.collection("stories").doc();
    const body = {
      uid: state.uid,
      photo: url,
      caption,
      hours: draft.hours,
      audience: state.isPrivate === true ? "followers" : "public",
      song,
      createdAt: FieldValue.serverTimestamp()
    };
    await ref.set(body);
    stories.set(ref.id, Object.assign({}, body, { id: ref.id, createdAt: Date.now() }));
    closeStoryComposer();
    repaint();
    toast(`Your story is up for ${draft.hours} hours.`);
  } catch (e) {
    console.error("Story failed:", e.code || e.message);
    if (url) deletePhotoByUrl(url);
    toast(e.code === "permission-denied" ? "That story was refused." : photoError(e));
  } finally {
    posting = false;
    if (btn) { btn.disabled = false; btn.innerText = "Share"; }
  }
}

/** For tests and for the rail: is anything of yours up right now? */
export function myLiveStories(now = Date.now()) {
  return [...stories.values()].filter((s) => s.uid === state.uid && isStoryLive(s, now));
}
