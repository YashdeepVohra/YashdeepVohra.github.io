/**
 * COMING BACK WITHOUT STARTING OVER.
 *
 * A phone throws a tab away when it is short of memory, and the next
 * time you switch back the browser reloads it from nothing. So does
 * the boot watchdog's one quiet retry, and so does coming back online
 * while stuck. Each of those used to look like a cold start: the
 * spinner and "Logging you in…", a network round trip for your own
 * profile, skeleton cards, the whole feed rising in card by card, and
 * you back at the top of Live Now — even though a moment ago you were
 * halfway down Recap, or in a conversation.
 *
 * A native app comes back where you left it, silently. This is that,
 * in three parts:
 *
 *  1. index.html marks a WARM start (someone was signed in on this
 *     device) before the first paint: the loader shows only the canvas
 *     for the first second, and every entry animation is switched off
 *     (`html.restoring`) until the screen is back.
 *  2. authService reads your own profile from the offline cache first,
 *     so the app is up without waiting on the network.
 *  3. This file: where you were (tab, scroll, the open conversation)
 *     is written to sessionStorage when the page is put away — which is
 *     per tab and survives exactly these reloads — and put back once.
 *
 * Nothing here reads or writes the database.
 */
import { state } from '../state/store.js';
import { safeId } from './formatters.js';

const KEY = "livesociya.restore";
const WARM = "livesociya.warm";
// Past this, a reload is a new visit, not a return.
const MAX_AGE = 30 * 60 * 1000;

function root() { return document.documentElement; }

/** Someone is signed in on this device: next start is a warm one. */
export function markWarm() {
  try { localStorage.setItem(WARM, "1"); } catch (e) { /* private mode */ }
}

/** Signed out: the next start is a cold one, and this one stops pretending. */
export function markCold() {
  try { localStorage.removeItem(WARM); } catch (e) { /* fine */ }
  try { sessionStorage.removeItem(KEY); } catch (e) { /* fine */ }
  finishRestoring();
}

/** Animations back on, loader back to normal. */
export function finishRestoring() {
  root().classList.remove("restoring", "warm");
}

function activeTab() {
  const el = document.querySelector(".nav-item.active[data-tab], .side-item.active[data-tab]");
  return el ? el.dataset.tab : "events";
}

/** Called when the page is hidden or unloaded. */
export function saveRestorePoint() {
  if (!state.uid) return;
  const point = {
    at: Date.now(),
    tab: activeTab(),
    y: Math.round(window.scrollY || 0),
    // Only when the feed is what is on screen: a profile's scroll is
    // the profile's, and the profile is not reopened.
    home: !document.getElementById("home")?.classList.contains("hidden"),
    chat: state.currentChat ? safeId(state.currentChat) : "",
    chatType: state.currentChatType || "",
    other: state.currentChatType === "direct" ? safeId(state.currentOtherUid) : ""
  };
  try { sessionStorage.setItem(KEY, JSON.stringify(point)); } catch (e) { /* full or blocked */ }
}

/** The saved point, once — it is removed as it is read. */
export function takeRestorePoint(now = Date.now()) {
  let point = null;
  try {
    point = JSON.parse(sessionStorage.getItem(KEY) || "null");
    sessionStorage.removeItem(KEY);
  } catch (e) { return null; }
  if (!point || typeof point !== "object") return null;
  if (!(now - Number(point.at) < MAX_AGE) || Number(point.at) > now + 60000) return null;
  return {
    tab: ["events", "recap", "chats"].includes(point.tab) ? point.tab : "events",
    y: Math.max(0, Math.min(200000, Number(point.y) || 0)),
    home: point.home !== false,
    chat: safeId(point.chat || ""),
    chatType: point.chatType === "event" ? "event" : point.chatType === "direct" ? "direct" : "",
    other: safeId(point.other || "")
  };
}

/**
 * Scroll back to `y` once the page is tall enough to get there. The
 * feed arrives a moment after the screen does, and scrolling a short
 * page clamps at its bottom, so this waits (at most `wait` ms) for
 * the content to fill in, then goes as far as it can.
 */
export function scrollBackTo(y, { wait = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!y) return resolve();
    const start = Date.now();
    const tick = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max >= y || Date.now() - start > wait) {
        window.scrollTo(0, Math.min(y, Math.max(0, max)));
        return resolve();
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}
