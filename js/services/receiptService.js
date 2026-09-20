// ==========================================
// THE RECAP RECEIPT — loading, folding, painting
// ==========================================
//
// The arithmetic is in receiptRules.js. This file is only about when
// the receipt is read, when it is written, and what the card looks
// like.
//
// COST. One read, ever, and only for someone who has actually been to
// something — the document is not fetched until there is a first event
// to fold. Writes are debounced, so a recap page that brings in twenty
// finished events costs ONE write, not twenty. Nothing here queries
// anything: every event it folds was already loaded and paid for by
// the feed or the recap.
// ==========================================

import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { escapeHtml, safeId, renderAvatar } from '../utils/formatters.js';
import { displayNameFor, avatarFor } from './userService.js';
import {
  emptyReceipt, countable, foldAll, summarise, monthKey
} from './receiptRules.js';

const SAVE_DEBOUNCE_MS = 1500;

let receipt = emptyReceipt();
let loaded = false;
let loading = null;      // the in-flight read, so two harvests share one
let saveTimer = 0;
let dirty = false;

function receiptRef() {
  if (!state.uid) return null;
  return db.collection("users").doc(state.uid).collection("private").doc("receipt");
}

/** Called from resetState()'s caller on sign-out. */
export function clearReceipt() {
  clearTimeout(saveTimer);
  receipt = emptyReceipt();
  loaded = false;
  loading = null;
  dirty = false;
  saveTimer = 0;
}

async function load() {
  if (loaded) return receipt;
  if (loading) return loading;

  const ref = receiptRef();
  if (!ref) return receipt;

  loading = ref.get()
    .then((doc) => {
      // A partial document (an older shape, a half-written one) folds
      // in fine — the rules functions default every field.
      const data = doc.exists ? doc.data() : null;
      receipt = {
        months: (data && data.months) || {},
        counted: (data && data.counted) || []
      };
      loaded = true;
      return receipt;
    })
    .catch((e) => {
      console.error("Receipt load failed:", e.code || e.message);
      // Leave `loaded` false so the next harvest tries again, but do
      // NOT fold into an empty receipt in the meantime: that would
      // recount everything and inflate the numbers.
      return null;
    })
    .finally(() => { loading = null; });

  return loading;
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  const ref = receiptRef();
  if (!ref || !dirty) return;
  dirty = false;
  try {
    await ref.set(receipt);
  } catch (e) {
    console.error("Receipt save failed:", e.code || e.message);
    dirty = true;    // try again on the next harvest
  }
}

/** Flushed on pagehide, like the pending hype writes. */
export function flushReceipt() {
  if (!dirty) return;
  clearTimeout(saveTimer);
  save();
}

/**
 * Fold anything finished that is already in the event cache.
 *
 * Safe to call on every repaint: countable() rejects an event that has
 * been folded before, so the common case is a single pass over a small
 * array and no work at all.
 */
export function harvestReceipt(onChange) {
  if (!state.uid) return;

  const now = Date.now();
  const cache = state.eventCache || {};
  // A cheap pre-check against the receipt we have. If it has not
  // loaded yet this is the unloaded one, which is fine — it only
  // decides whether the read is worth doing at all.
  const pending = Object.keys(cache)
    .map((id) => cache[id])
    .filter((e) => e && countable(receipt, e, state.uid, now));

  if (!pending.length) return;

  Promise.resolve(load()).then((fresh) => {
    if (!fresh) return;                   // the read failed; try later
    const next = foldAll(receipt, pending, state.uid, now);
    if (next === receipt) return;         // everything was already counted
    receipt = next;
    scheduleSave();
    renderReceipt();
    if (typeof onChange === "function") onChange();
  });
}

/**
 * Read the receipt because the Recap tab has been opened.
 *
 * THE CARD USED TO LIE, and this is the fix. `load()` was only ever
 * called from harvestReceipt, and harvestReceipt returns early when
 * nothing in the cache is countable — which is the ordinary case for
 * somebody coming back, since everything finished has already been
 * folded. So the document was never read, the in-memory receipt stayed
 * empty, and renderReceipt painted "Go to something and this fills in"
 * at a person with months of history behind them. It looked like the
 * card had failed to load, and in every sense it had.
 *
 * Reading it here rather than on any feed repaint keeps the cost story
 * intact: the card lives in Recap, so only somebody who opens Recap
 * pays the one read, once per session.
 */
export function primeReceipt() {
  if (loaded || loading || !state.uid) return;
  Promise.resolve(load()).then((fresh) => { if (fresh) renderReceipt(); });
}

/** What the card would say right now, without touching the network. */
export function receiptSummary(key = monthKey(Date.now())) {
  return summarise(receipt, key);
}

/* ---------------------------------------------------------------------
   The card
   ------------------------------------------------------------------- */

export function renderReceipt() {
  const el = document.getElementById("receiptCard");
  if (!el) return;

  // Nothing read yet is not the same as nothing to show. Painting the
  // empty state before the document has come back is what made a full
  // receipt look like a failed one, so this paints nothing at all and
  // waits: primeReceipt() calls back here the moment it lands.
  if (!loaded) return;

  const s = receiptSummary();

  // Nothing to show is not the same as nothing to say. Somebody who
  // has never been to anything gets the point of the thing explained
  // once; after that the card earns its place.
  if (!s.went && !s.total) {
    el.innerHTML = `
      <div class="receipt receipt-empty">
        <b>Your receipt</b>
        <p>Go to something and this fills in — how often you turned up,
           what you went to, and who you keep running into.</p>
      </div>`;
    return;
  }

  const people = s.people.map((p) => {
    const id = safeId(p.uid);
    const avatar = `<div class="receipt-face">${renderAvatar(avatarFor(p.uid))}</div>`;
    return id
      ? `<div class="receipt-person" onclick="window.openProfileScreen('${id}')">
           ${avatar}<span>${escapeHtml(displayNameFor(p.uid))}</span><b>${p.count}</b>
         </div>`
      : `<div class="receipt-person">${avatar}<span>${escapeHtml(displayNameFor(p.uid))}</span><b>${p.count}</b></div>`;
  }).join("");

  // "1 time" reads like a bug.
  const times = s.went === 1 ? "once" : s.went + " times";

  el.innerHTML = `
    <div class="receipt">
      <div class="receipt-head">
        <b>Your receipt</b>
        <span>${escapeHtml(s.label)}</span>
      </div>

      <div class="receipt-line">
        You showed up <strong>${escapeHtml(times)}</strong>${
          s.hosted ? ` and started <strong>${s.hosted}</strong> of them` : ""
        }${s.topTag ? `, mostly <strong>${escapeHtml(s.topTag)}</strong>` : ""}.
      </div>

      ${people
        ? `<div class="receipt-people-head">Who you keep running into</div>
           <div class="receipt-people">${people}</div>`
        : `<div class="receipt-note">Go to a couple more and the people you
             keep running into show up here.</div>`}

      ${s.total > s.went
        ? `<div class="receipt-foot">${s.total} in total since you started using this.</div>`
        : ""}
    </div>`;
}
