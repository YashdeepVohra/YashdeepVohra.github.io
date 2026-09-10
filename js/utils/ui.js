import { state } from '../state/store.js';
import { escapeHtml, safeId } from './formatters.js';

const SCREENS = ["login", "home", "usernameScreen", "profileScreen", "chatScreen"];

/** True when the layout is the sidebar + feed + rail desktop grid. */
export function isWideLayout() {
  return window.matchMedia("(min-width: 1100px)").matches;
}

/**
 * Show one screen.
 *
 * On phones this is a straight swap. On a laptop the app is a grid, so
 * opening a chat must NOT hide the feed column — the conversation list
 * stays beside the thread. That is the whole difference between the two
 * layouts, and it lives here rather than in every caller.
 */
export function switchScreen(screenId) {
  const frame = document.querySelector(".app-frame");
  const wide = isWideLayout();
  const twoPaneChat = wide && screenId === "chatScreen";

  SCREENS.forEach((id) => {
    // In two-pane chat the home column stays on screen behind the thread.
    if (twoPaneChat && id === "home") return;
    document.getElementById(id)?.classList.add("hidden");
  });

  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");

  // The sign-in screen is a full-viewport overlay; the app grid behind
  // it stands down so it can't be scrolled or tabbed into.
  const signedOut = screenId === "login";
  if (signedOut) frame?.classList.add("hidden");
  else if (screenId) frame?.classList.remove("hidden");

  frame?.classList.toggle("chat-open", twoPaneChat);
  if (twoPaneChat) showTab("chats");

  const hideNav = !screenId || signedOut || screenId === "usernameScreen" || screenId === "chatScreen";
  document.querySelector(".bottom-nav")?.classList.toggle("hidden", hideNav);

  // The compose button belongs to the feed. Left visible it floats over
  // an open chat or profile.
  document.querySelector(".fab")?.classList.toggle("hidden", hideNav || screenId === "profileScreen");
}

/** Highlight a tab in both the mobile bottom nav and the desktop sidebar. */
export function showTab(tab) {
  ["eventsTab", "recapTab", "chatsTab"].forEach((id) =>
    document.getElementById(id)?.classList.add("hidden")
  );

  const order = ["events", "recap", "chats"];
  const index = Math.max(0, order.indexOf(tab));
  const tabId = ["eventsTab", "recapTab", "chatsTab"][index];

  document.getElementById(tabId)?.classList.remove("hidden");

  [".nav-item", ".side-item"].forEach((selector) => {
    const items = document.querySelectorAll(selector);
    items.forEach((el, i) => el.classList.toggle("active", i === index));
  });
}

/**
 * Toast for an incoming direct message.
 * `senderUid` is a Firebase uid; the display name is looked up from the
 * cache and escaped before it reaches the DOM.
 */
export function showNotification(senderUid, chatId, openChatCallback) {
  if (state.currentChat === chatId) return;
  if (!safeId(senderUid)) return;

  let toastBox = document.getElementById("toastBox");
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.id = "toastBox";
    toastBox.style.cssText =
      "position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9000; width: calc(100% - 32px); max-width: 420px; display: flex; flex-direction: column; align-items: center; pointer-events: none;";
    document.body.appendChild(toastBox);
  }

  toastBox.innerHTML = "";
  const cached = state.userCache[senderUid] || {};
  const displayName = cached.displayName || cached.username || "Someone";

  const toast = document.createElement("div");
  toast.style.cssText =
    "background: #3c315b; color: #fdfcfe; padding: 14px 22px; border-radius: 100px; font-size: 15px; font-weight: 350; letter-spacing: -0.025em; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175,0.885,0.32,1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
  toast.innerHTML = `<i class='bx bxs-message-rounded-dots' style="font-size:20px;"></i> New message from ${escapeHtml(displayName)}`;

  toast.onclick = () => {
    if (openChatCallback) openChatCallback(chatId, senderUid);
    toast.style.transform = "translateY(-150%)";
    setTimeout(() => toast.remove(), 400);
  };

  toastBox.appendChild(toast);
  void toast.offsetWidth;
  toast.style.transform = "translateY(0)";

  setTimeout(() => {
    toast.style.transform = "translateY(-150%)";
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

export function toggleTime(element) {
  const currentlyShowing = document.querySelector(".msg-wrapper.show-time");
  if (currentlyShowing && currentlyShowing !== element) currentlyShowing.classList.remove("show-time");
  element.classList.toggle("show-time");
}

export function setLoading(visible) {
  document.getElementById("loading-screen")?.classList.toggle("hidden", !visible);
}
