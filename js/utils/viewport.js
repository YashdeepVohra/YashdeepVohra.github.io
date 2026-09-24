// =====================================================================
// MOBILE KEYBOARD FIT
// =====================================================================
//
// When a phone keyboard opens it does NOT shrink the layout viewport by
// default — it slides over the top of it. Anything anchored to the
// bottom (the chat composer, the Publish button) ends up underneath it.
//
// Two defences, because neither alone covers every browser:
//
//   1. `interactive-widget=resizes-content` in the viewport meta, which
//      asks modern Chrome/Android to resize the layout viewport itself.
//   2. This module, which reads the VisualViewport — the part of the
//      page actually on screen — and publishes it as CSS variables.
//
// WHAT CHANGED, AND WHY
// ---------------------
// This used to publish only `--kb`, the keyboard's height worked out as
// `innerHeight - visualViewport.height - offsetTop`, and lift the
// bottom edge of each full-screen layer by it. That leans on
// `innerHeight`, which iOS Safari, iOS home-screen apps and in-app
// browsers each report their own way while a keyboard is up — so on
// some phones the composer landed under the keyboard.
//
// Now the layers are placed by the visual viewport directly:
//
//   --vvt   its top, relative to the layout viewport   (offsetTop)
//   --vvh   its height                                 (height)
//
// A fixed element at `top: --vvt; height: --vvh` covers exactly what
// can be seen, whatever innerHeight claims. `--kb` is still published
// for anything else that uses it.
//
// Keyboard vs. pinch-zoom: both shrink the visual viewport. A keyboard
// only counts when a text field has focus and the page isn't zoomed,
// so pinching no longer hid the bottom nav or squeezed the chat.
// =====================================================================

const KEYBOARD_THRESHOLD = 90; // px — below this it's browser chrome, not a keyboard

function typingInField() {
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.matches("textarea, select")) return true;
  return el.matches("input") && !/^(button|checkbox|radio|range|submit|reset|file|color|hidden)$/i.test(el.type || "");
}

/**
 * No zooming, anywhere. iOS Safari has ignored `user-scalable=no` since
 * iOS 10 and still pinches, so its gesture events are cancelled here;
 * a second finger on the screen is refused for the same reason. On a
 * desktop, ctrl/cmd + wheel and ctrl/cmd + plus/minus/zero are caught.
 * (The browser's own menu can still zoom a desktop page — no page can
 * stop that.)
 */
export function lockZoom() {
  const stop = (e) => { if (e.cancelable) e.preventDefault(); };

  ["gesturestart", "gesturechange", "gestureend"].forEach((type) =>
    document.addEventListener(type, stop, { passive: false }));

  document.addEventListener("touchmove", (e) => {
    if (e.touches && e.touches.length > 1) stop(e);
  }, { passive: false });

  // Double-tap zoom is handled by `touch-action: pan-x pan-y` in the
  // stylesheet. Cancelling a quick second touchend here would also have
  // swallowed the second of two fast taps on a real button.

  window.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) stop(e); }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) stop(e);
  });
}

export function initViewportFit() {
  const root = document.documentElement;
  const vv = window.visualViewport;

  // No VisualViewport (older browsers): the meta tag is the only
  // defence, and the variables stay unset.
  if (!vv) return;

  let frame = 0;
  let wasOpen = false;
  let scrollBeforeKb = window.scrollY;

  const layerOpen = () => !!document.querySelector(
    "#chatScreen:not(.hidden), .profile-screen-wrapper:not(.hidden), .full-screen-view:not(.hidden)");

  const measure = () => {
    const zoomed = (vv.scale || 1) > 1.05;
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // Some browsers resize innerHeight along with the keyboard, which
    // makes `overlap` zero; the visual viewport is still shorter than
    // the screen, so compare against the tallest height seen as well.
    const shrunk = Math.max(0, tallest - vv.height);
    const open = typingInField() && !zoomed && Math.max(overlap, shrunk) > KEYBOARD_THRESHOLD;

    root.style.setProperty("--kb", `${Math.round(open ? overlap : 0)}px`);
    root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    root.classList.toggle("kb-open", open);

    // Keep the newest message visible as the composer rises.
    if (open && !wasOpen) {
      const box = document.getElementById("messages");
      if (box) box.scrollTop = box.scrollHeight;
    }
    // iOS scrolls the page up to make room for the keyboard and does not
    // always scroll it back when the keyboard goes. Under a full-screen
    // layer nothing needs the page to move, so put it back where it was;
    // left alone, the chat sat raised with a strip of blank below it.
    if (!open && wasOpen && layerOpen() && Math.abs(window.scrollY - scrollBeforeKb) > 1) {
      window.scrollTo(0, scrollBeforeKb);
    }
    wasOpen = open;
  };

  // The tallest the visible area has been with no keyboard up: the
  // screen height as far as this page is concerned. Rotating resets it.
  let tallest = vv.height;
  const noteTallest = () => {
    if (!typingInField()) tallest = Math.max(vv.height, window.innerHeight * 0.6);
  };

  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { noteTallest(); measure(); });
  };

  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", () => { tallest = 0; setTimeout(apply, 350); });
  apply();

  // The keyboard animates in over a few hundred milliseconds, and not
  // every browser fires a resize at the end of it. Measure through it.
  const settle = () => [60, 180, 360, 650].forEach((ms) => setTimeout(apply, ms));

  document.addEventListener("focusin", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement) || !typingInField()) return;
    if (!wasOpen) scrollBeforeKb = window.scrollY;
    settle();

    setTimeout(() => {
      // Scrolling fields into view only makes sense inside a scrolling
      // panel. The chat composer is pinned to the bottom instead.
      if (el.closest(".screen-body, .profile-scroll-body, .container")) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 380);
  });

  document.addEventListener("focusout", settle);
}
