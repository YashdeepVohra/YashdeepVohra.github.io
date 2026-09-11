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

/** Ask to close the top layer. Buttons should call this. */
export function closeOverlay(id) {
  if (!stack.length) return;
  // Only the top layer can be dismissed; anything else would desync
  // the history stack.
  if (id && stack[stack.length - 1].id !== id) {
    hideOverlay(id);
    return;
  }
  history.back();
}

/** Hide a layer that is NOT on top, without touching history. */
function hideOverlay(id) {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  const [entry] = stack.splice(index, 1);
  document.getElementById(entry.id)?.classList.add("hidden");
  if (typeof entry.onClose === "function") entry.onClose();
}

/**
 * Pop the top layer. Called by the popstate handler.
 * Returns true if something was closed, so the caller knows the back
 * press has been consumed.
 */
export function popOverlay() {
  const entry = stack.pop();
  if (!entry) return false;
  document.getElementById(entry.id)?.classList.add("hidden");
  if (typeof entry.onClose === "function") entry.onClose();
  return true;
}

/** Drop everything, e.g. on sign-out. */
export function clearOverlays() {
  while (stack.length) {
    const entry = stack.pop();
    document.getElementById(entry.id)?.classList.add("hidden");
  }
}
