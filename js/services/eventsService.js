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

import { auth, db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar, escapeHtml, safeId } from '../utils/formatters.js';
import { showTab, toast } from '../utils/ui.js';
import { openOverlay, closeOverlay, replaceOverlay, isOverlayTop } from '../utils/overlays.js';
import { primeUsers, displayNameFor, usernameFor, avatarFor } from './userService.js';
import { isBlocked, withoutBlocked } from './blockService.js';
import { stampEvent, readLimits, limitMessage } from './limitsService.js';
import { askConfirm } from '../utils/confirm.js';
import { inOrbit, vouchersYouKnow } from './orbitService.js';
import { RECAP_MAX_MS, inRecap, recapUntil, wasCalledOff } from './recapRules.js';
import { harvestReceipt, renderReceipt } from './receiptService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  if (btn) btn.innerText = card.classList.contains("expanded") ? "Hide details" : "Read details...";
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
  if (expiresAt - startTime > 7 * DAY_MS) return toast("Events can run for at most a week.");

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
      createdAt: Date.now()
    });
    await batch.commit();

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
    // A rules rejection arrives as a flat permission-denied, so the
    // only honest guess at the reason is the limit we just checked.
    toast(error.code === "permission-denied"
      ? limitMessage("event")
      : "Failed to publish. Try again.");
  } finally {
    restore();
  }
}

// ---------- Feed ----------
export function loadEvents() {
  if (state.eventsUnsubscribe) state.eventsUnsubscribe();

  // Show the shape of what's loading rather than an empty column.
  const liveList = document.getElementById("events");
  if (liveList && !liveList.children.length) liveList.innerHTML = skeletonFeed(3);

  state.eventsUnsubscribe = db
    .collection("events")
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

        // Happening now first, most recently started at the top of those;
        // then what starts soonest. This used to be a plain descending
        // sort on startTime, which put the event furthest in the FUTURE
        // at the top of a feed called Live Now, and buried the thing
        // starting in ten minutes at the bottom.
        const clock = Date.now();
        const live = (x) => (x.startTime || 0) <= clock;
        state.eventOrder = events
          .sort((a, b) => {
            if (live(a) !== live(b)) return live(a) ? -1 : 1;
            return live(a)
              ? (b.startTime || 0) - (a.startTime || 0)
              : (a.startTime || 0) - (b.startTime || 0);
          })
          .map((x) => x.id);

        renderEvents();
      },
      (error) => {
        console.error("Feed error:", error.code || error.message);
        state.eventsUnsubscribe = null;
        retryFeed();
      }
    );
}

let feedRetries = 0;
function retryFeed() {
  if (feedRetries >= 5) return;
  const wait = 1200 * Math.pow(2, feedRetries);
  feedRetries++;
  setTimeout(() => { if (state.uid) loadEvents(); }, wait);
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
  const clock = new Date(e.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (e.expiresAt <= now) {
    return { label: "Ended", value: relTime(e.expiresAt, now).replace(" ago", ""), sub: "ago" };
  }
  if (now >= e.startTime) {
    // Live. The useful number is how long is left, not how long it has
    // been running: you are deciding whether it is worth walking over.
    const leftMins = Math.max(0, Math.round((e.expiresAt - now) / 60000));
    const left = leftMins < 60 ? leftMins + "m" : Math.round(leftMins / 60) + "h";
    return { label: "Happening", value: "Now", sub: left + " left" };
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
function posterBand(e, now, { stat, spent = false } = {}) {
  const s = stat || timeStat(e, now);
  const glyph = (e.tag || "").trim().split(" ")[0];
  const word = (e.tag || "").trim().split(" ").slice(1).join(" ");
  return `
    <div class="poster${spent ? " spent" : ""}">
      <div class="poster-head">
        ${e.tag ? `<span class="poster-tag">${escapeHtml(glyph)} ${escapeHtml(word)}</span>` : ""}
        <span class="poster-place"><i class='bx bx-map-pin'></i><span>${escapeHtml(e.place)}</span></span>
      </div>
      <div class="poster-stat">
        <span class="poster-value">${escapeHtml(s.value)}</span>
        <span class="poster-side">
          <span class="poster-label">${escapeHtml(s.label)}</span>
          ${s.sub ? `<span class="poster-sub">${escapeHtml(s.sub)}</span>` : ""}
        </span>
      </div>
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

function goingText(uids, unconfirmedCount = 0) {
  const tail = unconfirmedCount > 0
    ? ` <span class="unconfirmed-tag">${unconfirmedCount} not confirmed</span>`
    : "";
  if (!uids.length) return "Nobody yet — be first" + tail;
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

/** Rail shortcut: scroll a card into view and flash it. */
export function focusEvent(eventId) {
  const card = document.getElementById(`event-${eventId}`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1400);
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



    const desc = e.description
      ? `<div class="event-desc-box">${escapeHtml(e.description)}</div>
         <button class="read-more-btn" onclick="window.toggleEventDesc('${id}')">Read details</button>`
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

    const actions = `
      <div class="card-actions">
        ${hypeBtn}
        ${(isHost || hasJoined) ? chatBtn : ""}
        <div style="flex:1"></div>
        ${primary}
      </div>`;

    const body = `
      <div class="card-body">
      <div class="event-title">${escapeHtml(e.title)}</div>
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
        ${avatarStack(withoutBlocked(confirmedGoing))}
        <span class="going-text">${goingText(withoutBlocked(confirmedGoing), unconfirmed.length)}</span>
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
      liveCards.push({ id, html: `
        <article class="event card poster-card ${isLive ? "is-live" : ""}" id="event-${id}"${tagAttr} style="--vibe:${vibe}">
          ${posterBand(e, now)}
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
      const leaves = fading
        ? `<div class="recap-leaves"><i class='bx bx-time-five'></i> Leaves recap ${escapeHtml(relTime(now + left, now))}</div>`
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
          ${posterBand(e, now, { stat: turnout, spent: true })}
          <div class="card-body">
            <div class="event-title">${escapeHtml(e.title)}</div>
            <div class="byline">
              <div class="av-ring tappable" ${openHost}>
                <div class="av-inner">${renderAvatar(avatarFor(e.hostUid))}</div>
              </div>
              <span class="byline-name tappable" ${openHost}>${escapeHtml(displayNameFor(e.hostUid))}</span>
              <span class="byline-meta">${escapeHtml(relTime(e.expiresAt, now))}</span>
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
       <span class="fr-spark">
         <!-- Drawn rather than an icon font. This is the first thing
              anybody sees, and a webfont that fails to load would leave
              an empty gradient blob in its place. -->
         <svg viewBox="0 0 24 24" width="27" height="27" aria-hidden="true">
           <path d="M13.5 2 4 13.2h6.2L9.8 22 20 10.6h-6.6L13.5 2Z" fill="currentColor"/>
         </svg>
       </span>
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
    .catch((err) => console.error("Join failed:", err.code || err.message));
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
    .catch((err) => console.error("Cancel failed:", err.code || err.message));
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
      <button class="btn-ghost" onclick="window.declineRequest('${u}')" aria-label="Decline"><i class='bx bx-x'></i></button>
      <button onclick="window.approveRequest('${u}')" aria-label="Approve"><i class='bx bx-check'></i></button>`)).join("");
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
        <button class="btn-ghost danger-text" onclick="window.removeAttendee('${u}')" aria-label="Remove"><i class='bx bx-user-minus'></i></button>`);
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
    .catch((err) => console.error("Decline failed:", err.code || err.message));
}

export function leaveEvent(id) {
  db.collection("events").doc(id)
    .update({
      participantUids: FieldValue.arrayRemove(state.uid),
      unconfirmedUids: FieldValue.arrayRemove(state.uid)
    })
    .catch((err) => console.error("Leave failed:", err.code || err.message));
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

export function confirmMoveToRecap() {
  const id = state.eventIdToManage;
  if (!id) return;
  closeDeleteModal();
  fadeOutCard(id, false);
  db.collection("events").doc(id)
    .update({ expiresAt: Date.now() - 1 })
    .catch((err) => console.error("Recap move failed:", err.code || err.message));
}

export function confirmDeletePermanently() {
  const id = state.eventIdToManage;
  if (!id) return;
  closeDeleteModal();
  fadeOutCard(id, true);

  db.collection("events").doc(id).delete().catch((error) => {
    console.error("Delete failed:", error.code, error.message);
    toast(
      error.code === "permission-denied"
        ? "You don't have permission to delete this event."
        : "Could not delete. Check your connection."
    );
    loadEvents();
  });
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
  const when = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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
    updatedAt: Date.now()
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
      let q = db.collection("events")
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
  } finally {
    state.recapLoading = false;
    // After the flag drops, so the empty state is the real one and not
    // a skeleton left behind.
    renderEvents();
  }
}

/** Called when the Recap tab is opened, and as it is scrolled. */
export function ensureRecapLoaded() {
  if (!state.recapOrder.length && !state.recapDone) loadRecap({ reset: true });
}

export function onRecapScroll(el) {
  if (!el) return;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 320) loadRecap();
}
