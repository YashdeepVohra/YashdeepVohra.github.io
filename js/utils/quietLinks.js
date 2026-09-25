// ==========================================
// LINKS THAT DON'T PRINT THEMSELVES ON HOVER
// ==========================================
//
// On a laptop, hovering anything with an `href` makes the browser draw
// the URL in a grey box at the bottom-left of the window. On a web page
// that is expected; in an app it reads as a web page showing through —
// and in a chat full of shared event cards it flickered on every pass
// of the mouse. No CSS can turn it off: it is drawn for any element
// that has an href at the moment the pointer is over it.
//
// So our links carry their address in `data-href` and have NO href
// while you are merely pointing at them. The href is put back exactly
// when the browser's own link behaviour is wanted:
//
//   right-click     "Copy link address" and "Open in new tab" still work
//   middle-click    opens in a new tab, natively
//   keyboard focus  Tab to it and Enter follows it
//
// and taken away again when the pointer or focus leaves. A plain click
// is ours: a link with its own onclick (an event card) handles itself;
// any other opens in a new tab.
// ==========================================

const SEL = "a[data-href]";

function arm(a) {
  if (a && a.dataset.href && !a.hasAttribute("href")) a.setAttribute("href", a.dataset.href);
}
function disarm(a) {
  if (a && a.dataset.href && a.hasAttribute("href")) a.removeAttribute("href");
}
const linkOf = (target) => (target && target.closest ? target.closest(SEL) : null);

export function initQuietLinks(doc = document) {
  doc.addEventListener("contextmenu", (e) => arm(linkOf(e.target)), true);
  doc.addEventListener("mousedown", (e) => { if (e.button === 1) arm(linkOf(e.target)); }, true);
  doc.addEventListener("focusin", (e) => {
    const a = linkOf(e.target);
    // Only a keyboard focus: a mouse click focuses the link too, and
    // arming it then would bring the status bar straight back.
    if (a && a.matches(":focus-visible")) arm(a);
  }, true);
  doc.addEventListener("focusout", (e) => disarm(linkOf(e.target)), true);
  doc.addEventListener("mouseout", (e) => {
    const a = linkOf(e.target);
    if (a && !(e.relatedTarget && a.contains(e.relatedTarget))) disarm(a);
  }, true);

  // A click on a link with no href does nothing by itself, so follow it
  // here — unless its own handler already did (an event card opens the
  // event in the app and prevents the default).
  doc.addEventListener("click", (e) => {
    const a = linkOf(e.target);
    if (!a || e.defaultPrevented || a.hasAttribute("href")) return;
    e.preventDefault();
    window.open(a.dataset.href, "_blank", "noopener,noreferrer");
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const a = linkOf(e.target);
    if (a && !a.hasAttribute("href")) { e.preventDefault(); a.click(); }
  });
}
