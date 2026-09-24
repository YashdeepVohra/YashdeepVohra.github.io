import { state } from '../state/store.js';
import { escapeHtml, safeId } from './formatters.js';
import { closeAllOverlays } from './overlays.js';

const SCREENS = ["login", "home", "usernameScreen", "profileScreen", "chatScreen"];

/* ---------------------------------------------------------------------
   The page title
   ---------------------------------------------------------------------
   One owner, because two used to fight over it: the inbox wrote
   "livesociya" over whatever screen you were on every time a chat
   changed. Now a screen says what it is (setPageTitle) and the inbox
   only says whether something is unread (setTitleUnread); this paints
   both. Signed out, the title is the full search title from index.html
   — that is the one Google shows, so the front door never changes it. */
const SEARCH_TITLE = "livesociya — what's happening on campus, right now";
const TAB_TITLES = { events: "Live now", recap: "Recap", chats: "Messages" };
const SCREEN_TITLES = { login: "", usernameScreen: "Claim your handle", chatScreen: "Chat", profileScreen: "Profile" };
let titleLabel = "";
let titleUnread = false;
let currentTab = "events";
function paintTitle() {
  const base = titleLabel ? `${titleLabel} · livesociya` : SEARCH_TITLE;
  const t = titleUnread ? `(1) ${base}` : base;
  if (document.title !== t) document.title = t;
}
/** What this screen is, for the tab, history and bookmarks. "" = the search title. */
export function setPageTitle(label) { titleLabel = label || ""; paintTitle(); }
/** A new message is waiting: "(1)" in front, whatever screen you are on. */
export function setTitleUnread(on) { titleUnread = !!on; paintTitle(); }

/**
 * Show one screen. ONE swap, at every width.
 *
 * A laptop used to keep the feed column open beside a thread. It read
 * well in the abstract and badly in practice: the feed got 360px, which
 * is narrower than a phone gives it, so cards were cramped and the
 * action row had to wrap inside a 1280px window. A conversation is now
 * a screen like any other, the sidebar is the way out of it, and the
 * feed always has the whole column.
 */
export function switchScreen(screenId) {
  // A way back to somewhere you are no longer coming from is worse
  // than no way back at all.
  clearReturnChip();

  /* AND NEITHER IS A LAYER OVER SOMETHING IT DOES NOT BELONG TO.
     Overlays sit at z-index 1500 and every screen is far below, so
     changing the screen under an open one simply hid the new screen
     behind it. Tapping a name in the Orbit list opened that profile
     underneath the list, and pressing back — which closed the list —
     was the only way to discover it had worked.
     openProfileScreen already knew to tear down an open CHAT for
     exactly this reason. It is not a chat problem, it is a layering
     one, so it belongs here where every screen change goes through. */
  closeAllOverlays();
  const frame = document.querySelector(".app-frame");

  SCREENS.forEach((id) => document.getElementById(id)?.classList.add("hidden"));
  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");

  // The sign-in screen is a full-viewport overlay; the app grid behind
  // it stands down so it can't be scrolled or tabbed into.
  const signedOut = screenId === "login";
  if (signedOut) frame?.classList.add("hidden");
  else if (screenId) frame?.classList.remove("hidden");

  if (screenId === "home") setPageTitle(TAB_TITLES[currentTab]);
  else if (screenId in SCREEN_TITLES) setPageTitle(SCREEN_TITLES[screenId]);

  const hideNav = !screenId || signedOut || screenId === "usernameScreen" || screenId === "chatScreen";
  document.querySelector(".bottom-nav")?.classList.toggle("hidden", hideNav);

  // The compose button belongs to the feed. Left visible it floats over
  // an open chat or profile.
  document.querySelector(".fab")?.classList.toggle("hidden", hideNav || screenId === "profileScreen");
}

/** Highlight a tab in both the mobile bottom nav and the desktop sidebar. */
const TAB_PANELS = { events: "eventsTab", recap: "recapTab", chats: "chatsTab" };

/**
 * Show one tab and highlight its control in BOTH navs.
 *
 * Matching is by data-tab, never by position. It used to compare
 * indexes, which meant adding the Search button to the top of the
 * sidebar shifted every highlight down one — Live Now lit up Search,
 * Recap lit up Live Now. Any control without a data-tab (Search, New
 * Event) is simply never highlighted, and new ones can be added
 * anywhere without breaking this.
 */
export function showTab(tab) {
  const active = TAB_PANELS[tab] ? tab : "events";
  currentTab = active;
  if (!document.getElementById("home")?.classList.contains("hidden")) setPageTitle(TAB_TITLES[active]);

  Object.values(TAB_PANELS).forEach((id) =>
    document.getElementById(id)?.classList.add("hidden")
  );
  document.getElementById(TAB_PANELS[active])?.classList.remove("hidden");

  document.querySelectorAll(".nav-item, .side-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === active);
  });
}

/**
 * Toast for an incoming direct message.
 * `senderUid` is a Firebase uid; the display name is looked up from the
 * cache and escaped before it reaches the DOM.
 */
/* ---------------------------------------------------------------------
   Repainting everything that shows social state
   ---------------------------------------------------------------------
   Following somebody, or a request being accepted, changes what is on
   screen in four places at once: the trust chip on every event card,
   the button on a search result, whichever profile is open, and the
   Orbit screen. Before this, only the feed was told — so pulling
   somebody in from search left the row saying "Pull in" until the
   whole query was typed again.

   A registry rather than direct imports, because ui.js sits underneath
   almost every other module and importing them back would be a cycle.
   app.js registers the painters once at boot.
   ------------------------------------------------------------------- */

const socialPainters = [];

export function onSocialChange(paint) {
  if (typeof paint === "function") socialPainters.push(paint);
}

export function refreshSocialUI() {
  socialPainters.forEach((paint) => {
    try { paint(); } catch (e) { console.error("Repaint failed:", e.message); }
  });
}

/* ---------------------------------------------------------------------
   The way back
   ---------------------------------------------------------------------
   Tapping an event somebody shared in a chat takes you to the feed,
   which is right — the card in the feed IS the event, there is no
   separate detail view to open. But on a phone that means the
   conversation is gone, and getting back to it is Chats, find the
   thread, scroll. So leaving a conversation leaves a way back: one
   chip, bottom of the screen where a thumb already is, gone on its own
   after a few seconds.

   On a laptop none of this is needed — the thread stays open beside
   the feed — which is why only the phone branch calls it.
   ------------------------------------------------------------------- */
let chipTimer = 0;

export function clearReturnChip() {
  clearTimeout(chipTimer);
  document.getElementById("returnChip")?.remove();
}

export function returnChip({ text, icon = "bx-left-arrow-alt", onTap }) {
  clearReturnChip();
  const el = document.createElement("button");
  el.id = "returnChip";
  el.className = "return-chip";
  if (icon) {
    const i = document.createElement("i");
    i.className = "bx " + icon;
    el.appendChild(i);
  }
  // Text, never markup: the name in here belongs to another student.
  el.appendChild(document.createTextNode(String(text || "")));
  el.onclick = () => { clearReturnChip(); onTap?.(); };

  // IN THE COLUMN, NOT OVER IT. This used to be appended to <body> and
  // positioned fixed at the bottom left, which went wrong twice. It
  // covered whatever sat under it — reliably a card's action row, since
  // that is what lives at the bottom of a card — and its desktop offset
  // was arithmetic (sidebar width plus a gutter) that only held while
  // the app frame started at x=0. Past about 1400px the frame is
  // centred, the sidebar starts at 40px, and the chip landed inside it.
  //
  // As the first child of the feed column it covers nothing at any
  // width and needs no coordinates at all: the column already has them.
  // It sits outside #eventsTab and #recapTab on purpose, so switching
  // between Live Now and Recap doesn't strand it in the hidden one.
  (document.getElementById("home") || document.body).prepend(el);
  void el.offsetWidth;
  el.classList.add("in");
  // No timer. Nine seconds was right for something floating over the
  // feed; an element in the flow that removes itself on a clock yanks
  // the cards up under a thumb that is already moving. switchScreen
  // clears it, so it still cannot outlive the trip it belongs to.
}

/** The one place toasts are mounted, shared by every kind of toast. */
function toastBoxEl() {
  let box = document.getElementById("toastBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "toastBox";
    box.style.cssText =
      "position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9000; width: calc(100% - 32px); max-width: 420px; display: flex; flex-direction: column; align-items: center; pointer-events: none;";
    document.body.appendChild(box);
  }
  return box;
}

/**
 * A short confirmation of something the user just did. Plain text only
 * — callers pass their own words, never anything typed by another
 * student, and it is inserted as text rather than markup regardless.
 */
export function toast(text, icon) {
  const box = toastBoxEl();
  box.innerHTML = "";

  const el = document.createElement("div");
  el.style.cssText =
    "background: var(--toast-bg); color: var(--toast-ink); padding: 13px 20px; border-radius: 100px; font-size: 14.5px; font-weight: 350; letter-spacing: -0.025em; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175,0.885,0.32,1.275); display: flex; align-items: center; gap: 9px; width: 100%; pointer-events: none;";

  if (icon) {
    const i = document.createElement("i");
    i.className = "bx " + icon;
    i.style.fontSize = "19px";
    el.appendChild(i);
  }
  el.appendChild(document.createTextNode(String(text || "")));

  box.appendChild(el);
  void el.offsetWidth;
  el.style.transform = "translateY(0)";

  setTimeout(() => {
    el.style.transform = "translateY(-150%)";
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

export function showNotification(senderUid, chatId, openChatCallback) {
  if (state.currentChat === chatId) return;
  if (!safeId(senderUid)) return;

  const toastBox = toastBoxEl();
  toastBox.innerHTML = "";
  const cached = state.userCache[senderUid] || {};
  const displayName = cached.displayName || cached.username || "Someone";

  const toast = document.createElement("div");
  toast.style.cssText =
    "background: var(--toast-bg); color: var(--toast-ink); padding: 14px 22px; border-radius: 100px; font-size: 15px; font-weight: 350; letter-spacing: -0.025em; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175,0.885,0.32,1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
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
