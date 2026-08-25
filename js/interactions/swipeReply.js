import { initiateReply } from '../services/chatService.js';

let startX = 0;
let startY = 0;
let currentSwipeItem = null;
let isSwiping = false;
let swipeDirection = 0;

function handleDragStart(e) {
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
}

function handleDragMove(e) {
  if (!currentSwipeItem) return;

  const touch = e.type.includes("mouse") ? e : e.touches[0];
  const deltaX = touch.clientX - startX;
  const deltaY = touch.clientY - startY;

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
  if (!currentSwipeItem) return;

  if (currentSwipeItem.classList.contains("ready-to-reply")) {
    const sender = currentSwipeItem.getAttribute("data-sender");
    const text = decodeURIComponent(currentSwipeItem.getAttribute("data-text"));
    const time = parseInt(currentSwipeItem.getAttribute("data-time"));

    initiateReply(sender, text, time);
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
}
