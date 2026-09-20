// ==========================================
// PULL TO REFRESH
// ==========================================
//
// The browser's own pull-to-refresh went out with the bounce, because
// they are one feature: `overscroll-behavior-y: none` on html turns off
// the rubber-band jolt AND the pull, and there is no value that keeps
// one without the other. Turning off the jolt was right. Losing the
// reload was not — installed to a home screen there is no address bar
// and no reload button either, so there was no way to reload at all.
//
// So this is ours, and it is deliberately small:
//
//   * It arms ONLY at the very top of the feed, on the feed screen,
//     with nothing open over it. Anywhere else it never engages.
//   * Every listener is PASSIVE. Nothing is prevented and nothing
//     needs to be: at scroll position 0 with the bounce off, a
//     downward drag already does nothing, so there is no default to
//     fight. That also means this cannot make scrolling janky, which
//     is the usual cost of a gesture layered over a scroller.
//   * It moves one element, by transform only, so the work per frame
//     lands on the compositor rather than in layout.
//
// A real reload is what it does. The feed is live and does not need
// refreshing, but a reload is what you reach for when something has
// gone wrong, and that is exactly when you cannot reach the thing that
// is broken by any other route.
// ==========================================

// How far you have to pull before letting go reloads, and how far the
// indicator is allowed to travel. The gap between them is what gives
// the pull somewhere to go once it is armed, so the gesture has a
// "yes, now" moment rather than stopping dead.
const TRIGGER_PX = 64;
const MAX_PX = 92;
// Resistance. The finger moves twice as far as the indicator, which is
// what makes a pull feel like it is against something.
const DRAG_RATIO = 0.5;

let node = null;
let startY = 0;
let startX = 0;
let tracking = false;   // a candidate touch, direction not yet decided
let pulling = false;    // committed: this is a pull, not a scroll
let distance = 0;
let firing = false;

function indicator() {
  if (node) return node;
  node = document.createElement("div");
  node.id = "pullRefresh";
  node.className = "pull-refresh";
  node.setAttribute("aria-hidden", "true");
  // Drawn, not an icon-font glyph: this appears exactly when something
  // has gone wrong enough that you want to reload, which is also when
  // a webfont is most likely to be the thing that did not arrive.
  node.innerHTML = `
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 11.5A8 8 0 1 0 18.3 17"/>
      <path d="M20 5.5V12h-6"/>
    </svg>`;
  document.body.appendChild(node);
  return node;
}

/** The feed, at the top, with nothing open over it. */
function canPull(target) {
  if (firing) return false;
  if ((window.scrollY || document.documentElement.scrollTop || 0) > 0) return false;

  const home = document.getElementById("home");
  if (!home || home.classList.contains("hidden")) return false;

  // A full-screen layer (chat, profile, claim a handle) is its own
  // world and scrolls itself.
  if (document.querySelector(".full-screen-view:not(.hidden)")) return false;
  // So is anything modal.
  if (document.querySelector(".modal-overlay:not(.hidden)")) return false;

  // Started inside something that scrolls on its own? Leave it alone.
  // `target` is whatever the event carries, which is not always an
  // element — a touch can land on a text node, and a dispatched event
  // can carry the document itself. Neither has closest().
  const el = target && target.nodeType === 1 ? target
           : (target && target.parentElement) || null;
  if (el && el.closest("#messages, .rail, .sidebar, .profile-scroll-body, .screen-body")) {
    return false;
  }
  return true;
}

function paint(px) {
  const el = indicator();
  el.classList.remove("settling");
  const travel = Math.min(px, MAX_PX);
  el.style.transform = `translateY(${travel}px) rotate(${travel * 3}deg)`;
  el.style.opacity = String(Math.min(1, travel / (TRIGGER_PX * 0.6)));
}

function settle() {
  const el = indicator();
  el.classList.add("settling");
  el.style.transform = "translateY(-50px)";
  el.style.opacity = "0";
}

function onStart(e) {
  tracking = false;
  pulling = false;
  distance = 0;
  if (e.touches.length !== 1) return;
  if (!canPull(e.target)) return;
  tracking = true;
  startY = e.touches[0].clientY;
  startX = e.touches[0].clientX;
}

function onMove(e) {
  if (!tracking || e.touches.length !== 1) return;
  const dy = e.touches[0].clientY - startY;
  const dx = e.touches[0].clientX - startX;

  if (!pulling) {
    // Upward, or mostly sideways, is somebody else's gesture — the
    // page scrolling, or a filter rail. Stand down for this touch and
    // do not take it back.
    if (dy < 0 || Math.abs(dx) > Math.abs(dy)) { tracking = false; return; }
    if (dy < 10) return;
    // The page may have scrolled between touchstart and here.
    if (!canPull(e.target)) { tracking = false; return; }
    pulling = true;
  }

  distance = Math.max(0, dy * DRAG_RATIO);
  paint(distance);
}

function onEnd() {
  if (!tracking) return;
  const go = pulling && distance >= TRIGGER_PX;
  tracking = false;
  pulling = false;
  if (!go) { settle(); return; }

  firing = true;
  const el = indicator();
  el.classList.add("settling", "spinning");
  el.style.transform = `translateY(${TRIGGER_PX}px)`;
  el.style.opacity = "1";
  // A beat, so the spinner is seen and the gesture reads as having
  // been accepted rather than as the screen blinking.
  setTimeout(() => { window.location.reload(); }, 260);
}

export function initPullRefresh() {
  // Touch only, and only where there is no other way to reload: a
  // desktop browser has a reload button and a keyboard shortcut.
  if (!("ontouchstart" in window)) return;
  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", onEnd, { passive: true });
}
