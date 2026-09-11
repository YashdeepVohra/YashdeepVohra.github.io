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

export function isOverlayOpen(id) {
  return stack.some((entry) => entry.id === id);
}

export function anyOverlayOpen() {
  return stack.length > 0;
}

export function openOverlay(id, { onClose } = {}) {
  const el = document.getElementById(id);
  if (!el || isOverlayOpen(id)) return;

  el.classList.remove("hidden");
  stack.push({ id, onClose });
  history.pushState({ overlay: id, depth: stack.length }, "", window.location.href);
}

/** Ask to close a layer. Buttons should call this. */
export function closeOverlay(id) {
  if (!stack.length) return;

  const index = id ? stack.findIndex((entry) => entry.id === id) : stack.length - 1;
  if (index === -1) return;

  const [entry] = stack.splice(index, 1);
  document.getElementById(entry.id)?.classList.add("hidden");
  if (typeof entry.onClose === "function") entry.onClose();

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
export function replaceOverlay(id, { onClose } = {}) {
  const el = document.getElementById(id);
  if (!el) return;

  const previous = stack.pop();
  if (previous) {
    document.getElementById(previous.id)?.classList.add("hidden");
    if (typeof previous.onClose === "function") previous.onClose();
  }

  el.classList.remove("hidden");
  stack.push({ id, onClose });

  // Only push if there was nothing to inherit an entry from.
  if (!previous) {
    history.pushState({ overlay: id, depth: stack.length }, "", window.location.href);
  }
}

/** Drop everything, e.g. on sign-out. */
export function clearOverlays() {
  pendingPops = 0;
  while (stack.length) {
    const entry = stack.pop();
    document.getElementById(entry.id)?.classList.add("hidden");
  }
}
