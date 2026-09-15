// ==========================================
// ASKING BEFORE DOING SOMETHING IRREVERSIBLE
// ==========================================
//
// window.confirm() works, and that is all it does. It paints a grey
// system box over the app with the URL in it, it cannot be styled, it
// blocks the whole page while it is up, and on a phone it reads as the
// browser interrupting rather than the app asking. Every one of those
// is a small crack in the illusion that this is an app.
//
// Same job, in the app's own language: one sheet, reused, returning a
// promise so a caller reads exactly like it did with confirm().
//
//   if (!(await askConfirm({ ... }))) return;
//
// It uses the same overlay stack as every other layer, so the Android
// back button and Escape dismiss it as a cancel, like they should.
// ==========================================

import { escapeHtml } from './formatters.js';
import { openOverlay, closeOverlay } from './overlays.js';

let settle = null;

/** Close the sheet and hand the answer back to whoever is waiting. */
function finish(answer) {
  const done = settle;
  settle = null;
  closeOverlay("confirmSheet");
  if (done) done(answer);
}

export function confirmYes() { finish(true); }
export function confirmNo() { finish(false); }

/**
 * Ask, and resolve to true only if they actually said yes. Dismissing
 * by any route — Cancel, back, Escape, tapping the backdrop — is a no,
 * because the safe answer to "are you sure?" is always no.
 */
export function askConfirm({ title, body = "", confirm = "Confirm", cancel = "Cancel", danger = false }) {
  // A second ask while one is open would strand the first caller.
  if (settle) finish(false);

  const sheet = document.getElementById("confirmSheet");
  if (!sheet) return Promise.resolve(window.confirm(title));

  const titleEl = document.getElementById("confirmTitle");
  const bodyEl = document.getElementById("confirmBody");
  const yesEl = document.getElementById("confirmYes");
  const noEl = document.getElementById("confirmNo");

  if (titleEl) titleEl.innerText = String(title || "Are you sure?");
  if (bodyEl) {
    bodyEl.innerHTML = escapeHtml(String(body)).replace(/\n/g, "<br>");
    bodyEl.classList.toggle("hidden", !body);
  }
  if (yesEl) {
    yesEl.innerText = String(confirm);
    yesEl.classList.toggle("danger-btn", !!danger);
  }
  if (noEl) noEl.innerText = String(cancel);

  openOverlay("confirmSheet", { onClose: () => { if (settle) finish(false); } });
  setTimeout(() => yesEl?.focus(), 120);

  return new Promise((resolve) => { settle = resolve; });
}
