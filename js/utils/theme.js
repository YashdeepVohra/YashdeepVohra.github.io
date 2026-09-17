// ==========================================
// THEME — system, light or dark
// ==========================================
//
// The choice is per device, in localStorage: it's how this screen looks,
// not something about the account, and keeping it off the profile costs
// no reads and no writes. "System" (the default) follows the phone or
// laptop, and keeps following it if that changes while the app is open
// — a phone that goes dark at sunset takes the app with it.
//
// The first paint is handled by a few lines inline in index.html's
// <head>, before the stylesheet, so a dark-mode phone never flashes
// white. This module takes over from there.
// ==========================================

export const THEME_KEY = "livesociya.theme";
const CHOICES = ["system", "light", "dark"];

// The browser bar matches the page behind it.
const BAR = { light: "#fdfcfe", dark: "#0f0d16" };

const darkQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

export function getThemeChoice() {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return CHOICES.includes(v) ? v : "system";
  } catch (e) {
    return "system";
  }
}

export function resolvedTheme(choice = getThemeChoice()) {
  if (choice === "light" || choice === "dark") return choice;
  return darkQuery && darkQuery.matches ? "dark" : "light";
}

function paint() {
  const root = document.documentElement;
  const theme = resolvedTheme();
  if (root.dataset.theme !== theme) {
    // Swap instantly rather than letting every transition on the page
    // animate its colour at once.
    root.classList.add("theme-switching");
    root.dataset.theme = theme;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  root.style.colorScheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", BAR[theme]));
  syncThemeUI();
}

export function setThemeChoice(choice) {
  if (!CHOICES.includes(choice)) return;
  try { window.localStorage.setItem(THEME_KEY, choice); } catch (e) {}
  paint();
}

/** Mark the Settings control. Safe to call before Settings exists. */
export function syncThemeUI() {
  const choice = getThemeChoice();
  document.querySelectorAll("#themePicker .theme-opt").forEach((btn) => {
    const on = btn.dataset.theme === choice;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const note = document.getElementById("themeNote");
  if (note) {
    note.innerText = choice === "system"
      ? `Following your device — ${resolvedTheme() === "dark" ? "dark" : "light"} right now.`
      : `Always ${choice}, whatever your device is set to.`;
  }
}

export function initTheme() {
  paint();
  if (darkQuery) {
    const onChange = () => { if (getThemeChoice() === "system") paint(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener("change", onChange);
    else if (darkQuery.addListener) darkQuery.addListener(onChange);
  }
}
