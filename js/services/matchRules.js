// ==========================================
// FUZZY MATCHING
// ==========================================
//
// Search used to be exact: people by username prefix, events by literal
// substring. So "chia" found nothing, "sanchitt" found nothing, and
// searching a person by the name you actually see on their card —
// rather than their handle — found nothing either.
//
// This is the whole of the forgiving half, kept pure so it can be
// tested without a browser or a database. It answers one question:
// how well does this text match what somebody typed? Higher is better,
// and null means "not at all" so a caller can tell a weak match from
// no match.
//
// The tiers matter more than the numbers. An exact hit must always
// outrank a typo-corrected one, or a search for a real handle starts
// putting strangers above the person you meant.
// ==========================================

/** Lower case, accents folded, punctuation dropped, spaces collapsed. */
export function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // strip combining accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a string, already normalized. */
export function words(raw) {
  const n = normalize(raw);
  return n ? n.split(" ") : [];
}

/**
 * How many single-character edits turn `a` into `b`, giving up as soon
 * as the answer is known to exceed `max`.
 *
 * Counts a SWAP of two neighbours as one edit, not two. That is not a
 * refinement, it is the whole point: transposing two letters is the
 * most common typo there is, and plain Levenshtein calls "chia" two
 * edits from "chai" — far enough away to miss at any sane threshold.
 *
 * Bounded on purpose. A full matrix over a 12-item list is nothing, but
 * this runs on every keystroke over every cached user on a phone that
 * cost six thousand rupees, and the early exit turns the usual case —
 * two strings that are nothing like each other — into a couple of rows
 * of work instead of the whole matrix.
 *
 * Returns the distance, or `max + 1` to mean "further than you cared
 * about".
 */
export function editDistance(a, b, max = 2) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  if (!s.length || !t.length) return Math.max(s.length, t.length);

  const n = t.length;
  let older = new Array(n + 1).fill(0);   // row i-2, for the swap
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    let best = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      // the two letters are each other's, the other way round
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, older[j - 2] + 1);
      }
      curr[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;      // this whole row is already too far
    const spare = older; older = prev; prev = curr; curr = spare;
  }
  return prev[n] > max ? max + 1 : prev[n];
}

/**
 * How much slack a query of this length gets. One edit is the common
 * typo — a doubled letter, a missed one, two swapped. Two edits only
 * once the word is long enough that two edits still leaves it
 * recognisable; on a four-letter word, two edits is a different word.
 */
export function slackFor(query) {
  const n = String(query || "").length;
  if (n < 4) return 0;
  if (n < 7) return 1;
  return 2;
}

/** Are the letters of `q` in `text`, in order, possibly with gaps? */
export function isSubsequence(q, text) {
  const a = String(q || "");
  const b = String(text || "");
  if (!a) return false;
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (b[j] === a[i]) i++;
  }
  return i === a.length;
}

// The tiers, named so the intent survives a refactor.
export const EXACT = 100;
export const STARTS = 90;
export const WORD_STARTS = 80;
export const CONTAINS = 70;
export const ALL_WORDS = 60;
export const NEAR = 45;        // one or two typos away
export const LOOSE = 25;       // the right letters in the right order

/**
 * Score one piece of text against a query. null when it doesn't match.
 *
 * Read the order as the answer to "why did this come up?":
 *   it IS that -> it starts with that -> a word in it starts with that
 *   -> it contains that -> every word you typed is in there somewhere
 *   -> it is a typo away -> the letters are at least in that order.
 */
export function scoreMatch(rawQuery, rawText) {
  const q = normalize(rawQuery);
  const text = normalize(rawText);
  if (!q || !text) return null;

  if (text === q) return EXACT;
  if (text.startsWith(q)) return STARTS - Math.min(9, text.length - q.length) * 0.1;

  const parts = text.split(" ");
  if (parts.some((w) => w.startsWith(q))) return WORD_STARTS;
  if (text.includes(q)) return CONTAINS;

  // Several words typed: each one has to earn its place somewhere in
  // the text, so "panic chai" finds "Chai + assignment panic".
  const qs = q.split(" ");
  if (qs.length > 1 && qs.every((piece) => parts.some((w) => w.startsWith(piece)))) {
    return ALL_WORDS;
  }

  // Typos. Against the whole text for a short name, and against each
  // word, so one wrong letter deep in a sentence still lands.
  const slack = slackFor(q);
  if (slack > 0) {
    const whole = editDistance(q, text, slack);
    if (whole <= slack) return NEAR - whole * 4;
    for (const w of parts) {
      const d = editDistance(q, w, slack);
      if (d <= slack) return NEAR - 2 - d * 4;
      // A prefix typo: "sanchitt" against "sanchitkumar".
      if (w.length > q.length) {
        const p = editDistance(q, w.slice(0, q.length), slack);
        if (p <= slack) return NEAR - 4 - p * 4;
      }
    }
  }

  // Last resort: initials and dropped vowels — "sncht" -> "sanchit".
  // Only for queries long enough that the order means something.
  if (q.length >= 3 && !q.includes(" ") && isSubsequence(q, text.replace(/\s/g, ""))) {
    return LOOSE;
  }

  return null;
}

/**
 * The best score across several fields — a person matches on their
 * handle OR the name you see, whichever reads better.
 */
export function scoreAny(query, texts) {
  let best = null;
  for (const t of texts) {
    const s = scoreMatch(query, t);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

/**
 * Rank a list. `textsOf` returns the strings an item can match on.
 * Items that don't match at all are dropped. Ties keep the order they
 * came in, which is how the feed's own ordering survives.
 */
export function rank(query, items, textsOf) {
  return items
    .map((item, i) => ({ item, i, score: scoreAny(query, textsOf(item)) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i);
}
