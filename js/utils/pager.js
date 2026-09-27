/**
 * TWENTY AT A TIME — for any list of people.
 *
 * Followers, following, your orbit, the people you blocked, follow
 * requests: each of these used to paint the whole list at once, and
 * paying for it meant one profile read per name — all of them, the
 * moment the list opened. A list of 300 cost 300 reads to look at the
 * first ten.
 *
 * Now a list shows twenty. At its end sits a SENTINEL: two skeleton rows
 * that shimmer, so the list never looks stuck. When the sentinel
 * scrolls into view (or 300px before), the next twenty names are
 * fetched — and, for followers, the next twenty people — and slide in.
 *
 * The pager only counts. Each list keeps its own ids and paints its
 * own rows; it asks `shown(key)` how many to paint, draws `sentinel(key)`
 * under them while there is more, and calls `watch(root, onMore)` after
 * painting.
 */
export const PAGE = 20;

const counts = new Map();   // key -> how many rows are shown
const before = new Map();   // key -> how many were shown before the last page (for the slide-in)
const busy = new Set();

/** How many rows of this list to paint. */
export function shown(key) {
  return counts.get(key) || PAGE;
}

/** Rows at or past this index arrived with the last page: they slide in. */
export function freshFrom(key) {
  return before.has(key) ? before.get(key) : Infinity;
}

/** Start a list again from its first twenty (a different person, a different list). */
export function resetPager(key) {
  counts.delete(key);
  before.delete(key);
  busy.delete(key);
}

export function isLoadingMore(key) {
  return busy.has(key);
}

/** The shimmering rows at the bottom of a list that has more. */
export function sentinel(key) {
  const row = `<div class="sk-row"><span class="sk-av"></span><span class="sk-lines"><span></span><span></span></span></div>`;
  return `<div class="list-more" data-more="${String(key).replace(/[^A-Za-z0-9:_-]/g, "")}" role="status" aria-label="Loading more">${row}${row}</div>`;
}

/**
 * Grow `key` by a page: `load()` does whatever the next page needs
 * (fetch the next names, fetch the next followers) and resolves; then
 * the count moves and `repaint()` draws the longer list.
 */
export async function nextPage(key, load, repaint) {
  if (busy.has(key)) return;
  busy.add(key);
  try {
    await load(shown(key));
  } catch (e) {
    console.warn("Next page failed:", e && (e.code || e.message));
  }
  before.set(key, shown(key));
  counts.set(key, shown(key) + PAGE);
  busy.delete(key);
  repaint();
}

let observer = null;
let handler = null;

/**
 * Watch every sentinel under `root`. One observer for the whole app:
 * only one list is ever on screen, so the latest caller's handler is
 * the one that matters.
 */
export function watch(root, onMore) {
  handler = onMore;
  if (!root) return;
  const marks = root.querySelectorAll("[data-more]");
  if (!marks.length) return;
  if (!("IntersectionObserver" in window)) {
    marks.forEach((m) => handler && handler(m.dataset.more));
    return;
  }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        observer.unobserve(en.target);
        if (handler) handler(en.target.dataset.more);
      });
    }, { rootMargin: "0px 0px 300px 0px" });
  }
  marks.forEach((m) => observer.observe(m));
}
