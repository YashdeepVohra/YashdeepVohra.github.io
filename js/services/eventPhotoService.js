/**
 * Photos on an event: the tray in the create/edit sheet, and getting
 * them onto the event without making publish wait.
 *
 * PUBLISH STILL DOES NOT WAIT (docs/feed.md, "optimistic first"). The
 * event goes out exactly as before; the photos are squeezed and
 * uploaded behind it and land on the card as one `photos` update a
 * few seconds later. A photo that fails costs the photo, never the
 * event. The first photo is the cover — the one the feed shows.
 *
 * All of this is hidden while features.photos is off.
 */
import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { features } from '../config/features.js';
import { toast } from '../utils/ui.js';
import { escapeHtml } from '../utils/formatters.js';
import { PHOTO, eventPhotos } from './photoRules.js';
import { pickImages, compressImage, uploadPhoto, deletePhotoByUrl, photoError } from './photoService.js';

// What the sheet is holding: { url } for a photo already on the event,
// { file, preview } for one picked this visit and not uploaded yet.
let draft = [];
let original = [];

function revoke(list) {
  list.forEach((p) => { if (p.preview) URL.revokeObjectURL(p.preview); });
}

/** Fresh tray: empty for a new event, the event's own photos to edit. */
export function resetPhotoTray(existing = []) {
  revoke(draft);
  original = existing.slice(0, PHOTO.EVENT_MAX);
  draft = original.map((url) => ({ url }));
  paintPhotoTray();
}

export function paintPhotoTray() {
  const tray = document.getElementById("createPhotos");
  const count = document.getElementById("photoCount");
  if (count) count.innerText = `${draft.length}/${PHOTO.EVENT_MAX}`;
  if (!tray) return;
  const tiles = draft.map((p, i) => `
    <div class="tray-tile">
      <img src="${escapeHtml(p.preview || p.url)}" alt="">
      ${i === 0 ? `<span class="tray-cover">Cover</span>` : ""}
      <button type="button" class="tray-x" aria-label="Remove photo" onclick="window.removeDraftPhoto(${i})">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>
      </button>
    </div>`).join("");
  const add = draft.length < PHOTO.EVENT_MAX ? `
    <button type="button" class="tray-add" onclick="window.addDraftPhotos()">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span>${draft.length ? "Add" : "Add photos"}</span>
    </button>` : "";
  tray.innerHTML = tiles + add;
}

export async function addDraftPhotos() {
  if (!features.photos) return;
  const files = await pickImages({ multiple: true });
  const room = PHOTO.EVENT_MAX - draft.length;
  if (files.length > room) toast(`Up to ${PHOTO.EVENT_MAX} photos — kept the first ${room}.`);
  files.slice(0, Math.max(0, room)).forEach((file) => {
    draft.push({ file, preview: URL.createObjectURL(file) });
  });
  paintPhotoTray();
}

export function removeDraftPhoto(index) {
  const [gone] = draft.splice(Number(index), 1);
  if (gone && gone.preview) URL.revokeObjectURL(gone.preview);
  paintPhotoTray();
}

/** Has the tray changed from what the event already has? */
export function trayChanged() {
  return draft.length !== original.length
    || draft.some((p, i) => p.url !== original[i]);
}

/**
 * Upload whatever in the tray is new, in tray order, and hand back the
 * final list of URLs. Each picked file is compressed on the device
 * first. A file that fails is dropped with one toast, not the lot.
 */
async function uploadTray(items) {
  const urls = [];
  let failed = 0;
  for (const p of items) {
    if (p.url) { urls.push(p.url); continue; }
    try {
      const blob = await compressImage(p.file, { edge: PHOTO.EVENT_EDGE });
      urls.push(await uploadPhoto("events", blob));
    } catch (e) {
      failed++;
      console.error("Event photo failed:", e.code || e.message);
      if (failed === 1) toast(photoError(e));
    }
  }
  return urls;
}

/**
 * Called right after publish/save with the event's id. Takes the tray
 * as it stands (the sheet is about to be cleared), uploads in the
 * background, then writes `photos` in one update. Photos taken off
 * the event are deleted from storage once the update has landed.
 */
export function commitTray(eventId) {
  if (!features.photos || !eventId || !trayChanged()) return;
  const items = draft.slice();
  const before = original.slice();
  draft = [];
  original = [];
  const uploading = items.some((p) => !p.url);
  if (uploading) toast("Adding your photos…");

  (async () => {
    const urls = await uploadTray(items);
    try {
      await db.collection("events").doc(eventId).update({ photos: urls });
      const e = state.eventCache[eventId];
      if (e) e.photos = urls;
      before.filter((u) => !urls.includes(u)).forEach(deletePhotoByUrl);
      if (uploading) toast(urls.length ? "Photos added." : "No photos were added.");
    } catch (err) {
      console.error("Saving photos failed:", err.code || err.message);
      // Nothing points at the new files now, so they go too.
      urls.filter((u) => !before.includes(u)).forEach(deletePhotoByUrl);
      toast("Couldn't add the photos to your event.");
    } finally {
      items.forEach((p) => { if (p.preview) URL.revokeObjectURL(p.preview); });
    }
  })();
}

/** Deleting an event takes its photos with it. */
export function deleteEventPhotos(e) {
  eventPhotos(e || {}).forEach(deletePhotoByUrl);
}
