/**
 * One photo, whole, on a dark ground — for anything tapped in a
 * thread, on an event page or in its memories. A layer like any other
 * (overlays.js), so the Android back button closes it.
 *
 * It only ever shows a URL that was already on screen: callers pass
 * the <img>'s own src, never text from a document. A caption is set
 * as text, and actions (Remove, Report) are closures handed in from
 * JavaScript, so nothing typed by anybody ends up in a handler.
 */
import { openOverlay, closeOverlay, isOverlayOpen } from './overlays.js';

let actions = [];

export function openPhoto(src, { caption = "", actions: acts = [] } = {}) {
  const box = document.getElementById("photoViewer");
  const img = document.getElementById("photoViewerImg");
  if (!box || !img || !/^https:\/\//.test(String(src || ""))) return;
  img.src = src;

  const cap = document.getElementById("photoViewerCaption");
  if (cap) { cap.textContent = caption; cap.classList.toggle("hidden", !caption); }

  actions = Array.isArray(acts) ? acts : [];
  const row = document.getElementById("photoViewerActs");
  if (row) {
    row.innerHTML = "";
    actions.forEach((a, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pv-act" + (a.danger ? " danger" : "");
      b.textContent = a.label;
      b.dataset.i = String(i);
      row.appendChild(b);
    });
    row.classList.toggle("hidden", !actions.length);
  }

  if (!isOverlayOpen("photoViewer")) {
    openOverlay("photoViewer", { onClose: () => { img.removeAttribute("src"); actions = []; } });
  }
}

export function closePhotoViewer() {
  if (isOverlayOpen("photoViewer")) closeOverlay("photoViewer");
}

/** A tap on the ground closes; a tap on an action runs it (after closing). */
export function onPhotoViewerTap(ev) {
  const btn = ev.target.closest && ev.target.closest(".pv-act");
  if (btn) {
    ev.stopPropagation();
    const a = actions[Number(btn.dataset.i)];
    closePhotoViewer();
    if (a && typeof a.run === "function") setTimeout(() => a.run(), 60);
    return;
  }
  closePhotoViewer();
}
