import { state } from '../state/store.js';

export function switchScreen(screenId) {
  document.getElementById("login")?.classList.add("hidden");
  document.getElementById("home")?.classList.add("hidden");
  document.getElementById("usernameScreen")?.classList.add("hidden");
  document.getElementById("profileScreen")?.classList.add("hidden");
  document.getElementById("chatScreen")?.classList.add("hidden");
  
  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");

  const bottomNav = document.querySelector(".bottom-nav");
  if (bottomNav) {
    if (screenId === "login" || screenId === "usernameScreen" || !screenId) {
      bottomNav.classList.add("hidden");
    } else {
      bottomNav.classList.remove("hidden");
    }
  }
}

export function showTab(tab) {
  document.getElementById("eventsTab")?.classList.add("hidden");
  document.getElementById("recapTab")?.classList.add("hidden");
  document.getElementById("chatsTab")?.classList.add("hidden");

  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach(t => t.classList.remove("active"));

  if (tab === 'events') {
    document.getElementById("eventsTab")?.classList.remove("hidden");
    if (navItems[0]) navItems[0].classList.add("active");
  } else if (tab === 'recap') {
    document.getElementById("recapTab")?.classList.remove("hidden");
    if (navItems[1]) navItems[1].classList.add("active");
  } else {
    document.getElementById("chatsTab")?.classList.remove("hidden");
    if (navItems[2]) navItems[2].classList.add("active");
  }
}

export function showNotification(senderUsername, chatId, openChatCallback) {
  if (state.currentChat === chatId) return;

  let toastBox = document.getElementById("toastBox");
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.id = "toastBox";
    toastBox.style.cssText = "position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999; width: 90%; max-width: 400px; display: flex; flex-direction: column; align-items: center; pointer-events: none;";
    document.body.appendChild(toastBox);
  }

  toastBox.innerHTML = "";
  const displayName = state.userCache[senderUsername]?.displayName || senderUsername;

  const toast = document.createElement("div");
  toast.style.cssText = "background: var(--primary); color: white; padding: 14px 20px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); font-size: 14px; font-weight: 600; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
  toast.innerHTML = `<i class='bx bxs-message-rounded-dots' style="font-size: 20px;"></i> New message from ${displayName}`;

  toast.onclick = () => {
    if (openChatCallback) openChatCallback(chatId, senderUsername);
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
  const currentlyShowing = document.querySelector('.msg-wrapper.show-time');
  if (currentlyShowing && currentlyShowing !== element) currentlyShowing.classList.remove('show-time');
  element.classList.toggle('show-time');
}
