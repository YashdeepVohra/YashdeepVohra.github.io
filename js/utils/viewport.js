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
//   2. This module, which measures the overlap with the VisualViewport
//      API and publishes it as `--kb`. iOS Safari ignores (1), so the
//      measurement is what actually saves it there.
//
// Anything that must stay above the keyboard sets `bottom: var(--kb)`.
// =====================================================================

const KEYBOARD_THRESHOLD = 90; // px — below this it's browser chrome, not a keyboard

export function initViewportFit() {
  const root = document.documentElement;
  const vv = window.visualViewport;

  // No VisualViewport (older browsers): the meta tag is the only
  // defence, and --kb stays 0, which is the current behaviour.
  if (!vv) return;

  let frame = 0;

  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // How much of the layout viewport the keyboard is covering.
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const open = overlap > KEYBOARD_THRESHOLD;

      root.style.setProperty("--kb", `${Math.round(overlap)}px`);
      root.classList.toggle("kb-open", open);

      // Keep the newest message visible as the composer rises.
      if (open) {
        const box = document.getElementById("messages");
        if (box) box.scrollTop = box.scrollHeight;
      }
    });
  };

  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();

  // The keyboard animates in, so measure again once it has settled.
  document.addEventListener("focusin", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if (!el.matches("input, textarea, select")) return;

    setTimeout(() => {
      apply();
      // Scrolling fields into view only makes sense inside a scrolling
      // panel. The chat composer is pinned to the bottom instead.
      if (el.closest(".screen-body, .profile-scroll-body, .container")) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 300);
  });

  document.addEventListener("focusout", () => setTimeout(apply, 300));
}
