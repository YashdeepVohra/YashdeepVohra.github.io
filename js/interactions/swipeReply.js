// ==========================================
// MESSAGE GESTURES
// ==========================================
//
// Two gestures share one pointer lifecycle, because they start the
// same way and only diverge once you know whether the finger moved:
//
//   swipe sideways    quote and reply
//   press and hold    the message sheet (reply, copy, edit, delete)
//
// They are mutually exclusive by construction: any real movement
// cancels the hold timer, and the timer firing drops the swipe.
// ==========================================

import { initiateReply, openMessageActions } from '../services/chatService.js';
import { state } from '../state/store.js';

let startX = 0;
let startY = 0;
let currentSwipeItem = null;
let isSwiping = false;
let swipeDirection = 0;

// Long enough not to fire on a slow tap, short enough that you don't
// wonder whether it is going to.
const HOLD_MS = 460;
const HOLD_SLOP_PX = 8;
let holdTimer = null;

function cancelHold() {
  clearTimeout(holdTimer);
  holdTimer = null;
}

function handleDragStart(e) {
  cancelHold();

  const wrapper = e.target.closest(".msg-wrapper");
  if (!wrapper) return;

  const touch = e.type.includes("mouse") ? e : e.touches[0];
  startX = touch.clientX;
  startY = touch.clientY;

  currentSwipeItem = wrapper;
  isSwiping = false;
  wrapper.style.transition = "none";

  const isSent = wrapper.querySelector(".msg-sent") !== null;
  swipeDirection = isSent ? -1 : 1;

  // A retracted message has nothing to reply to, copy or rewrite.
  if (wrapper.dataset.deleted === "1") return;
  const id = wrapper.getAttribute("data-msg-id");
  if (!id) return;

  holdTimer = setTimeout(() => {
    holdTimer = null;
    // A hold is not a swipe: let go of the element so dragEnd has
    // nothing to finish, and swallow the click that follows the lift.
    currentSwipeItem = null;
    state.suppressNextTap = true;
    if (navigator.vibrate) navigator.vibrate(18);
    openMessageActions(id);
  }, HOLD_MS);
}

function handleDragMove(e) {
  if (!currentSwipeItem) return;

  const touch = e.type.includes("mouse") ? e : e.touches[0];
  const deltaX = touch.clientX - startX;
  const deltaY = touch.clientY - startY;

  // Any real movement means this is a drag, not a hold.
  if (holdTimer && (Math.abs(deltaX) > HOLD_SLOP_PX || Math.abs(deltaY) > HOLD_SLOP_PX)) cancelHold();

  if (!isSwiping && Math.abs(deltaY) > Math.abs(deltaX)) {
    currentSwipeItem = null;
    return;
  }

  if ((swipeDirection === 1 && deltaX > 10) || (swipeDirection === -1 && deltaX < -10)) {
    isSwiping = true;
    if (e.cancelable) e.preventDefault();
  }

  if (isSwiping) {
    let movePx = 0;
    if (swipeDirection === 1 && deltaX > 0) movePx = Math.min(deltaX * 0.4, 65);
    else if (swipeDirection === -1 && deltaX < 0) movePx = Math.max(deltaX * 0.4, -65);

    currentSwipeItem.style.transform = `translateX(${movePx}px)`;

    if (Math.abs(movePx) >= 50) currentSwipeItem.classList.add("ready-to-reply");
    else currentSwipeItem.classList.remove("ready-to-reply");
  }
}

function handleDragEnd() {
  cancelHold();
  if (!currentSwipeItem) return;

  if (currentSwipeItem.classList.contains("ready-to-reply")) {
    const senderUid = currentSwipeItem.getAttribute("data-sender-uid");
    const text = decodeURIComponent(currentSwipeItem.getAttribute("data-text"));
    const time = parseInt(currentSwipeItem.getAttribute("data-time"));

    initiateReply(senderUid, text, time);
    if (navigator.vibrate) navigator.vibrate(50);
  }

  currentSwipeItem.style.transition = "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
  currentSwipeItem.style.transform = "translateX(0px)";
  currentSwipeItem.classList.remove("ready-to-reply");
  currentSwipeItem = null;
  isSwiping = false;
}

export function initSwipeListeners() {
  document.addEventListener("mousedown", handleDragStart);
  document.addEventListener("mousemove", handleDragMove);
  document.addEventListener("mouseup", handleDragEnd);

  document.addEventListener("touchstart", handleDragStart, { passive: false });
  document.addEventListener("touchmove", handleDragMove, { passive: false });
  document.addEventListener("touchend", handleDragEnd);
  // A cancelled touch (a phone call, the app backgrounding) never
  // sends touchend, and a hold timer left running would pop the sheet
  // open over whatever comes next.
  document.addEventListener("touchcancel", handleDragEnd);

  // On a desktop the same sheet is a right-click. Some mobile browsers
  // also fire this at the end of a long press; openMessageActions
  // ignores a second open, so the two can't stack.
  document.addEventListener("contextmenu", (e) => {
    const wrapper = e.target.closest?.(".msg-wrapper");
    if (!wrapper || wrapper.dataset.deleted === "1") return;
    const id = wrapper.getAttribute("data-msg-id");
    if (!id) return;
    e.preventDefault();
    cancelHold();
    state.suppressNextTap = true;
    openMessageActions(id);
  });
}