import { state } from '../state/store.js';
import { escapeHtml, safeId } from './formatters.js';

const SCREENS = ["login", "home", "usernameScreen", "profileScreen", "chatScreen"];

export function switchScreen(screenId) {
  SCREENS.forEach((id) => document.getElementById(id)?.classList.add("hidden"));
  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");

  const bottomNav = document.querySelector(".bottom-nav");
  if (bottomNav) {
    const hideNav = !screenId || screenId === "login" || screenId === "usernameScreen" || screenId === "chatScreen";
    bottomNav.classList.toggle("hidden", hideNav);
  }
}

export function showTab(tab) {
  ["eventsTab", "recapTab", "chatsTab"].forEach((id) =>
    document.getElementById(id)?.classList.add("hidden")
  );

  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach((t) => t.classList.remove("active"));

  const map = { events: ["eventsTab", 0], recap: ["recapTab", 1], chats: ["chatsTab", 2] };
  const [tabId, navIndex] = map[tab] || map.chats;

  document.getElementById(tabId)?.classList.remove("hidden");
  if (navItems[navIndex]) navItems[navIndex].classList.add("active");
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
      "position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999; width: 90%; max-width: 400px; display: flex; flex-direction: column; align-items: center; pointer-events: none;";
    document.body.appendChild(toastBox);
  }

  toastBox.innerHTML = "";
  const cached = state.userCache[senderUid] || {};
  const displayName = cached.displayName || cached.username || "Someone";

  const toast = document.createElement("div");
  toast.style.cssText =
    "background: var(--primary); color: white; padding: 14px 20px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); font-size: 14px; font-weight: 600; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
  toast.innerHTML = `<i class='bx bxs-message-rounded-dots' style="font-size: 20px;"></i> New message from ${escapeHtml(displayName)}`;

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
