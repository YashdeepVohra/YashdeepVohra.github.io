/**
 * Things YOU reported, hidden from YOUR screen straight away.
 *
 * A report goes to the admin, and nothing is taken down for everybody
 * until they look at it — the app cannot count reports without telling
 * whoever it reported who did it, and reports are anonymous. But the
 * person who reported something should not have to keep looking at it.
 *
 * Kept in this browser only (a convenience, not a record): a key per
 * item, "<type>:<id>", capped so it can never grow without end.
 */
const KEY = "ls-hidden-v1";
const MAX = 500;
let hidden = null;
const listeners = [];

function load() {
  if (hidden) return hidden;
  try { hidden = new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); }
  catch (e) { hidden = new Set(); }
  return hidden;
}

export function isHidden(type, id) {
  return load().has(`${type}:${id}`);
}

export function hideLocally(type, id) {
  const set = load();
  set.add(`${type}:${id}`);
  const list = [...set].slice(-MAX);
  hidden = new Set(list);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* private mode: this visit only */ }
  listeners.forEach((fn) => { try { fn(); } catch (e) { /* a painter's problem, not ours */ } });
}

export function onHiddenChange(fn) {
  listeners.push(fn);
}
