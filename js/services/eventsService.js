// ==========================================
// EVENTS (CAMPUS FEED + RECAP)
// ==========================================
//
// Ownership and membership are stored as uids:
//   hostUid          who created it
//   participantUids  who is going
//   hypedUids        who hyped it
//
// Nothing user-typed is ever placed into an inline onclick attribute.
// Handlers receive Firestore document ids only; text is pulled from
// state.eventCache on the other side.
// ==========================================

import { auth, db, FieldValue, Timestamp } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar, escapeHtml, safeId, clockTime } from '../utils/formatters.js';
import { showTab, toast, returnChip, switchScreen } from '../utils/ui.js';
import { openOverlay, closeOverlay, replaceOverlay, isOverlayTop } from '../utils/overlays.js';
import { primeUsers, displayNameFor, usernameFor, avatarFor } from './userService.js';
import { isBlocked, withoutBlocked } from './blockService.js';
import { stampEvent, readLimits, limitMessage } from './limitsService.js';
import { askConfirm } from '../utils/confirm.js';
import { inOrbit, vouchersYouKnow } from './orbitService.js';
import { rankFeed } from './feedRules.js';
import { RECAP_MAX_MS, EVENT_TTL_AFTER_MS, inRecap, recapUntil, wasCalledOff } from './recapRules.js';
import { harvestReceipt, renderReceipt, primeReceipt } from './receiptService.js';
import { myCircleId, circleGeo, feedIsScoped } from './circleService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When this event's document may be swept.
 *
 * A real Timestamp, because a Firestore TTL policy can only be set on
 * one — and because a field like this cannot be added to documents
 * that already exist without rewriting every one of them, it goes in
 * from the first event rather than the first time anybody needs it.
 * The rules check it follows expiresAt, so it cannot be turned into a
 * way of keeping a document around forever.
 *
 * Nothing sweeps yet: see the note on EVENT_TTL_AFTER_MS for why
 * turning the policy on has to wait for a delete that cascades.
 */
function ttlFor(expiresAt) {
  return Timestamp.fromMillis(expiresAt + EVENT_TTL_AFTER_MS);
}

// Mirrors sensibleEventWindow() in firestore.rules. The app refused a
// run longer than a week long before the database did; now both do,
// which is what stops sixty events dated the year 9999 being the feed.
const MAX_RUN_MS = 7 * DAY_MS;
const MAX_AHEAD_MS = 90 * DAY_MS;

// A campus does not have 60 things happening at once. The live feed is
// bounded rather than paged, because it has to stay realtime.
const LIVE_LIMIT = 60;
const RECAP_PAGE = 12;

// ---------- Create screen ----------
export function selectTag(element, tag) {
  document.querySelectorAll("#tagSelector .tag").forEach((t) => t.classList.remove("active"));
  element.classList.add("active");
  state.currentSelectedTag = tag || element.innerText;
}

/** Mark the pill whose data-tag matches, wherever that pill lives. */
function syncFilterPills(containerSelector, tag) {
  document.querySelectorAll(`${containerSelector} .filter-pill`).forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.tag === tag);
  });
}

// Filtering used to call renderEvents(), which threw away every card
// that did not match and built the matching ones from scratch — so
// every pill tap meant up to 60 cards destroyed, 12 created, and a
// 340ms entry animation on each new one. Every card is in the DOM
// already; a filter just decides which of them are shown.
export function setLiveFilter(element, tag) {
  state.currentLiveFilter = tag;
  syncFilterPills("#liveFilters", tag);
  applyFilter(document.getElementById("events"), tag);
}

export function setRecapFilter(element, tag) {
  state.currentRecapFilter = tag;
  syncFilterPills("#recapFilters", tag);
  applyFilter(document.getElementById("recapEvents"), tag);
}

/**
 * Desktop rail shortcut: switch to the live feed and apply a vibe
 * filter, keeping the real filter row in sync so the two never disagree.
 */
export function jumpToVibe(tag) {
  showTab("events");
  setLiveFilter(null, tag);
}

export function toggleEventDesc(eventId) {
  const card = document.getElementById(`event-${eventId}`);
  if (!card) return;
  card.classList.toggle("expanded");
  const btn = card.querySelector(".read-more-btn");
  if (btn) btn.innerText = card.classList.contains("expanded") ? "Less" : "More";
}

/** Create mode: blank sheet, "Publish". */
/* ---------------------------------------------------------------------
   Day one
   ---------------------------------------------------------------------
   The first students to open this app will open it to nothing, because
   nothing exists yet. That empty screen IS the product for them, and
   "Campus is quiet" told them the app was working but gave them nothing
   to do — so they close it, and the app never reaches the point where
   there is something to see.

   So the empty feed asks for one thing instead: start something. Three
   openers, each one tap, each landing in Create Event with the title
   and the vibe already filled in and the cursor in the place field —
   because the only question left is where.
   ------------------------------------------------------------------- */
const STARTERS = [
  {
    tag: "\u2615 Chill",
    title: "Chai and complaining",
    label: "Chai run",
    sub: "Grab whoever's free",
    vibe: "var(--vibe-chill)"
  },
  {
    tag: "\u{1F4DA} Study",
    title: "Study grind",
    label: "Study session",
    sub: "Misery loves company",
    vibe: "var(--vibe-study)"
  },
  {
    tag: "\u{1F3C0} Sports",
    title: "Football, whoever turns up",
    label: "Kick a ball",
    sub: "Whoever turns up",
    vibe: "var(--vibe-sports)"
  }
];

/** Open Create Event already filled in, from one tap on the empty feed. */
export function startSomething(index) {
  const s = STARTERS[Number(index)] || STARTERS[0];
  openCreateScreen();
  state.currentSelectedTag = s.tag;
  document.querySelectorAll("#tagSelector .tag").forEach((t) => {
    t.classList.toggle("active", t.innerText.trim() === s.tag);
  });

  const title = document.getElementById("title");
  if (title) title.value = s.title;
  const place = document.getElementById("place");
  // The one thing only they know. Focus it, but not so fast that the
  // keyboard fights the sheet opening.
  if (place) setTimeout(() => place.focus(), 260);
}

export function openCreateScreen() {
  state.editingEventId = null;
  setCreateSheetMode("create");
  openOverlay("createScreen", { onClose: () => { state.editingEventId = null; } });
  const now = new Date();
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const forInput = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const startEl = document.getElementById("startTime");
  const endEl = document.getElementById("endTime");
  if (startEl) startEl.value = forInput(now);
  if (endEl) endEl.value = forInput(inTwoHours);

  const approval = document.getElementById("requiresApproval");
  if (approval) approval.checked = false;

  ["title", "place", "description", "maxCapacity"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  // A publish the server refused hands their words back rather than a
  // blank sheet. Once only — a second open is a fresh one.
  if (failedDraft) {
    const set = (id, value) => { const el = document.getElementById(id); if (el && value) el.value = value; };
    set("title", failedDraft.title);
    set("place", failedDraft.place);
    set("description", failedDraft.description);
    set("startTime", failedDraft.startTimeStr);
    set("endTime", failedDraft.endTimeStr);
    set("maxCapacity", failedDraft.capacityRaw);
    failedDraft = null;
  }
}

/** Swap the sheet between creating and editing. */
function setCreateSheetMode(mode) {
  const editing = mode === "edit";
  const heading = document.getElementById("createHeading");
  const submit = document.getElementById("createSubmit");
  if (heading) heading.innerText = editing ? "Edit event" : "New Broadcast";
  if (submit) submit.innerText = editing ? "Save" : "Publish";
}

/**
 * Edit mode: same sheet, pre-filled. Editing in place matters because
 * deleting and reposting destroys the event's group chat and everyone
 * who already said they were going.
 */
export function openEditScreen(eventId) {
  const e = state.eventCache[eventId];
  if (!e || e.hostUid !== state.uid) return;

  setCreateSheetMode("edit");
  const opts = { onClose: () => { state.editingEventId = null; } };
  if (isOverlayTop("deleteModal")) replaceOverlay("createScreen", opts);
  else openOverlay("createScreen", opts);

  // After the swap, so the Manage sheet's onClose cannot clear it.
  state.editingEventId = eventId;

  const forInput = (ms) => {
    const d = new Date(ms);
    return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set("title", e.title || "");
  set("place", e.place || "");
  set("description", e.description || "");
  set("startTime", forInput(e.startTime));
  set("endTime", forInput(e.expiresAt));
  set("maxCapacity", e.maxCapacity || "");

  const approval = document.getElementById("requiresApproval");
  if (approval) approval.checked = e.requiresApproval === true;

  state.currentSelectedTag = e.tag || state.currentSelectedTag;
  document.querySelectorAll("#tagSelector .tag").forEach((t) => {
    t.classList.toggle("active", t.innerText.trim() === (e.tag || "").trim());
  });
}

export function closeCreateScreen() {
  closeOverlay("createScreen");
}

export async function addEvent(e) {
  if (!auth.currentUser) return;
  if (state.editingEventId) return saveEventEdits(e);

  const btn = e?.target?.closest("button") || document.querySelector("#createScreen .text-action-btn");
  const title = document.getElementById("title")?.value.trim();
  const place = document.getElementById("place")?.value.trim();
  const description = document.getElementById("description")?.value.trim() || "";
  const startTimeStr = document.getElementById("startTime")?.value;
  const endTimeStr = document.getElementById("endTime")?.value;
  const capacityRaw = document.getElementById("maxCapacity")?.value;
  const maxCapacity = capacityRaw ? parseInt(capacityRaw, 10) : null;

  if (!title || !place || !startTimeStr || !endTimeStr) {
    return toast("Please fill out all event details.");
  }

  const startTime = new Date(startTimeStr).getTime();
  const expiresAt = new Date(endTimeStr).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(expiresAt)) return toast("Those dates don't look right.");
  if (expiresAt <= startTime) return toast("Your event end time must be AFTER the start time.");
  if (expiresAt - startTime > MAX_RUN_MS) return toast("Events can run for at most a week.");
  if (startTime - Date.now() > MAX_AHEAD_MS) return toast("That's too far ahead — three months at most.");

  const restore = () => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "Publish";
    }
  };

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i>`;
  }

  try {
    // The event and the rate-limit stamp go together or not at all:
    // the rule for the event checks, with getAfter(), that the stamp
    // landed in this same batch.
    const current = await readLimits();
    const batch = db.batch();
    const ref = db.collection("events").doc();
    stampEvent(batch, current);
    batch.set(ref, {
      hostUid: state.uid,
      title: title.slice(0, 80),
      place: place.slice(0, 80),
      description: description.slice(0, 500),
      tag: state.currentSelectedTag,
      startTime,
      expiresAt,
      participantUids: [state.uid],
      hypedUids: [],
      pendingUids: [],
      unconfirmedUids: [],
      requiresApproval: !!document.getElementById("requiresApproval")?.checked,
      maxCapacity: Number.isFinite(maxCapacity) && maxCapacity > 1 ? maxCapacity : null,
      createdAt: FieldValue.serverTimestamp(),
      ttlAt: ttlFor(expiresAt),
      // Who this is for. The rules check it against the host's own
      // circle, so an event cannot be published into somebody else's.
      circleId: myCircleId(),
      // And WHERE it is, copied off the circle. Nothing queries this
      // yet — it is here so that the day the feed becomes "near me",
      // every event already carries a position. See geoRules.js.
      geo: circleGeo()
    });
    /* PUBLISH IS NOT A ROUND TRIP ANY MORE.
       This used to `await batch.commit()` before closing the sheet, and
       a commit does not resolve until the SERVER has acknowledged it —
       so the publish button sat spinning for a full round trip, twice
       over counting the limits read above, while the event was already
       in the local cache and the feed listener had already been told
       about it. The card was ready before the screen would let go of
       it.
       Firestore's own latency compensation does the rest: the write is
       in the local snapshot immediately, and if the server refuses it
       the SDK takes it back out and the listener fires again without
       it. So the only thing left to do on failure is say so. */
    const draft = { title, place, description, startTimeStr, endTimeStr, capacityRaw };
    batch.commit().catch((error) => {
      console.error("Publish failed:", error.code || error.message);
      // A rules rejection arrives as a flat permission-denied, so the
      // only honest guess at the reason is the limit we just checked.
      toast(error.code === "permission-denied"
        ? limitMessage("event")
        : "Couldn't publish that. Your details are still here — try again.");
      // Their words back, so a refusal does not also cost them the typing.
      failedDraft = draft;
      openCreateScreen();
    });

    ["title", "place", "description", "maxCapacity"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    closeCreateScreen();
    // Land on the thing they just created rather than the top of the feed.
    showTab("events");
    setTimeout(() => focusEvent(ref.id), 350);
  } catch (error) {
    console.error("Publish failed:", error.code || error.message);
    toast("Couldn't publish that. Try again.");
  } finally {
    restore();
  }
}

// A publish the server refused, kept so reopening Create hands their
// own words back rather than a blank sheet.
let failedDraft = null;

/**
 * Who you know, in the shape feedRules wants it.
 *
 * Nothing here costs a read: your orbit and your following list are
 * both in state, and the vouch lists ride along on the cached profiles
 * the feed has already fetched to draw its bylines.
 */
function socialGraph(events) {
  // Built from the events being ranked, not from the last order — the
  // last order is what this is about to replace.
  const vouchedBy = [];
  (events || []).forEach((e) => {
    if (e && e.hostUid && !vouchedBy.includes(e.hostUid) && vouchersYouKnow(e.hostUid).length) {
      vouchedBy.push(e.hostUid);
    }
  });
  return {
    uid: state.uid,
    orbit: state.orbitUids || [],
    following: state.following || [],
    vouchedBy
  };
}

// ---------- Feed ----------
export function loadEvents() {
  if (state.eventsUnsubscribe) state.eventsUnsubscribe();

  // Show the shape of what's loading rather than an empty column.
  const liveList = document.getElementById("events");
  if (liveList && !liveList.children.length) liveList.innerHTML = skeletonFeed(3);

  let feedQuery = db.collection("events");

  /* YOUR CIRCLE, when there is more than one of them. While everybody
     shares one campus this filter removes nothing and costs a
     composite index the query cannot run without, so it is off — see
     feedIsScoped() in circleService.js. Events are tagged either way,
     which is what makes turning it on a one-line change and not a
     migration. */
  if (feedIsScoped()) feedQuery = feedQuery.where("circleId", "==", myCircleId());

  state.eventsUnsubscribe = feedQuery
    // ONLY what is still running. Recap is 24 hours of finished events
    // that most people never open — loading it with the feed meant
    // every user paid for it on every launch. It is paged in on demand
    // now, by loadRecap().
    .where("expiresAt", ">", Date.now())
    .orderBy("expiresAt", "desc")
    .limit(LIVE_LIMIT)
    .onSnapshot(
      async (snapshot) => {
        feedRetries = 0;
        const events = [];
        const uids = new Set();

        snapshot.forEach((doc) => {
          const data = applyPendingHype({ id: doc.id, ...doc.data() });
          events.push(data);
          state.eventCache[doc.id] = data;
          if (data.hostUid) uids.add(data.hostUid);
          (data.participantUids || []).forEach((u) => uids.add(u));
        });

        await primeUsers([...uids]);

        /* Happening now first, then what starts soonest — and inside
           each hour of that, the people you would actually show up for
           before the strangers. feedRules.js has the weights and the
           argument for why the social part is a TIEBREAK: sorting by it
           outright would bury a stranger's thing starting in five
           minutes under a friend's thing starting in six hours, and
           "happening now" is the whole product.
           The graph is free — every list here is already in memory for
           the trust chip on the card. */
        state.eventOrder = rankFeed(events, socialGraph(events)).map((x) => x.id);

        renderEvents();
      },
      (error) => {
        console.error("Feed error:", error.code || error.message);
        state.eventsUnsubscribe = null;
        reportFeedFailure(error);
        retryFeed(error);
      }
    );
}

/**
 * Try the feed again, now, from the top.
 *
 * Bound to the button a failed feed puts on screen, and called when
 * the tab comes back to the front. Resets the backoff, because a
 * person asking for it is new information — the last five failures
 * were a minute ago and the network has probably moved on.
 */
export function retryFeedNow() {
  feedRetries = 0;
  clearTimeout(feedRetryTimer);
  if (state.uid) loadEvents();
}

/* ---------------------------------------------------------------------
   A listener that errors is DEAD, and some deaths are not worth waiting
   through
   ---------------------------------------------------------------------
   Firestore never revives a listener that has errored, which is why
   there is a retry at all. But the backoff doubles — 1.2s, 2.4s, 4.8s,
   9.6s, 19.2s — and then gives up in silence. For a flaky connection
   that is right. For `failed-precondition`, which is Firestore saying
   "this query has no index", it is close to the worst thing we could
   do: the feed goes quiet, comes back for one snapshot, goes quiet for
   twice as long, and after about forty seconds stops for good. Nothing
   on screen says anything is wrong, so what it looks like is a feed
   that has become slow — on every device at once, because the missing
   index is not on any of them.

   So that one does not retry. It says what is wrong, where.
   ------------------------------------------------------------------- */

function isMissingIndex(error) {
  const code = String((error && error.code) || "");
  return code === "failed-precondition" || code.indexOf("failed-precondition") !== -1;
}

/**
 * Say the feed is broken, and leave a way out of it.
 *
 * A failed feed used to leave the SKELETONS on screen for ever: the
 * listener was dead, nothing repainted, and there was no route back
 * except reloading the page — which on a phone means finding the
 * browser chrome the app is trying not to have. Three loading cards
 * that never become anything is the worst of both, because it reads as
 * "still trying" when nothing is trying at all.
 */
function reportFeedFailure(error) {
  if (isMissingIndex(error)) {
    console.error(
      "The feed query has no index.\n" +
      "Deploy it:  firebase deploy --only firestore:indexes\n" +
      "Or create it by hand from the link Firestore puts in the error " +
      "above.\n" +
      "Until it exists and has finished BUILDING, this feed cannot load."
    );
  }

  const list = document.getElementById("events");
  // Something real on screen is better than an error over the top of it.
  if (!list || list.querySelector(".event")) return;

  list.innerHTML = `
    <div class="empty-state">
      <span class="fr-spark">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path d="M12 3v10M12 17.5v.5" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" fill="none"/>
        </svg>
      </span>
      <h4>Can't reach the feed</h4>
      <p>Something went wrong on our side. Your events are safe — this is
         just the list.</p>
      <button class="act primary" onclick="window.retryFeedNow()">Try again</button>
    </div>`;
}

let feedRetries = 0;
let feedRetryTimer = 0;

function retryFeed(error) {
  // No amount of waiting builds an index — but the button is there.
  if (isMissingIndex(error)) return;
  if (feedRetries >= 5) return;
  const wait = 1200 * Math.pow(2, feedRetries);
  feedRetries++;
  clearTimeout(feedRetryTimer);
  feedRetryTimer = setTimeout(() => { if (state.uid) loadEvents(); }, wait);
}

/* ---------------------------------------------------------------------
   Presentation helpers
   ------------------------------------------------------------------- */

// Each vibe carries its own accent. A feed of one colour reads as a
// wall; keyed colour lets the eye sort categories while scrolling.
const VIBE = {
  "☕ Chill":  "var(--vibe-chill)",
  "🍕 Food":   "var(--vibe-food)",
  "🎉 Party":  "var(--vibe-party)",
  "📚 Study":  "var(--vibe-study)",
  "🏀 Sports": "var(--vibe-sports)"
};
export const vibeColor = (tag) => VIBE[tag] || "var(--sage)";

// Drawn rather than an icon font: it carries the palette and can move.
const EMPTY_ART = `
  <svg class="empty-art" viewBox="0 0 120 90" fill="none" aria-hidden="true">
    <ellipse cx="60" cy="78" rx="34" ry="5" fill="var(--sage)" opacity="0.25"/>
    <g class="float-a">
      <rect x="34" y="24" width="52" height="40" rx="12" fill="var(--paper)" stroke="var(--sage)" stroke-width="2"/>
      <circle cx="49" cy="42" r="3.4" fill="var(--sage)"/>
      <circle cx="71" cy="42" r="3.4" fill="var(--sage)"/>
      <path d="M50 53c4 4 16 4 20 0" stroke="var(--sage)" stroke-width="2" stroke-linecap="round"/>
    </g>
    <g class="float-b">
      <circle cx="24" cy="26" r="6" fill="var(--vibe-food)" opacity="0.5"/>
      <circle cx="98" cy="34" r="4.5" fill="var(--vibe-party)" opacity="0.5"/>
      <circle cx="92" cy="16" r="3" fill="var(--vibe-sports)" opacity="0.5"/>
    </g>
  </svg>`;

/** "12m", "3h", "in 2h" — the compact relative time every feed uses. */
function relTime(ms, now = Date.now()) {
  const diff = ms - now;
  const ahead = diff > 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  let label;
  if (mins < 1) label = "now";
  else if (mins < 60) label = `${mins}m`;
  else if (mins < 1440) label = `${Math.round(mins / 60)}h`;
  else label = `${Math.round(mins / 1440)}d`;
  if (label === "now") return "now";
  return ahead ? `in ${label}` : `${label} ago`;
}

/**
 * THE POSTER STAT.
 *
 * A card's most important fact is WHEN, and until now it was eleven
 * pixels of grey next to the handle. This is Caldera's stat card
 * applied to it: a small mono label, then one short value set in the
 * display face at poster scale.
 *
 * It has to stay SHORT — two or three characters wherever possible —
 * because the whole point is that you read it at a glance while
 * scrolling. Hence "45M" rather than "in 45 minutes", and the actual
 * clock time demoted to the line underneath, which is what you need
 * only once you have decided you care.
 */
function timeStat(e, now) {
  const clock = clockTime(e.startTime);

  if (e.expiresAt <= now) {
    return { label: "Ended", value: relTime(e.expiresAt, now).replace(" ago", ""), sub: "ago" };
  }
  if (now >= e.startTime) {
    // Live. The useful number is how long is left, not how long it has
    // been running: you are deciding whether it is worth walking over.
    const leftMins = Math.max(0, Math.round((e.expiresAt - now) / 60000));
    const left = leftMins < 60 ? leftMins + "m" : Math.round(leftMins / 60) + "h";
    return { label: "Happening", value: "Now", sub: left + " left", live: true };
  }
  const mins = Math.round((e.startTime - now) / 60000);
  const value = mins < 1 ? "Now"
    : mins < 60 ? mins + "m"
    : mins < 1440 ? Math.round(mins / 60) + "h"
    : Math.round(mins / 1440) + "d";
  return { label: "Starts in", value, sub: clock };
}

/**
 * The band across the top of a card: a halftone field in the event's
 * own colour, the category, and the stat.
 *
 * The halftone is two background layers and nothing else — a dot grid,
 * with a linear gradient painted OVER it that fades from transparent
 * to the solid band colour. No image, no mask, no extra element, so
 * sixty of them down a feed cost one paint each. `--vibe` is already
 * on the card, so the colour comes along for free.
 */
/**
 * One stat: a big value, with its label and footnote stacked beside.
 *
 * A TIME stat leaves its value and footnote EMPTY, marked `data-vt`,
 * and paintVolatile fills them in after the card is in the document.
 * That is not a flourish — it is what stops the minute tick rebuilding
 * the feed. See the note on paintVolatile.
 */
function statBlock(s, { volatileTime = false } = {}) {
  if (!s) return "";
  const value = volatileTime
    ? `<span class="poster-value" data-vt="value"></span>`
    : `<span class="poster-value">${escapeHtml(s.value)}</span>`;
  const sub = volatileTime
    ? `<span class="poster-sub" data-vt="sub"></span>`
    : (s.sub ? `<span class="poster-sub">${escapeHtml(s.sub)}</span>` : "");
  return `
    <span class="poster-stat">
      ${value}
      <span class="poster-side">
        <span class="poster-label">${s.live ? `<span class="live-pip"></span>` : ""}${escapeHtml(s.label)}</span>
        ${sub}
      </span>
    </span>`;
}

/**
 * The band takes up to two stats, because a card is answering two
 * questions and until now it only answered one at a glance: when is
 * this, and is anybody actually going. Those are the two things you
 * decide on, so they are the two things set at poster scale.
 */
function posterBand(e, now, { stats, spent = false } = {}) {
  const list = (stats || [timeStat(e, now)]).filter(Boolean);
  const glyph = (e.tag || "").trim().split(" ")[0];
  const word = (e.tag || "").trim().split(" ").slice(1).join(" ");
  // TWO COLUMNS, not one box with things positioned inside it. The
  // halftone kept ending up under the type — first as a background
  // layer, then as an absolutely positioned corner that a taller card
  // grew into. Coordinates can always be out-grown; siblings cannot
  // overlap. The deco column gives up its width to the type column
  // when the stats need it, so the type is never the thing that
  // shrinks.
  return `
    <div class="poster${spent ? " spent" : ""}">
      <div class="poster-type">
        <div class="poster-head">
          ${e.tag ? `<span class="poster-tag">${escapeHtml(glyph)} ${escapeHtml(word)}</span>` : ""}
        </div>
        <div class="poster-stats">${list.map((st, i) => statBlock(st, { volatileTime: i === 0 && !spent })).join("")}</div>
      </div>
      <div class="poster-deco" aria-hidden="true">
        ${glyph ? `<span class="poster-glyph">${escapeHtml(glyph)}</span>` : ""}
      </div>
      ${spent ? "" : `<span class="poster-clock" aria-hidden="true"><span data-vt="clock"></span></span>`}
    </div>`;
}

/** Overlapping avatar stack, capped at four plus a counter. */
function avatarStack(uids) {
  const shown = uids.slice(0, 4);
  const rest = uids.length - shown.length;
  const chips = shown
    .map((uid) => {
      const id = safeId(uid);
      const tap = id ? `class="mini tappable" onclick="event.stopPropagation(); window.openProfileScreen('${id}')"` : `class="mini"`;
      return `<div ${tap}>${renderAvatar(avatarFor(uid))}</div>`;
    })
    .join("");
  const more = rest > 0 ? `<div class="mini more">+${rest}</div>` : "";
  return `<div class="av-stack">${chips}${more}</div>`;
}

/**
 * Who is going, not counting the host — the byline right above already
 * names them, and "Aarav, Diya and 2 more" under "Aarav" said it twice.
 */
function goingText(uids, unconfirmedCount = 0, isHost = false) {
  const tail = unconfirmedCount > 0
    ? ` <span class="unconfirmed-tag">${unconfirmedCount} not confirmed</span>`
    : "";
  if (!uids.length) return (isHost ? "Nobody's joined yet" : "Nobody else yet — be first") + tail;
  const names = uids.slice(0, 2).map((uid) => {
    const id = safeId(uid);
    const name = escapeHtml(displayNameFor(uid));
    // Profile first: messaging someone is one of several things you
    // might want to do with them, and the others live on the profile.
    return id ? `<b onclick="event.stopPropagation(); window.openProfileScreen('${id}')">${name}</b>` : name;
  });
  const rest = uids.length - names.length;
  return names.join(", ") + (rest > 0 ? ` and ${rest} more going` : " going") + tail;
}

function skeletonFeed(count = 3) {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `
      <div class="skel-card">
        <div class="skel-row">
          <div class="skel skel-avatar"></div>
          <div style="flex:1">
            <div class="skel skel-line w-40"></div>
            <div class="skel skel-line w-60"></div>
          </div>
        </div>
        <div class="skel skel-line w-80"></div>
        <div class="skel skel-line w-100"></div>
      </div>`;
  }
  return out;
}

/* ---------------------------------------------------------------------
   The live rail — a stories row of what is on right now
   ------------------------------------------------------------------- */

// Last markup written into the story rail, so an unchanged rail is left alone.
let railPainted = "";

function renderLiveRail(order, now) {
  const wrap = document.getElementById("liveRailWrap");
  const rail = document.getElementById("liveRail");
  if (!rail || !wrap) return;

  const items = order
    .map((id) => state.eventCache[id])
    .filter((e) => e && e.expiresAt > now && !isBlocked(e.hostUid))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, 12);

  // The header's count: how many are on at this moment. Upcoming ones
  // are in the rail but not in this number. renderEvents runs on the
  // minute tick, so it moves when something starts or ends.
  const countEl = document.getElementById("liveCount");
  const onNow = items.filter((e) => now >= e.startTime).length;
  if (countEl) {
    countEl.classList.toggle("hidden", onNow === 0);
    const n = document.getElementById("liveCountN");
    if (n && n.textContent !== String(onNow)) n.textContent = String(onNow);
  }

  // An empty rail is worse than no rail.
  wrap.classList.toggle("hidden", items.length === 0);
  if (!items.length) { rail.innerHTML = ""; railPainted = ""; return; }

  const railHTML = items.map((e) => {
    const id = safeId(e.id);
    if (!id) return "";
    const isLive = now >= e.startTime;
    return `
      <button class="live-story" onclick="window.focusEvent('${id}')" title="${escapeHtml(e.title)}">
        <span class="story-ring ${isLive ? "" : "upcoming"}">
          <span class="story-inner">${renderAvatar(avatarFor(e.hostUid))}</span>
        </span>
        <span class="story-label">${escapeHtml(displayNameFor(e.hostUid))}</span>
      </button>`;
  }).join("");

  // Same story as the feed: rewriting this on every hype restarted the
  // avatar animations for no reason. Only write when it really differs.
  if (railPainted !== railHTML) {
    rail.innerHTML = railHTML;
    railPainted = railHTML;
  }
}

/** Rail shortcut: bring a card into view and flash it. */
export function focusEvent(eventId) {
  const card = document.getElementById(`event-${eventId}`);
  if (!card) return;
  // A card that is already fully on screen does not need moving, and
  // moving it costs something now: centring scrolls the top of the
  // column away, and the way back to a conversation lives up there.
  // The common case — a shared event still near the top of a feed that
  // is newest-first — therefore leaves the chip where you can see it.
  const box = card.getBoundingClientRect();
  const fits = box.top >= 0 && box.bottom <= (window.innerHeight || 0);
  if (!fits) card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1400);
}

/**
 * A tap on an event card inside a chat. Goes to the right tab and
 * lands on the card — the card in the feed IS the event, so there is
 * nothing else to open.
 *
 * Returns false so the anchor's href never navigates: the href is
 * there so the link still means something when it is copied, pasted
 * elsewhere, or opened by a client that has never heard of us.
 */
export function openSharedEvent(eventId, ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (!safeId(eventId)) return false;
  showSharedEvent(eventId);
  return false;
}

/**
 * Is there anywhere for this event to land?
 *
 * A live event is in the feed. A finished one is in Recap, but only
 * until recapRules ages it out — after that there is no card for it
 * anywhere in the app, and an event the viewer has never seen is not
 * in the cache at all (fillEventEmbeds already primed it; if it is
 * still missing, the document is gone).
 */
function hasSomewhereToLand(e, now = Date.now()) {
  if (!e) return false;
  return e.expiresAt > now || inRecap(e, now, state.uid);
}

/**
 * Open a shared event: close the conversation, go to the tab it lives
 * in, land on its card, and leave a way back.
 *
 * This used to fork on width. A laptop kept the thread open and flashed
 * the card in a 360px column beside it, on the theory that closing the
 * conversation threw away the place you were reading. What it actually
 * threw away was the card: 360px is narrower than a phone gives the
 * feed, so the poster was cramped and the action row wrapped inside a
 * 1280px window. The column is gone and so is the fork — one path, one
 * thing to reason about, and the event gets the whole width everywhere.
 *
 * The way back is the `returnChip`: one tap to the person, gone after
 * nine seconds, and cleared by `switchScreen` so it can never point at
 * a conversation you are no longer coming from.
 *
 * `closeChat({ silent: true })` deliberately does NOT swap screens, so
 * the `switchScreen("home")` below is not optional — without it the tab
 * changes underneath a thread that is still covering it, and View looks
 * like it did nothing at all.
 */
export function showSharedEvent(eventId) {
  const e = state.eventCache[eventId];
  const now = Date.now();

  // GOING NOWHERE IS BETTER THAN GOING SOMEWHERE EMPTY. This used to
  // swap the tab whatever the event turned out to be — and on a phone
  // that also closed the conversation you were reading. For an event
  // that had ended and aged out of Recap, or one whose document is
  // gone entirely, the reward for all that was an empty tab: the card
  // it scrolled to does not exist. An undefined event also read as
  // `ended === false`, so it went to Live Now rather than Recap, which
  // is how a finished event ended up bouncing people into the events
  // tab. Say so and stay put instead.
  if (!hasSomewhereToLand(e, now)) {
    toast("That event has ended.");
    return false;
  }

  const ended = e.expiresAt <= now;

  // Recap is PAGED — `recapOrder` holds only what loadRecap has walked
  // back to so far, and renderEvents builds cards from that list. An
  // event still inside its window can easily not be in it yet, so the
  // tab would swap to a stub that never gets built. It is already in
  // the cache, and inRecap() has just vouched for it, so adding the id
  // costs nothing and no read.
  if (ended && !(state.recapOrder || []).includes(eventId)) {
    state.recapOrder = (state.recapOrder || []).concat(eventId);
  }

  const land = () => setTimeout(() => {
    // After the tab has actually swapped, or there is nothing to find.
    if (!document.getElementById(`event-${eventId}`)) renderEvents();
    setTimeout(() => focusEvent(eventId), 60);
  }, 90);

  const backTo = state.currentOtherUid;
  const name = backTo ? displayNameFor(backTo) : "";
  // silent, so closing doesn't announce itself or fight the tab swap.
  window.closeChat?.({ silent: true });
  switchScreen("home");
  showTab(ended ? "recap" : "events");
  // BEFORE land(), not after. The chip is a row at the top of the
  // column now, so it takes real height; adding it once focusEvent had
  // already scrolled the card into view would push the card back down
  // by exactly the chip. It used to float over the feed, where it cost
  // no height and could safely arrive late.
  if (backTo) {
    returnChip({
      text: name ? `Back to ${name}` : "Back to the chat",
      onTap: () => window.startChatWithUid?.(backTo)
    });
  }
  land();
  return true;
}

/* ---------------------------------------------------------------------
   Painting the feed without the blink
   ---------------------------------------------------------------------
   The feed re-renders on every hype, join, request and edit, and it
   used to do that by rewriting the whole list's innerHTML. Every card
   was thrown away and built again, which replayed the staggered entry
   animation on all of them — so tapping Hype made the card fade out
   and float back in half a second later. It read as the card
   disappearing, because on screen that is exactly what happened.

   Now the list is patched. Each card's markup is remembered, and a
   re-render only touches the cards whose markup actually changed.
   Hyping swaps one button; your scroll position, any description you
   had expanded, and every other card on screen stay untouched. It also
   means the optimistic paint and the echo from the server produce
   identical markup, so the second one writes nothing at all.
   ------------------------------------------------------------------- */

// list element id -> Map(event id -> the markup last written there)
const painted = new Map();

function paintedFor(listEl) {
  if (!painted.has(listEl.id)) painted.set(listEl.id, new Map());
  return painted.get(listEl.id);
}

function cardFromHTML(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html.trim();
  return holder.firstElementChild;
}

/**
 * Bring `listEl` in line with `cards` ([{ id, html }]) using as few DOM
 * writes as possible. The first paint is a single write and is allowed
 * to animate; after that only genuinely new cards animate.
 */
function syncList(listEl, cards, tailHTML, emptyHTML) {
  const seen = paintedFor(listEl);

  if (!cards.length) {
    listEl.classList.remove("stagger");
    listEl.innerHTML = emptyHTML;
    seen.clear();
    return;
  }

  // Nothing real on screen yet (empty state, or skeletons): one write,
  // and let the whole list rise in the way it always has.
  if (!seen.size || !listEl.querySelector(".event")) {
    seen.clear();
    listEl.classList.add("stagger");
    listEl.innerHTML = cards.map((c) => c.html).join("") + tailHTML;
    cards.forEach((c) => seen.set(c.id, c.html));
    return;
  }

  // A re-render. The stagger has already played and replaying it is
  // precisely the flicker we are here to remove.
  listEl.classList.remove("stagger");

  const wanted = new Set(cards.map((c) => c.id));
  const current = new Map();
  Array.from(listEl.children).forEach((el) => {
    const id = el.id && el.id.indexOf("event-") === 0 ? el.id.slice(6) : "";
    // Anything that is not a card we still want goes: dead cards, and
    // the "Load more" button, which is re-appended in its new place.
    if (!id || !wanted.has(id)) { el.remove(); if (id) seen.delete(id); return; }
    current.set(id, el);
  });

  let prev = null;
  cards.forEach((c) => {
    let el = current.get(c.id);

    if (el && seen.get(c.id) !== c.html) {
      const fresh = cardFromHTML(c.html);
      // Keep what the reader themselves opened on this card.
      if (fresh && el.classList.contains("expanded")) {
        fresh.classList.add("expanded");
        const btn = fresh.querySelector(".read-more-btn");
        if (btn) btn.innerText = "Hide details";
      }
      if (fresh) { el.replaceWith(fresh); el = fresh; }
    } else if (!el) {
      el = cardFromHTML(c.html);
      if (el) el.classList.add("card-in");   // genuinely new — this one may animate
    }
    if (!el) return;

    const slot = prev ? prev.nextElementSibling : listEl.firstElementChild;
    if (el !== slot) listEl.insertBefore(el, slot);
    prev = el;
    seen.set(c.id, c.html);
  });

  if (tailHTML) listEl.insertAdjacentHTML("beforeend", tailHTML);
}

/**
 * FILL IN EVERYTHING THAT DEPENDS ON THE CLOCK.
 *
 * This is the other half of the diff, and the reason the feed stopped
 * flashing once a minute.
 *
 * syncList replaces a card whenever its markup differs from what is on
 * screen. A card carries the time in it — "45M", "2H LEFT", "4h ago" —
 * so on every minute tick EVERY card's markup differed, every card was
 * swapped for a new node, and the whole feed visibly blinked. Nothing
 * was animating; it was sixty nodes being thrown away and rebuilt.
 *
 * So the markup no longer contains the time at all. Those spots are
 * empty `data-vt` slots, which makes a card's html independent of when
 * it was built — the diff then finds nothing to do on a quiet minute —
 * and this fills them from the cache straight afterwards, in the same
 * frame, as text writes. A tick that changes nothing else now touches
 * no nodes and creates none.
 *
 * It reads `state.eventCache` rather than taking data as an argument
 * so it can also be called on its own, without a render.
 */
export function paintVolatile(listEl, now = Date.now()) {
  if (!listEl) return;
  listEl.querySelectorAll(".event").forEach((card) => {
    const id = card.id.indexOf("event-") === 0 ? card.id.slice(6) : "";
    const e = id && state.eventCache[id];
    if (!e) return;

    const slots = card.querySelectorAll("[data-vt]");
    if (!slots.length) return;

    const stat = timeStat(e, now);
    slots.forEach((slot) => {
      const kind = slot.getAttribute("data-vt");
      let text = "";
      if (kind === "value") text = stat.value;
      else if (kind === "sub") text = stat.sub || "";
      else if (kind === "ago") text = relTime(e.expiresAt, now);
      else if (kind === "leaves") text = relTime(now + (recapUntil(e, state.uid) - now), now);
      else if (kind === "clock") {
        // Not text: how much of a LIVE event is still to run, as the
        // width of an ember line. Upcoming and ended events show none.
        const span = e.expiresAt - e.startTime;
        const left = now >= e.startTime && now < e.expiresAt && span > 0
          ? Math.max(0, Math.min(1, (e.expiresAt - now) / span)) : 0;
        const w = (left * 100).toFixed(1) + "%";
        if (slot.style.width !== w) slot.style.width = w;
        return;
      }
      // Only touch the DOM when it would actually change.
      if (slot.textContent !== text) slot.textContent = text;
    });
  });
}

/**
 * Show only the cards carrying `tag`. Pure class toggling: no markup is
 * built, no node is created or destroyed, so a pill tap lands in the
 * same frame instead of animating sixty cards back in.
 */
function applyFilter(listEl, tag) {
  if (!listEl) return;

  // Read the DOM first, write second. Querying after a run of class
  // changes makes the browser recompute style for the whole list.
  const note = listEl.querySelector(".filter-empty");

  let cards = 0;
  let shown = 0;
  Array.from(listEl.children).forEach((el) => {
    if (!el.classList.contains("event")) return;
    cards++;
    const match = tag === "All" || el.dataset.tag === tag;
    const hidden = el.classList.contains("filtered-out");
    if (hidden === match) el.classList.toggle("filtered-out", !match);
    if (match) shown++;
  });
  if (cards && !shown) {
    if (!note) {
      listEl.insertAdjacentHTML("beforeend",
        `<div class="empty-state filter-empty">${EMPTY_ART}<h4>Nothing under ${escapeHtml(tag)}</h4><p>Try another vibe, or tap All to see everything.</p></div>`);
    }
  } else if (note) {
    note.remove();
  }
}

/* ---------------------------------------------------------------------
   Feed
   ------------------------------------------------------------------- */
export function renderEvents() {
  const liveList = document.getElementById("events");
  const recapList = document.getElementById("recapEvents");
  if (!liveList || !recapList) return;

  // Fold anything that has finished into your receipt. This is free:
  // every event it looks at is already in the cache because the feed
  // or the recap paid for it, and countable() rejects anything
  // counted before, so the usual outcome is no work and no write.
  renderReceipt();
  harvestReceipt();

  const order = state.eventOrder || [];
  const now = Date.now();

  renderLiveRail(order, now);

  const liveCards = [];
  const recapCards = [];

  // Live ids come from the listener; recap ids are paged in separately.
  // An event that expired while the app was open appears in both, so
  // the Set keeps it from rendering twice.
  const seen = new Set();
  const allIds = order.concat(state.recapOrder || []);

  allIds.forEach((eventId) => {
    if (seen.has(eventId)) return;
    seen.add(eventId);

    const e = state.eventCache[eventId];
    if (!e) return;
    // Being deleted: off the screen already, whatever the server still says.
    if (deleting.has(eventId)) return;
    const id = safeId(eventId);
    if (!id) return;

    // Blocking is total: their events do not exist for you.
    if (isBlocked(e.hostUid)) return;

    const participants = e.participantUids || [];
    const attendees = participants.length || 1;
    // An ended event had started too, so `now >= startTime` alone put a
    // green Live chip and a live ring on every card in Recap.
    const ended = e.expiresAt <= now;
    const isLive = !ended && now >= e.startTime;
    const hasHyped = (e.hypedUids || []).includes(state.uid);
    const hypeCount = (e.hypedUids || []).length;
    const hasJoined = participants.includes(state.uid);
    const isHost = e.hostUid === state.uid;
    const isFull = e.maxCapacity && attendees >= e.maxCapacity;
    const vibe = vibeColor(e.tag);

    // Tapping the author opens their profile — the hub where you can
    // message, report or block. Without this there was no route to a
    // profile from the feed at all.
    const hostId = safeId(e.hostUid);
    const openHost = hostId ? `onclick="event.stopPropagation(); window.openProfileScreen('${hostId}')"` : "";

    // THE TRUST LINE. The question this app really asks is "should I
    // walk across campus for a stranger's thing?" — so the card answers
    // it. Both halves are computed from data already in memory: your
    // orbit, and the host's cached profile. No extra reads.
    let trust = "";
    if (e.hostUid !== state.uid) {
      if (inOrbit(e.hostUid)) {
        trust = `<span class="trust-chip in-orbit"><i class='bx bx-planet'></i> In your orbit</span>`;
      } else {
        const known = vouchersYouKnow(e.hostUid).length;
        if (known) {
          trust = `<span class="trust-chip"><i class='bx bxs-badge-check'></i> Vouched by ${known} you know</span>`;
        }
      }
    }

    // THE BYLINE. The host used to be the top line of the card, above
    // the title, which made a feed of events read as a feed of people.
    // The event is the headline now and the host is the credit under
    // it — smaller, on one line, still a tap away from their profile.
    const byline = `
      <div class="byline">
        <div class="av-ring ${isLive ? "live" : ""} tappable" ${openHost}>
          <div class="av-inner">${renderAvatar(avatarFor(e.hostUid))}</div>
        </div>
        <span class="byline-name tappable" ${openHost}>${escapeHtml(displayNameFor(e.hostUid))}</span>
        <span class="byline-meta">@${escapeHtml(usernameFor(e.hostUid))}</span>
        ${trust}
      </div>`;



    // The description is READ, not hidden behind a button: two lines of
    // it sit under the place, and "More" appears only when there is
    // more than two lines' worth. (Length is a guess at the clamp, and a
    // safe one: a false "More" expands to the same text.)
    const longDesc = e.description && (e.description.length > 90 || e.description.includes("\n"));
    const desc = e.description
      ? `<div class="event-desc-box">${escapeHtml(e.description)}</div>
         ${longDesc ? `<button class="read-more-btn" onclick="window.toggleEventDesc('${id}')">More</button>` : ""}`
      : "";

    const capacity = e.maxCapacity
      ? `<div class="cap-wrap">
           <div class="cap-head"><span>${attendees} of ${e.maxCapacity} spots</span><span>${isFull ? "Full" : `${e.maxCapacity - attendees} left`}</span></div>
           <div class="cap-track"><div class="cap-fill ${isFull ? "full" : ""}" style="width:${Math.min((attendees / e.maxCapacity) * 100, 100)}%"></div></div>
         </div>`
      : "";

    // THE FLAME IS DRAWN, not set in the icon font, because `bx-hot`
    // does not exist in Boxicons — only the solid `bxs-hot` does. So
    // the one person who had hyped saw a flame and everybody else saw
    // an empty space where it should have been. One path, filled when
    // it's yours and outlined when it isn't.
    const flame = `<svg class="hype-flame" viewBox="0 0 24 24" width="17" height="17"
      fill="${hasHyped ? "currentColor" : "none"}" stroke="currentColor"
      stroke-width="${hasHyped ? 0 : 1.7}" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22a6.5 6.5 0 0 0 6.5-6.5c0-2-1-3.8-2.9-5.3 0 0 .2 2.4-1.5 2.9.1-2.9-1.8-5.8-4.7-7.6.5 3.8-1.9 4.8-2.9 6.7a6.5 6.5 0 0 0-1 3.3A6.5 6.5 0 0 0 12 22Z"/>
    </svg>`;
    const hypeBtn = `<button class="act ${hasHyped ? "hyped" : ""}" aria-label="Hype" onclick="window.toggleHype('${id}')">${flame} ${hypeCount || "Hype"}</button>`;
    const chatBtn = `<button class="act" onclick="window.openEventChat('${id}')"><i class='bx bx-message-rounded-dots'></i> Chat</button>`;
    // DRAWN, not set in the icon font, for the same reason the flame is:
    // this button has no label, so an icon font that fails to load
    // leaves an invisible control. It sits at the far right of the row
    // on a phone, where an invisible control is worse still.
    const shareGlyph = `<svg class="act-glyph" viewBox="0 0 24 24" width="18" height="18"
      fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/>
      <path d="M8.35 10.75 15.65 7.1M8.35 13.25l7.3 3.65"/>
    </svg>`;
    const shareBtn = `<button class="act" aria-label="Share" onclick="window.openShare('${id}')">${shareGlyph}</button>`;

    const pending = e.pendingUids || [];
    const hasRequested = pending.includes(state.uid);
    const needsApproval = e.requiresApproval === true;

    const unconfirmed = e.unconfirmedUids || [];
    const iMustConfirm = unconfirmed.includes(state.uid);

    // The stack and the names show only people who have agreed to the
    // CURRENT plan. Anyone still to re-confirm is counted separately
    // rather than silently vouching for a plan they never saw.
    const confirmedGoing = participants.filter((u) => !unconfirmed.includes(u));

    let primary;
    if (isHost) {
      primary = pending.length
        ? `<button class="act primary" onclick="window.openPeople('${id}')"><i class='bx bx-user-plus'></i> ${pending.length} request${pending.length > 1 ? "s" : ""}</button>`
        : `<button class="act joined" onclick="window.openDeleteModal('${id}')"><i class='bx bx-slider-alt'></i> Manage</button>`;
    } else if (hasJoined) {
      primary = `<button class="act joined" onclick="window.leaveEvent('${id}')"><i class='bx bx-check'></i> Going</button>`;
    } else if (hasRequested) {
      primary = `<button class="act requested" onclick="window.cancelRequest('${id}')"><i class='bx bx-time-five'></i> Requested</button>`;
    } else if (isFull) {
      primary = `<button class="act full" disabled>Full</button>`;
    } else if (needsApproval) {
      primary = `<button class="act primary" onclick="window.requestJoin('${id}')"><i class='bx bx-user-plus'></i> Request</button>`;
    } else {
      primary = `<button class="act primary" onclick="window.joinEvent('${id}')">Join</button>`;
    }

    // No spacer div between the secondary actions and the primary one.
    // A spacer is a flex ITEM, so the moment the row is allowed to wrap
    // it claims a whole line to itself; an auto margin on the primary
    // does the same job on one line and simply stops mattering on two.
    // See .card-actions in style.css for why the row wraps at all.
    const actions = `
      <div class="card-actions">
        ${hypeBtn}
        ${(isHost || hasJoined) ? chatBtn : ""}
        ${shareBtn}
        ${primary}
      </div>`;

    const body = `
      <div class="card-body">
      <div class="event-title">${escapeHtml(e.title)}</div>
      <div class="event-place"><i class='bx bx-map-pin'></i><span>${escapeHtml(e.place)}</span></div>
      ${desc}
      ${byline}
      ${needsApproval && !isHost && !hasJoined ? `<div class="approval-note"><i class='bx bx-lock-alt'></i> The host approves who joins</div>` : ""}
      ${iMustConfirm ? `
        <div class="changed-note">
          <div class="changed-text">
            <i class='bx bx-error-circle'></i>
            <span><b>${escapeHtml(displayNameFor(e.hostUid))}</b> changed this — it ${escapeHtml(e.lastEditSummary || "has moved")}.</span>
          </div>
          <div class="changed-actions">
            <button class="act" onclick="window.leaveEvent('${id}')">Can't make it</button>
            <button class="act primary" onclick="window.confirmAttendance('${id}')">Still in</button>
          </div>
        </div>` : ""}
      <div class="going-row">
        ${avatarStack(withoutBlocked(confirmedGoing.filter((u) => u !== e.hostUid)))}
        <span class="going-text">${goingText(withoutBlocked(confirmedGoing.filter((u) => u !== e.hostUid)), unconfirmed.length, isHost)}</span>
      </div>
      ${capacity}
      </div>`;

    // Every card is built, whatever the active filter — applyFilter()
    // below decides what is on screen, and can change its mind for free.
    const tagAttr = ` data-tag="${escapeHtml(e.tag || "")}"`;

    if (e.expiresAt > now) {
      // The band carries the vibe colour, the glyph and the time, so
      // the old leading edge, corner watermark and top wash have all
      // gone with it — three paints per card saved, and a composition
      // instead of a stack of rows.
      // Second stat: is anybody going. "Be first" rather than a bare 0,
      // because 0 reads as a dead event and the whole point of the app
      // is that somebody has to start.
      const goingCount = withoutBlocked(confirmedGoing).length;
      const goingStat = goingCount
        ? { label: goingCount === 1 ? "going" : "going",
            value: String(goingCount),
            sub: isFull ? "full" : e.maxCapacity ? (e.maxCapacity - attendees) + " left" : "" }
        : { label: "going", value: "\u2014", sub: "be first" };

      liveCards.push({ id, html: `
        <article class="event card poster-card ${isLive ? "is-live" : ""}" id="event-${id}"${tagAttr} style="--vibe:${vibe}">
          ${posterBand(e, now, { stats: [timeStat(e, now), goingStat] })}
          ${body}${actions}
        </article>` });
    } else if (inRecap(e, now, state.uid)) {
      // What it earned, said plainly — see recapRules.js for the sums.
      const guests = participants.filter((u) => u !== e.hostUid);
      const shownGuests = withoutBlocked(guests);
      let wentText;
      if (wasCalledOff(e)) wentText = "Called off before it started";
      else if (!shownGuests.length) wentText = "Nobody else made it";
      else wentText = `${shownGuests.length} ${shownGuests.length === 1 ? "person" : "people"} went`;

      // Only warn once it is close; a countdown on every card is noise.
      const left = recapUntil(e, state.uid) - now;
      const fading = left < 2 * 60 * 60 * 1000;
      // `fading` itself is a state change worth replacing the card for;
      // the countdown inside it is not.
      const leaves = fading
        ? `<div class="recap-leaves"><i class='bx bx-time-five'></i> Leaves recap <span data-vt="leaves"></span></div>`
        : "";

      // A RECAP CARD IS A TICKET STUB. The band is the same one, drained
      // of its colour because this already happened, and the stat is no
      // longer when it starts — it is how many turned up, which is the
      // only number that matters once it is over. Notches are punched
      // into the sides on the tear line, so a finished event reads as
      // something torn off and kept rather than a live card with the
      // lights out.
      const turnout = wasCalledOff(e)
        ? { label: "Called off", value: "\u2014", sub: "before it started" }
        : { label: shownGuests.length === 1 ? "person went" : "people went",
            value: String(shownGuests.length),
            sub: hypeCount ? hypeCount + " hyped" : "" };

      recapCards.push({ id, html: `
        <article class="event card poster-card stub${fading ? " fading" : ""}" id="event-${id}"${tagAttr} style="--vibe:${vibe}">
          ${posterBand(e, now, { stats: [turnout], spent: true })}
          <div class="card-body">
            <div class="event-title">${escapeHtml(e.title)}</div>
            <div class="event-place"><i class='bx bx-map-pin'></i><span>${escapeHtml(e.place)}</span></div>
            <div class="byline">
              <div class="av-ring tappable" ${openHost}>
                <div class="av-inner">${renderAvatar(avatarFor(e.hostUid))}</div>
              </div>
              <span class="byline-name tappable" ${openHost}>${escapeHtml(displayNameFor(e.hostUid))}</span>
              <span class="byline-meta" data-vt="ago"></span>
            </div>
            ${shownGuests.length ? `<div class="going-row">${avatarStack(shownGuests)}<span class="going-text">${escapeHtml(wentText)}</span></div>` : ""}
            ${leaves}
          </div>
        </article>` });
    }
  });

  syncList(
    liveList,
    liveCards,
    "",
    `<div class="empty-state first-run">
       <!-- The firefly: the brand mark greets an empty feed. An image of
            our own SVG, never an icon font, so a font that fails to load
            cannot leave a blank in the first thing anybody sees. -->
       <img class="fr-spark fr-logo" src="/logo.svg" alt="" width="58" height="58">
       <h4>Someone has to go first</h4>
       <p>Nothing is on right now. Start something and everyone nearby sees it the second you publish.</p>
       <div class="starter-grid">
         ${STARTERS.map((s, i) => {
           const glyph = escapeHtml(s.tag.trim().split(" ")[0]);
           return `
           <button class="starter" style="--vibe:${s.vibe}" onclick="window.startSomething(${i})">
             <span class="starter-wm">${glyph}</span>
             <span class="starter-glyph">${glyph}</span>
             <span class="starter-body">
               <span class="starter-label">${escapeHtml(s.label)}</span>
               <span class="starter-sub">${escapeHtml(s.sub)}</span>
             </span>
             <svg class="starter-go" viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
               <path d="M5 12h13M12.5 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
             </svg>
           </button>`;
         }).join("")}
         <button class="starter starter-blank" onclick="window.openCreateScreen()">
           <span class="starter-glyph">
             <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
               <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
             </svg>
           </span>
           <span class="starter-body">
             <span class="starter-label">Start from scratch</span>
             <span class="starter-sub">Anything else you've got</span>
           </span>
           <svg class="starter-go" viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
             <path d="M5 12h13M12.5 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
           </svg>
         </button>
       </div>
     </div>`
  );
  syncList(
    recapList,
    recapCards,
    state.recapDone ? "" : `<button class="btn-ghost" style="margin-top:8px;" onclick="window.loadRecap()">Load more</button>`,
    state.recapLoading
      ? skeletonFeed(2)
      : `<div class="empty-state">${EMPTY_ART}<h4>Nothing here yet</h4><p>Nothing has wrapped up recently. Busy events stay here for up to two days, quiet ones for a few hours.</p></div>`
  );

  // Straight after the diff and before the browser paints, so a card
  // is never on screen with an empty time slot.
  paintVolatile(liveList, now);
  paintVolatile(recapList, now);

  applyFilter(liveList, state.currentLiveFilter);
  applyFilter(recapList, state.currentRecapFilter);

  updateRail(order, now);

  // If the host is looking at the requests sheet, keep it current —
  // someone may have cancelled while it was open.
  if (state.eventIdToManage && !document.getElementById("peopleModal")?.classList.contains("hidden")) {
    renderPeople();
  }
}

// ---------- Membership ----------
export function joinEvent(id) {
  const e = state.eventCache[id];
  if (e && e.maxCapacity && (e.participantUids || []).length >= e.maxCapacity) {
    return toast("This event is already full.");
  }
  db.collection("events").doc(id)
    .update({ participantUids: FieldValue.arrayUnion(state.uid) })
    .catch((err) => {
      console.error("Join failed:", err.code || err.message);
      // Silence here meant a tap that did nothing and said nothing —
      // the commonest real cause is the last spot going while you read.
      toast(err.code === "permission-denied"
        ? "Couldn't join — it may have filled up or ended."
        : "Couldn't join. Check your connection.");
    });
}

export function requestJoin(id) {
  db.collection("events").doc(id)
    .update({ pendingUids: FieldValue.arrayUnion(state.uid) })
    .catch((err) => {
      console.error("Request failed:", err.code || err.message);
      toast("Couldn't send the request. Try again.");
    });
}

export function cancelRequest(id) {
  db.collection("events").doc(id)
    .update({ pendingUids: FieldValue.arrayRemove(state.uid) })
    .catch((err) => {
      console.error("Cancel failed:", err.code || err.message);
      toast("Couldn't cancel that. Try again.");
    });
}

/* ---------------------------------------------------------------------
   Host: working through the requests
   ------------------------------------------------------------------- */

export function openPeople(eventId) {
  const opts = { onClose: () => { state.eventIdToManage = null; } };

  // Reached either from the Manage sheet (swap in place) or straight
  // from the card's "N requests" button (fresh layer).
  if (isOverlayTop("deleteModal")) replaceOverlay("peopleModal", opts);
  else openOverlay("peopleModal", opts);

  // After the swap — the Manage sheet's onClose clears this on its way out.
  state.eventIdToManage = eventId;
  renderPeople();
}

export function closePeople() {
  closeOverlay("peopleModal");
}

/** One sheet, two jobs: who's waiting, and who's in. */
export async function renderPeople() {
  const box = document.getElementById("peopleList");
  const id = state.eventIdToManage;
  if (!box || !id) return;

  const e = state.eventCache[id];
  if (!e) return;

  const pending = e.pendingUids || [];
  const going = (e.participantUids || []).filter((u) => u !== e.hostUid);
  const unconfirmed = e.unconfirmedUids || [];

  await primeUsers([...pending, ...going]);

  const row = (uid, actions) => {
    const u = safeId(uid);
    if (!u) return "";
    return `
      <div class="request-row">
        <div class="chat-avatar" style="width:40px;height:40px;font-size:18px;">${renderAvatar(avatarFor(uid))}</div>
        <div class="result-text">
          <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
          <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
        </div>
        <div class="request-actions">${actions(u)}</div>
      </div>`;
  };

  let html = "";

  if (pending.length) {
    html += `<div class="result-group">Waiting for you (${pending.length})</div>`;
    html += pending.map((uid) => row(uid, (u) => `
      <button class="btn-ghost" onclick="window.declineRequest('${u}')" aria-label="Decline"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
      <button onclick="window.approveRequest('${u}')" aria-label="Approve"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>`)).join("");
  }

  html += `<div class="result-group">Going (${going.length + 1})</div>`;
  html += `
    <div class="request-row">
      <div class="chat-avatar" style="width:40px;height:40px;font-size:18px;">${renderAvatar(avatarFor(e.hostUid))}</div>
      <div class="result-text">
        <div class="result-title">${escapeHtml(displayNameFor(e.hostUid))}</div>
        <div class="result-sub">Host</div>
      </div>
    </div>`;

  if (going.length) {
    html += going.map((uid) => {
      const markup = row(uid, (u) => `
        <button class="btn-ghost danger-text" onclick="window.removeAttendee('${u}')" aria-label="Remove"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.6"/><path d="M2.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6M16 11h6"/></svg></button>`);
      return unconfirmed.includes(uid)
        ? markup.replace("</div>\n      </div>", `</div>\n        <span class="unconfirmed-tag">not confirmed</span>\n      </div>`)
        : markup;
    }).join("");
  } else if (!pending.length) {
    html += `<p class="settings-hint" style="margin-top:8px;">Nobody else yet.</p>`;
  }

  box.innerHTML = html;
}

/** Approve: move them from pending to going, in ONE atomic write. */
export function approveRequest(uid) {
  const id = state.eventIdToManage;
  if (!id) return;

  const e = state.eventCache[id];
  if (e && e.maxCapacity && (e.participantUids || []).length >= e.maxCapacity) {
    return toast("This event is already full. Remove someone first, or raise the capacity.");
  }

  db.collection("events").doc(id).update({
    participantUids: FieldValue.arrayUnion(uid),
    pendingUids: FieldValue.arrayRemove(uid)
  }).then(renderPeople)
    .catch((err) => {
      console.error("Approve failed:", err.code || err.message);
      toast("Couldn't approve right now.");
    });
}

export function declineRequest(uid) {
  const id = state.eventIdToManage;
  if (!id) return;
  db.collection("events").doc(id)
    .update({ pendingUids: FieldValue.arrayRemove(uid) })
    .then(renderPeople)
    .catch((err) => {
      console.error("Decline failed:", err.code || err.message);
      toast("Couldn't decline that right now.");
    });
}

export function leaveEvent(id) {
  db.collection("events").doc(id)
    .update({
      participantUids: FieldValue.arrayRemove(state.uid),
      unconfirmedUids: FieldValue.arrayRemove(state.uid)
    })
    .catch((err) => {
      console.error("Leave failed:", err.code || err.message);
      toast("Couldn't leave right now. Try again.");
    });
}

/** "Still in" — clears your unconfirmed flag after a host's change. */
export function confirmAttendance(id) {
  db.collection("events").doc(id)
    .update({ unconfirmedUids: FieldValue.arrayRemove(state.uid) })
    .catch((err) => {
      console.error("Confirm failed:", err.code || err.message);
      toast("Couldn't confirm right now. Try again.");
    });
}

/* ---------------------------------------------------------------------
   Hype, settled before it is sent
   ---------------------------------------------------------------------
   A hype is membership in a set: you can hype an event once, so there
   is nothing to accumulate. The only way to make it expensive is to
   turn it on and off repeatedly — and the people who do that are
   somebody poking at the button and somebody who tapped it by mistake.

   A cooldown would punish exactly the second person. Tap by accident,
   tap again to undo, and now you are locked out of your own correction
   with the wrong state saved. So the write waits instead. The feed
   moves the instant you tap, and the write goes about a second later —
   and if by then you are back where you started, nothing is sent at
   all. A misclick costs nothing, and a burst of taps costs one write
   instead of six.

   Each write also fans out to everyone with the feed open, so one
   write saved here is one read saved for every person watching.
   ------------------------------------------------------------------- */

const HYPE_SETTLE_MS = 900;

// eventId -> { started, desired, timer }. `started` is where this burst
// of taps began, which is what decides whether anything needs saying.
const pendingHype = new Map();

function hypedNow(e) {
  return !!e && (e.hypedUids || []).includes(state.uid);
}

/** Put the local view of a hype into `want`, without touching anything else. */
function setHypedLocally(e, want) {
  if (!e) return;
  const others = (e.hypedUids || []).filter((u) => u !== state.uid);
  e.hypedUids = want ? others.concat([state.uid]) : others;
}

/**
 * A snapshot arriving mid-burst carries the server's idea of the hype,
 * which is still the old one. Without this the button would flip back
 * under the finger every time somebody else touched the same event.
 */
export function applyPendingHype(data) {
  const p = pendingHype.get(data.id);
  if (p) setHypedLocally(data, p.desired);
  return data;
}

export function toggleHype(id) {
  const e = state.eventCache[id];
  if (!e) return;

  const before = hypedNow(e);
  const desired = !before;

  setHypedLocally(e, desired);

  if (desired) {
    if (navigator.vibrate) navigator.vibrate(45);
    burstFrom(document.querySelector(`#event-${safeId(id)} .act`));
  }

  const open = pendingHype.get(id);
  if (open) clearTimeout(open.timer);
  pendingHype.set(id, {
    started: open ? open.started : before,
    desired,
    timer: setTimeout(() => flushHype(id), HYPE_SETTLE_MS)
  });

  renderEvents();
}

function flushHype(id) {
  const p = pendingHype.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingHype.delete(id);

  // Back where the burst began: the server already agrees.
  if (p.desired === p.started) return;

  db.collection("events").doc(id).update({
    hypedUids: p.desired
      ? FieldValue.arrayUnion(state.uid)
      : FieldValue.arrayRemove(state.uid)
  }).catch((err) => {
    console.error("Hype failed:", err.code || err.message);
    setHypedLocally(state.eventCache[id], p.started);
    renderEvents();
  });
}

/**
 * Send anything still waiting. Called when the app is hidden or closed,
 * so a hype is never lost to somebody tapping and immediately locking
 * their phone.
 */
export function flushAllHype() {
  [...pendingHype.keys()].forEach(flushHype);
}

/**
 * Throw a few coloured dots out of an element. Purely an
 * acknowledgement — it confirms the tap landed before the round trip
 * to Firestore comes back.
 */
function burstFrom(el) {
  if (!el || !el.getBoundingClientRect) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const r = el.getBoundingClientRect();
  const colors = ["var(--vibe-party)", "var(--vibe-food)", "var(--forest)", "var(--sage)", "var(--vibe-sports)"];

  for (let i = 0; i < 7; i++) {
    const dot = document.createElement("span");
    dot.className = "burst";
    const angle = (Math.PI * 2 * i) / 7 + Math.random() * 0.5;
    const dist = 26 + Math.random() * 22;
    dot.style.cssText = `left:${r.left + r.width / 2}px; top:${r.top + r.height / 2}px;` +
      `position:fixed; background:${colors[i % colors.length]};` +
      `--bx:${Math.cos(angle) * dist}px; --by:${Math.sin(angle) * dist - 12}px;`;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }
}

// ---------- Host controls ----------
export function openDeleteModal(id) {
  state.eventIdToManage = id;
  openOverlay("deleteModal", { onClose: () => { state.eventIdToManage = null; } });
}

export function closeDeleteModal() {
  closeOverlay("deleteModal");
}

function fadeOutCard(id, remove) {
  const card = document.getElementById(`event-${id}`);
  if (!card) return;
  card.style.transition = "all 0.3s ease";
  card.style.opacity = "0";
  card.style.transform = "scale(0.9)";
  setTimeout(() => (remove ? card.remove() : card.classList.add("hidden")), 300);
}

/**
 * End an event now.
 *
 * This used to fade the card out FIRST and then fire the write without
 * looking at what came back. For an event that had not started yet the
 * rules refused it — the edit branch insists expiresAt > startTime —
 * so the host watched their event disappear while it stayed live for
 * everybody else. There is a rule branch for ending now; the card is
 * not touched until the write has actually landed.
 */
export async function confirmMoveToRecap() {
  const id = state.eventIdToManage;
  if (!id) return;
  closeDeleteModal();

  const endedAt = Date.now() - 1;
  try {
    await db.collection("events").doc(id).update({ expiresAt: endedAt });

    // The feed listener only watches what has not expired, so this
    // event is about to LEAVE it rather than arrive changed — nothing
    // is coming to tell us. Move it across ourselves.
    const e = state.eventCache[id];
    if (e) e.expiresAt = endedAt;
    if (!(state.recapOrder || []).includes(id)) {
      state.recapOrder = (state.recapOrder || []).concat(id);
    }
    fadeOutCard(id, false);
    setTimeout(renderEvents, 320);
    toast(e && endedAt < (e.startTime || 0) ? "Called off. It's in your Recap." : "Ended. It's in Recap now.");
  } catch (err) {
    console.error("Recap move failed:", err.code || err.message);
    toast("Couldn't end it. Try again.");
  }
}

/* ---------------------------------------------------------------------
   Deleting an event, and everything under it
   ---------------------------------------------------------------------
   Firestore does not cascade. Deleting the event document on its own
   left its messages, its typing flags and its pinned message behind —
   and left them UNREACHABLE, because every rule under events/{id}
   authorises itself by reading the parent. With the parent gone that
   get() finds nothing, so nobody can read those documents and nobody
   can delete them either. They sit in the database for good, and one
   busy event chat is a few hundred of them.

   So the children go first, while the parent is still there to
   authorise it, and the event document goes last.

   A batch is ONE request, and a rule get() to the same path is cached
   within a request — so a hundred message deletes cost one document
   access, not a hundred. If a page is refused anyway, that page falls
   back to one delete at a time rather than giving up and orphaning
   everything behind it.
   ------------------------------------------------------------------- */

const PURGE_PAGE = 100;
const PURGE_MAX_PAGES = 30;

async function purgeCollection(ref) {
  for (let page = 0; page < PURGE_MAX_PAGES; page++) {
    const snap = await ref.limit(PURGE_PAGE).get();
    if (snap.empty) return true;

    try {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    } catch (e) {
      // One at a time: each is its own request with its own budget.
      for (const d of snap.docs) await d.ref.delete().catch(() => {});
    }

    if (snap.size < PURGE_PAGE) return true;
  }
  return false;   // more left than we are willing to walk in one go
}

/* Events being deleted right now.
   The card has to leave the screen at once — a host who has just
   confirmed a deletion should not watch it sit there — but the
   document is still on the server for as long as the purge takes, so
   the live listener would keep handing it back. Same idea as
   pendingHype: the feed knows about something the database does not
   agree with yet, and says so until it catches up. */
const deleting = new Set();

export async function confirmDeletePermanently() {
  const id = state.eventIdToManage;
  if (!id) return;
  closeDeleteModal();

  /* GONE NOW; THE NETWORK CATCHES UP BEHIND IT.
     This used to purge three subcollections and delete the document —
     four round trips, in series — before touching the screen. On a
     good connection that is a second of a card sitting there after you
     confirmed; on campus wifi it is several, and it reads as the app
     having ignored you. Nothing about the outcome is in doubt: it is
     the host's own event and the rules have already agreed. */
  const snapshot = state.eventCache[id];
  const wasLive = (state.eventOrder || []).includes(id);
  const wasRecap = (state.recapOrder || []).includes(id);

  deleting.add(id);
  delete state.eventCache[id];
  state.eventOrder = (state.eventOrder || []).filter((x) => x !== id);
  state.recapOrder = (state.recapOrder || []).filter((x) => x !== id);
  fadeOutCard(id, true);
  toast("Deleted.");

  const eventRef = db.collection("events").doc(id);
  try {
    // Children first — the parent is what authorises removing them —
    // but all three at once, because they have nothing to say to
    // each other.
    await Promise.all([
      purgeCollection(eventRef.collection("messages")),
      purgeCollection(eventRef.collection("typing")),
      purgeCollection(eventRef.collection("pinned"))
    ]);
    await eventRef.delete();
    deleting.delete(id);
  } catch (error) {
    console.error("Delete failed:", error.code, error.message);
    deleting.delete(id);
    // Put it back rather than leave a host thinking it is gone.
    if (snapshot) state.eventCache[id] = snapshot;
    if (wasLive && !(state.eventOrder || []).includes(id)) state.eventOrder = [id].concat(state.eventOrder || []);
    if (wasRecap && !(state.recapOrder || []).includes(id)) state.recapOrder = (state.recapOrder || []).concat(id);
    toast(
      error.code === "permission-denied"
        ? "You don't have permission to delete this event."
        : "Couldn't delete that — it's still there. Check your connection."
    );
    renderEvents();
  }
}


/**
 * Right-rail stats. Derived from the same cache the feed renders from,
 * so they can never drift from what the user is looking at.
 */
function updateRail(order, now) {
  const liveEl = document.getElementById("railLiveCount");
  const peopleEl = document.getElementById("railPeopleCount");
  if (!liveEl && !peopleEl) return;

  let live = 0;
  const people = new Set();

  order.forEach((id) => {
    const e = state.eventCache[id];
    if (!e) return;
    if (e.expiresAt > now) live++;
    if (e.expiresAt > now - DAY_MS) (e.participantUids || []).forEach((u) => people.add(u));
  });

  countTo(liveEl, live);
  countTo(peopleEl, people.size);
}


/** Animate a stat to its new value so a change is noticed, not missed. */
function countTo(el, target) {
  if (!el) return;
  const from = parseInt(el.dataset.value || "0", 10);
  if (from === target) { el.innerText = target; return; }
  el.dataset.value = target;

  const steps = Math.min(Math.abs(target - from), 18);
  if (steps === 0) { el.innerText = target; return; }
  let i = 0;
  const tick = () => {
    i++;
    el.innerText = Math.round(from + ((target - from) * i) / steps);
    if (i < steps) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}


/**
 * Which edits change what someone actually agreed to.
 *
 * Fixing a typo or adding a note is not a new plan. Moving the time,
 * the place or the vibe is — and "going" must stop speaking for anyone
 * who agreed to the old one, because that list is what the rest of the
 * feed reads.
 */
function materialDiff(before, after) {
  const changes = [];
  const when = (ms) => clockTime(ms);

  if (before.place !== after.place) changes.push(`moved to ${after.place}`);
  if (before.startTime !== after.startTime) changes.push(`now starts ${when(after.startTime)}`);
  if (before.expiresAt !== after.expiresAt && before.startTime === after.startTime) {
    changes.push(`now ends ${when(after.expiresAt)}`);
  }
  if (before.tag !== after.tag) changes.push(`is now ${String(after.tag).trim()}`);
  if (before.title !== after.title) changes.push(`is now "${after.title}"`);

  return changes;
}

/** Save edits to an existing event, keeping its chat and guest list. */
async function saveEventEdits(e) {
  const eventId = state.editingEventId;
  const existing = state.eventCache[eventId];
  if (!eventId || !existing) return;

  const btn = e?.target?.closest("button") || document.getElementById("createSubmit");
  const title = document.getElementById("title")?.value.trim();
  const place = document.getElementById("place")?.value.trim();
  const description = document.getElementById("description")?.value.trim() || "";
  const startTime = new Date(document.getElementById("startTime")?.value).getTime();
  const expiresAt = new Date(document.getElementById("endTime")?.value).getTime();
  const capacityRaw = document.getElementById("maxCapacity")?.value;
  const maxCapacity = capacityRaw ? parseInt(capacityRaw, 10) : null;

  if (!title || !place) return toast("Title and location can't be empty.");
  if (!Number.isFinite(startTime) || !Number.isFinite(expiresAt)) return toast("Those dates don't look right.");
  if (expiresAt <= startTime) return toast("The end time must be after the start time.");
  if (expiresAt - startTime > MAX_RUN_MS) return toast("Events can run for at most a week.");
  if (startTime - Date.now() > MAX_AHEAD_MS) return toast("That's too far ahead — three months at most.");

  const going = (existing.participantUids || []).length;
  if (maxCapacity !== null && maxCapacity < going) {
    return toast(`${going} people are already going — capacity can't be lower than that.`);
  }

  const next = {
    title: title.slice(0, 80),
    place: place.slice(0, 80),
    description: description.slice(0, 500),
    tag: state.currentSelectedTag,
    startTime,
    expiresAt,
    maxCapacity: Number.isFinite(maxCapacity) && maxCapacity > 1 ? maxCapacity : null,
    requiresApproval: !!document.getElementById("requiresApproval")?.checked,
    updatedAt: Date.now(),
    // Moving the end moves when it may be swept, and the rule checks
    // the two agree — so this is not optional on an edit.
    ttlAt: ttlFor(expiresAt)
  };

  const changes = materialDiff(existing, next);
  const others = (existing.participantUids || []).filter((u) => u !== existing.hostUid);

  if (changes.length && others.length) {
    const summary = changes.join(", ");
    const ok = await askConfirm({
      title: "This " + summary,
      body: others.length + (others.length === 1 ? " person has" : " people have")
        + " already said they're going. They'll be asked to confirm they're still in, and will show as unconfirmed until they do.",
      confirm: "Save the change"
    });
    if (!ok) return;

    next.unconfirmedUids = others;
    next.lastEditSummary = summary.slice(0, 140);
  }

  if (btn) { btn.disabled = true; btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i>`; }

  try {
    await db.collection("events").doc(eventId).update(next);
    closeCreateScreen();
    setTimeout(() => focusEvent(eventId), 300);
  } catch (error) {
    console.error("Edit failed:", error.code || error.message);
    toast("Couldn't save those changes. Try again.");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "Save"; }
  }
}

/** Host removes someone already going. */
export async function removeAttendee(uid) {
  const id = state.eventIdToManage;
  if (!id || !safeId(uid)) return;
  if (uid === state.uid) return;

  const name = displayNameFor(uid);
  const ok = await askConfirm({
    title: "Remove " + name + "?",
    body: "They can ask to join again.",
    confirm: "Remove",
    danger: true
  });
  if (!ok) return;

  db.collection("events").doc(id)
    .update({
      participantUids: FieldValue.arrayRemove(uid),
      unconfirmedUids: FieldValue.arrayRemove(uid)
    })
    .then(renderPeople)
    .catch((err) => {
      console.error("Remove failed:", err.code || err.message);
      toast("Couldn't remove them right now.");
    });
}


/* ---------------------------------------------------------------------
   RECAP — paged in, never preloaded
   ------------------------------------------------------------------- */

/**
 * Finished events, a page at a time. A plain get(), not a listener:
 * these have already happened, so watching them would bill reads for
 * nothing.
 *
 * The query asks for everything that ended inside the LONGEST window
 * anything can earn (48h), newest ending first, and recapRules decides
 * per event whether it is still in. Firestore can't filter on a value
 * worked out from three fields, and storing one would need somebody to
 * write it when the event ends — there is no server to do that.
 *
 * So a page can come back with nothing left in it: a run of quiet
 * events from yesterday. Rather than show an empty page and a Load
 * more button, it keeps going — but at most three pages per call, so a
 * dead stretch costs 36 reads, not the whole two days.
 */
const RECAP_PAGES_PER_CALL = 3;

export async function loadRecap({ reset = false } = {}) {
  if (state.recapLoading) return;
  if (reset) {
    state.recapOrder = [];
    state.recapCursor = null;
    state.recapDone = false;
  }
  if (state.recapDone) return;

  state.recapLoading = true;
  const list = document.getElementById("recapEvents");
  if (list && !state.recapOrder.length) list.innerHTML = skeletonFeed(2);

  try {
    const uids = new Set();
    let added = 0;

    for (let pages = 0; pages < RECAP_PAGES_PER_CALL && !added && !state.recapDone; pages++) {
      const now = Date.now();
      let q = db.collection("events");
      // Recap is the same feed, afterwards — so the same scope.
      if (feedIsScoped()) q = q.where("circleId", "==", myCircleId());
      q = q
        .where("expiresAt", "<=", now)
        .where("expiresAt", ">", now - RECAP_MAX_MS)
        .orderBy("expiresAt", "desc")
        .limit(RECAP_PAGE);

      if (state.recapCursor) q = q.startAfter(state.recapCursor);

      const snap = await q.get();

      if (snap.size < RECAP_PAGE) state.recapDone = true;
      if (snap.size) state.recapCursor = snap.docs[snap.docs.length - 1];

      snap.forEach((doc) => {
        const data = { id: doc.id, ...doc.data() };
        state.eventCache[doc.id] = data;
        if (!inRecap(data, now, state.uid) || isBlocked(data.hostUid)) return;
        if (state.recapOrder.includes(doc.id)) return;
        state.recapOrder.push(doc.id);
        added++;
        if (data.hostUid) uids.add(data.hostUid);
        (data.participantUids || []).forEach((u) => uids.add(u));
      });
    }

    await primeUsers([...uids]);
  } catch (e) {
    console.error("Recap load failed:", e.code || e.message);
    if (isMissingIndex(e)) {
      console.error(
        "Recap uses the same index as the feed: collection `events`, " +
        "circleId ascending + expiresAt descending."
      );
    }
  } finally {
    state.recapLoading = false;
    // After the flag drops, so the empty state is the real one and not
    // a skeleton left behind.
    renderEvents();
  }
}

/** Called when the Recap tab is opened, and as it is scrolled. */
export function ensureRecapLoaded() {
  // The receipt card lives in this tab and nowhere else, so this is
  // the moment its one read is worth paying for — and the moment it
  // has to happen, because nothing else will trigger it for somebody
  // who has no new events to fold. See primeReceipt().
  primeReceipt();
  if (!state.recapOrder.length && !state.recapDone) loadRecap({ reset: true });
}

export function onRecapScroll(el) {
  if (!el) return;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 320) loadRecap();
}
