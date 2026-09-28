// ==========================================
// OVERLAY STACK & BACK BUTTON
// ==========================================
//
// Create-event, Settings, Search and the modals are full-screen layers.
// Before this they were opened by toggling a class, which meant the
// Android back button knew nothing about them: pressing back with the
// create sheet open threw you out of the app instead of closing it.
//
// Every overlay now pushes a history entry when it opens, so back pops
// exactly one layer — the behaviour every Android user expects.
//
// Buttons close by calling history.back() rather than hiding directly,
// so the visible state and the history stack can never disagree.
// ==========================================

const stack = [];

// history.back() fires popstate asynchronously. If we waited for it to
// hide the layer, any code that closes one overlay and opens another in
// the same tick would have its NEW layer torn down by the late back
// press. So a programmatic close hides immediately and records that one
// history entry is still owed; popOverlay() spends those credits before
// touching the real stack.
let pendingPops = 0;

/* WHAT THE TAB SAYS. A layer can carry a title ("Settings", an event's
   name), and ui.js — the one owner of document.title — is told every
   time the stack changes so the tab names whatever is on top. Without
   this the tab kept saying "Live now" over the create sheet, an event
   page, Settings and every other layer. */
let changeHook = null;
export function onOverlayChange(fn) { changeHook = fn; }
function changed() {
  if (typeof changeHook === "function") {
    try { changeHook(); } catch (_) { /* a title must never break a layer */ }
  }
}
/** Top first: [{ id, title }]. */
export function overlayTitles() {
  return stack.slice().reverse().map((e) => ({ id: e.id, title: e.title || "" }));
}
/** Rename an open layer (an event page whose event was renamed). */
export function setOverlayTitle(id, title) {
  const entry = stack.find((e) => e.id === id);
  if (!entry || entry.title === title) return;
  entry.title = title || "";
  changed();
}

export function isOverlayOpen(id) {
  return stack.some((entry) => entry.id === id);
}

export function anyOverlayOpen() {
  return stack.length > 0;
}

export function openOverlay(id, { onClose, title } = {}) {
  const el = document.getElementById(id);
  if (!el || isOverlayOpen(id)) return;

  el.classList.remove("hidden");
  stack.push({ id, onClose, title: title || "" });
  history.pushState({ overlay: id, depth: stack.length }, "", window.location.href);
  changed();
}

/** Ask to close a layer. Buttons should call this. */
export function closeOverlay(id) {
  if (!stack.length) return;

  const index = id ? stack.findIndex((entry) => entry.id === id) : stack.length - 1;
  if (index === -1) return;

  const [entry] = stack.splice(index, 1);
  document.getElementById(entry.id)?.classList.add("hidden");
  if (typeof entry.onClose === "function") entry.onClose();
  changed();

  // Hidden already; now let history catch up.
  pendingPops++;
  history.back();
}

/**
 * Pop the top layer. Called by the popstate handler.
 * Returns true if something was closed, so the caller knows the back
 * press has been consumed.
 */
export function popOverlay() {
  // A back press we asked for ourselves — the layer is already gone.
  if (pendingPops > 0) {
    pendingPops--;
    return true;
  }

  const entry = stack.pop();
  if (!entry) return false;
  document.getElementById(entry.id)?.classList.add("hidden");
  if (typeof entry.onClose === "function") entry.onClose();
  changed();
  return true;
}

export function isOverlayTop(id) {
  return stack.length > 0 && stack[stack.length - 1].id === id;
}

/**
 * Swap the top layer for another one, reusing its history entry.
 *
 * Closing then opening does NOT work here: closeOverlay goes through
 * history.back(), which fires popstate asynchronously. The new layer is
 * already open by the time that lands, so the deferred back press
 * closes the NEW layer and leaves the stack out of step with history.
 * One entry in, one entry out, no race.
 */
export function replaceOverlay(id, { onClose, title } = {}) {
  const el = document.getElementById(id);
  if (!el) return;

  const previous = stack.pop();
  if (previous) {
    document.getElementById(previous.id)?.classList.add("hidden");
    if (typeof previous.onClose === "function") previous.onClose();
  }

  el.classList.remove("hidden");
  stack.push({ id, onClose, title: title || "" });
  changed();

  // Only push if there was nothing to inherit an entry from.
  if (!previous) {
    history.pushState({ overlay: id, depth: stack.length }, "", window.location.href);
  }
}

/**
 * Close every layer, properly.
 *
 * A layer is `position: fixed; inset: 0` at z-index 1500 and the
 * screens beneath it are nowhere near that — so changing the screen
 * under an open layer put the new screen UNDERNEATH it. Tapping
 * somebody in the Orbit screen opened their profile behind the orbit
 * list, and the only way to find out was to press back.
 *
 * Goes through closeOverlay() rather than tearing the stack down, so
 * each layer spends its history entry the way it would have if the
 * person had closed it themselves. clearOverlays() below does NOT do
 * that, on purpose — it is for sign-out, where the page is about to
 * reload and the history is going with it.
 */
export function closeAllOverlays() {
  let closed = false;
  while (stack.length) {
    closeOverlay();
    closed = true;
  }
  return closed;
}

/** Drop everything, e.g. on sign-out. */
export function clearOverlays() {
  pendingPops = 0;
  while (stack.length) {
    const entry = stack.pop();
    document.getElementById(entry.id)?.classList.add("hidden");
  }
  changed();
}
