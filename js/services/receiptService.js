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
  emptyReceipt, countable, foldAll, summarise, monthKey, stampFor, barcodeOf
} from './receiptRules.js';
import { vibeColor } from './eventsService.js';

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

  /* A RECEIPT, PRINTED. The card used to be a sentence in a box; it is
     a till slip now — torn at both ends, set in the mono voice, line
     items for what you went to, the regulars, a total, a stamp for the
     month and a barcode that is always the same for the same receipt.
     It prints itself out once per session (the first time it has
     something to say), and never again while you scroll. */
  const now = new Date();
  // Spelled out by hand: en-GB's short month is "Sept", which no till prints.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const printed = `${now.getDate()} ${MON[now.getMonth()]} ${now.getFullYear()}`;
  const [yy, mm] = String(s.key || "").split("-");
  const handle = String(state.username || "you").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 14) || "YOU";
  const number = `${mm || "00"}${String(yy || "").slice(2)}-${handle}`;
  const bars = barcodeOf(number + ":" + s.went + ":" + s.hosted)
    .map(([w, g]) => `<i style="width:${w}px;margin-right:${g}px"></i>`).join("");
  const top = `
      <div class="rc-brand"><img src="/logo-mark.svg" alt="" width="18" height="18">livesociya</div>
      <div class="rc-meta">Receipt for ${escapeHtml(s.label)}</div>
      <div class="rc-meta">No. ${escapeHtml(number)} \u00b7 ${escapeHtml(printed)}</div>`;
  const tail = `
      <div class="rc-bars" aria-hidden="true">${bars}</div>
      <div class="rc-meta rc-c">see you out there</div>`;

  // Nothing to show is not the same as nothing to say. Somebody who
  // has never been to anything gets the point of the thing explained
  // once; after that the card earns its place.
  if (!s.went && !s.total) {
    lastReceiptHtml = "";
    el.innerHTML = `
      <div class="receipt receipt-empty">
        ${top}
        <hr class="rc-rule">
        <b class="rc-empty-title">Nothing printed yet</b>
        <p>Go to something and this fills in — how often you turned up,
           what you went to, and who you keep running into.</p>
        ${tail}
      </div>`;
    return;
  }

  const row = (q, item, extra = "") =>
    `<div class="rc-row${extra}"><span class="rc-q">${q}</span><span class="rc-i">${item}</span></div>`;
  const items = [
    s.went ? row(s.went, s.went === 1 ? "Time you showed up" : "Times you showed up") : "",
    s.hosted ? row(s.hosted, s.hosted === 1 ? "Thing you started" : "Things you started") : "",
    ...(s.tags || []).map((t) => row(t.count,
      `<span class="rc-sw" style="background:${vibeColor(t.tag)}"></span>${escapeHtml(t.tag)}`))
  ].join("");

  const people = s.people.map((p) => {
    const id = safeId(p.uid);
    const inner = `<span class="receipt-face">${renderAvatar(avatarFor(p.uid))}</span><span class="rc-name">${escapeHtml(displayNameFor(p.uid))}</span><span class="rc-dots"></span><b>\u00d7${p.count}</b>`;
    return id
      ? `<div class="receipt-person" role="button" onclick="window.openProfileScreen('${id}')">${inner}</div>`
      : `<div class="receipt-person">${inner}</div>`;
  }).join("");

  const stamp = stampFor(s.went, s.hosted);
  const stampHtml = stamp
    ? `<div class="rc-stamp" style="--c:${s.topTag ? vibeColor(s.topTag) : "var(--forest)"}" aria-label="${escapeHtml(stamp.title)}">${escapeHtml(stamp.title)}<small>${escapeHtml(stamp.sub)}</small></div>`
    : "";

  const html = `
    <div class="receipt">
      ${top}
      ${stampHtml}
      <hr class="rc-rule">
      <div class="rc-row rc-head"><span class="rc-q">Qty</span><span class="rc-i">Item</span></div>
      ${items}
      <hr class="rc-rule">
      ${people
        ? `<div class="rc-head receipt-people-head">Who you kept running into</div>
           <div class="receipt-people">${people}</div>`
        : `<div class="receipt-note">Go to a couple more and the people you
             keep running into show up here.</div>`}
      <hr class="rc-rule">
      ${s.topTag ? `<div class="rc-total"><span>Mostly</span><b>${escapeHtml(s.topTag)}</b></div>` : ""}
      <div class="rc-total rc-big"><span>Total, ${escapeHtml(s.label)}</span><b>${s.went}</b></div>
      ${s.total > s.went ? `<div class="rc-total rc-small"><span>Since you started</span><b>${s.total}</b></div>` : ""}
      <hr class="rc-rule">
      <div class="rc-thanks">Thank you for showing up</div>
      ${tail}
    </div>`;
  // Repainted with the feed; only written when it says something new —
  // which is also what lets the print-out finish: the Recap repaint
  // straight after the first paint used to replace the slip halfway
  // through printing.
  if (html === lastReceiptHtml && el.firstElementChild) return;
  lastReceiptHtml = html;
  el.innerHTML = html;
  if (!printedOnce) {
    printedOnce = true;
    el.firstElementChild?.classList.add("printing");
  }
}
let printedOnce = false;
let lastReceiptHtml = "";
