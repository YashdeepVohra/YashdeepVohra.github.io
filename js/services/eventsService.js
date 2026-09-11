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
import { showTab } from '../utils/ui.js';
import { primeUsers, displayNameFor, usernameFor, avatarFor } from './userService.js';
import { isBlocked, withoutBlocked } from './blockService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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

export function setLiveFilter(element, tag) {
  state.currentLiveFilter = tag;
  syncFilterPills("#liveFilters", tag);
  renderEvents();
}

export function setRecapFilter(element, tag) {
  state.currentRecapFilter = tag;
  syncFilterPills("#recapFilters", tag);
  renderEvents();
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

export function openCreateScreen() {
  document.getElementById("createScreen")?.classList.remove("hidden");
  const now = new Date();
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const forInput = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const startEl = document.getElementById("startTime");
  const endEl = document.getElementById("endTime");
  if (startEl) startEl.value = forInput(now);
  if (endEl) endEl.value = forInput(inTwoHours);
}

export function closeCreateScreen() {
  document.getElementById("createScreen")?.classList.add("hidden");
}

export async function addEvent(e) {
  if (!auth.currentUser) return;

  const btn = e?.target?.closest("button") || document.querySelector("#createScreen .text-action-btn");
  const title = document.getElementById("title")?.value.trim();
  const place = document.getElementById("place")?.value.trim();
  const description = document.getElementById("description")?.value.trim() || "";
  const startTimeStr = document.getElementById("startTime")?.value;
  const endTimeStr = document.getElementById("endTime")?.value;
  const capacityRaw = document.getElementById("maxCapacity")?.value;
  const maxCapacity = capacityRaw ? parseInt(capacityRaw, 10) : null;

  if (!title || !place || !startTimeStr || !endTimeStr) {
    return alert("Please fill out all event details.");
  }

  const startTime = new Date(startTimeStr).getTime();
  const expiresAt = new Date(endTimeStr).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(expiresAt)) return alert("Those dates don't look right.");
  if (expiresAt <= startTime) return alert("Your event end time must be AFTER the start time.");
  if (expiresAt - startTime > 7 * DAY_MS) return alert("Events can run for at most a week.");

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
    await db.collection("events").add({
      hostUid: state.uid,
      title: title.slice(0, 80),
      place: place.slice(0, 80),
      description: description.slice(0, 500),
      tag: state.currentSelectedTag,
      startTime,
      expiresAt,
      participantUids: [state.uid],
      hypedUids: [],
      typingUids: [],
      maxCapacity: Number.isFinite(maxCapacity) && maxCapacity > 1 ? maxCapacity : null,
      createdAt: Date.now()
    });

    ["title", "place", "description", "maxCapacity"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    closeCreateScreen();
  } catch (error) {
    console.error("Publish failed:", error.code || error.message);
    alert("Failed to publish. Try again.");
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
    .where("expiresAt", ">", Date.now() - DAY_MS)
    .onSnapshot(
      async (snapshot) => {
        feedRetries = 0;
        const events = [];
        const uids = new Set();

        snapshot.forEach((doc) => {
          const data = { id: doc.id, ...doc.data() };
          events.push(data);
          state.eventCache[doc.id] = data;
          if (data.hostUid) uids.add(data.hostUid);
          (data.participantUids || []).forEach((u) => uids.add(u));
        });

        await primeUsers([...uids]);

        state.eventOrder = events
          .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
          .map((e) => e.id);

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
const vibeColor = (tag) => VIBE[tag] || "var(--periwinkle)";

// Drawn rather than an icon font: it carries the palette and can move.
const EMPTY_ART = `
  <svg class="empty-art" viewBox="0 0 120 90" fill="none" aria-hidden="true">
    <ellipse cx="60" cy="78" rx="34" ry="5" fill="var(--periwinkle)" opacity="0.25"/>
    <g class="float-a">
      <rect x="34" y="24" width="52" height="40" rx="12" fill="var(--paper)" stroke="var(--periwinkle)" stroke-width="2"/>
      <circle cx="49" cy="42" r="3.4" fill="var(--periwinkle)"/>
      <circle cx="71" cy="42" r="3.4" fill="var(--periwinkle)"/>
      <path d="M50 53c4 4 16 4 20 0" stroke="var(--periwinkle)" stroke-width="2" stroke-linecap="round"/>
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

/** Overlapping avatar stack, capped at four plus a counter. */
function avatarStack(uids) {
  const shown = uids.slice(0, 4);
  const rest = uids.length - shown.length;
  const chips = shown
    .map((uid) => `<div class="mini">${renderAvatar(avatarFor(uid))}</div>`)
    .join("");
  const more = rest > 0 ? `<div class="mini more">+${rest}</div>` : "";
  return `<div class="av-stack">${chips}${more}</div>`;
}

function goingText(uids) {
  if (!uids.length) return "Nobody yet — be first";
  const names = uids.slice(0, 2).map((uid) => {
    const id = safeId(uid);
    const name = escapeHtml(displayNameFor(uid));
    return id ? `<b onclick="event.stopPropagation(); window.startChatWithUid('${id}')">${name}</b>` : name;
  });
  const rest = uids.length - names.length;
  return names.join(", ") + (rest > 0 ? ` and ${rest} more going` : " going");
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
  if (!items.length) { rail.innerHTML = ""; return; }

  rail.innerHTML = items.map((e) => {
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
   Feed
   ------------------------------------------------------------------- */
export function renderEvents() {
  const liveList = document.getElementById("events");
  const recapList = document.getElementById("recapEvents");
  if (!liveList || !recapList) return;

  const order = state.eventOrder || [];
  const now = Date.now();
  const oneDayAgo = now - DAY_MS;

  renderLiveRail(order, now);

  let liveHTML = "";
  let recapHTML = "";
  let activeCount = 0;
  let recapCount = 0;

  order.forEach((eventId) => {
    const e = state.eventCache[eventId];
    if (!e) return;
    const id = safeId(eventId);
    if (!id) return;

    // Blocking is total: their events do not exist for you.
    if (isBlocked(e.hostUid)) return;

    const participants = e.participantUids || [];
    const attendees = participants.length || 1;
    const isLive = now >= e.startTime;
    const hasHyped = (e.hypedUids || []).includes(state.uid);
    const hypeCount = (e.hypedUids || []).length;
    const hasJoined = participants.includes(state.uid);
    const isHost = e.hostUid === state.uid;
    const isFull = e.maxCapacity && attendees >= e.maxCapacity;
    const vibe = vibeColor(e.tag);

    const header = `
      <div class="card-top">
        <div class="av-ring ${isLive ? "live" : ""}">
          <div class="av-inner">${renderAvatar(avatarFor(e.hostUid))}</div>
        </div>
        <div class="card-who">
          <div class="who-line">
            <span class="who-name">${escapeHtml(displayNameFor(e.hostUid))}</span>
            <span class="who-meta">@${escapeHtml(usernameFor(e.hostUid))} · ${escapeHtml(relTime(e.startTime, now))}</span>
          </div>
          <div class="who-place"><i class='bx bx-map-pin'></i> ${escapeHtml(e.place)}</div>
        </div>
        ${isLive
          ? `<span class="status-chip live"><span class="live-dot"></span> Live</span>`
          : `<span class="status-chip soon">Soon</span>`}
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

    const hypeBtn = `<button class="act ${hasHyped ? "hyped" : ""}" onclick="window.toggleHype('${id}', ${hasHyped})"><i class='bx ${hasHyped ? "bxs-hot" : "bx-hot"}'></i> ${hypeCount || "Hype"}</button>`;
    const chatBtn = `<button class="act" onclick="window.openEventChat('${id}')"><i class='bx bx-message-rounded-dots'></i> Chat</button>`;

    let primary;
    if (isHost) primary = `<button class="act joined" onclick="window.openDeleteModal('${id}')"><i class='bx bx-slider-alt'></i> Manage</button>`;
    else if (hasJoined) primary = `<button class="act joined" onclick="window.leaveEvent('${id}')"><i class='bx bx-check'></i> Going</button>`;
    else if (isFull) primary = `<button class="act full" disabled>Full</button>`;
    else primary = `<button class="act primary" onclick="window.joinEvent('${id}')">Join</button>`;

    const actions = `
      <div class="card-actions">
        ${hypeBtn}
        ${(isHost || hasJoined) ? chatBtn : ""}
        <div style="flex:1"></div>
        ${primary}
      </div>`;

    const body = `
      <div class="event-title">${escapeHtml(e.title)}</div>
      ${desc}
      ${e.tag ? `<div class="vibe-chip">${escapeHtml(e.tag)}</div>` : ""}
      <div class="going-row">
        ${avatarStack(withoutBlocked(participants))}
        <span class="going-text">${goingText(withoutBlocked(participants))}</span>
      </div>
      ${capacity}`;

    const matchesLive = state.currentLiveFilter === "All" || e.tag === state.currentLiveFilter;
    const matchesRecap = state.currentRecapFilter === "All" || e.tag === state.currentRecapFilter;

    if (e.expiresAt > now) {
      if (!matchesLive) return;
      activeCount++;
      const glyph = (e.tag || "").trim().split(" ")[0];
      liveHTML += `
        <article class="event card ${isLive ? "is-live" : ""}" id="event-${id}" style="--vibe:${vibe}">
          ${isLive ? `<span class="live-edge"></span>` : ""}
          <span class="vibe-watermark">${escapeHtml(glyph)}</span>
          ${header}${body}${actions}
        </article>`;
    } else if (e.expiresAt > oneDayAgo) {
      if (!matchesRecap) return;
      recapCount++;
      recapHTML += `
        <article class="event card recap" id="event-${id}" style="--vibe:${vibe}">
          <span class="vibe-watermark">${escapeHtml((e.tag || "").trim().split(" ")[0])}</span>
          ${header}
          <div class="event-title">${escapeHtml(e.title)}</div>
          ${e.tag ? `<div class="vibe-chip">${escapeHtml(e.tag)}</div>` : ""}
          <div class="going-row">
            ${avatarStack(participants)}
            <span class="going-text">${attendees} ${attendees === 1 ? "person" : "people"} went</span>
          </div>
        </article>`;
    }
  });

  liveList.className = "stagger";
  recapList.className = "stagger";
  liveList.innerHTML = activeCount
    ? liveHTML
    : `<div class="empty-state">${EMPTY_ART}<h4>Campus is quiet</h4><p>Nothing live right now — be the one who starts something.</p></div>`;
  recapList.innerHTML = recapCount
    ? recapHTML
    : `<div class="empty-state">${EMPTY_ART}<h4>Nothing here yet</h4><p>No history for this filter.</p></div>`;

  updateRail(order, now);
}

// ---------- Membership ----------
export function joinEvent(id) {
  const e = state.eventCache[id];
  if (e && e.maxCapacity && (e.participantUids || []).length >= e.maxCapacity) {
    return alert("This event is already full.");
  }
  db.collection("events").doc(id)
    .update({ participantUids: FieldValue.arrayUnion(state.uid) })
    .catch((err) => console.error("Join failed:", err.code || err.message));
}

export function leaveEvent(id) {
  db.collection("events").doc(id)
    .update({ participantUids: FieldValue.arrayRemove(state.uid) })
    .catch((err) => console.error("Leave failed:", err.code || err.message));
}

export function toggleHype(id, isHyped) {
  const ref = db.collection("events").doc(id);
  const op = isHyped
    ? { hypedUids: FieldValue.arrayRemove(state.uid) }
    : { hypedUids: FieldValue.arrayUnion(state.uid) };

  if (!isHyped) {
    if (navigator.vibrate) navigator.vibrate(45);
    burstFrom(document.activeElement || document.querySelector(`#event-${id} .act`));
  }
  ref.update(op).catch((err) => console.error("Hype failed:", err.code || err.message));
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
  const colors = ["var(--vibe-party)", "var(--vibe-food)", "var(--violet)", "var(--periwinkle)", "var(--vibe-sports)"];

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
  document.getElementById("deleteModal")?.classList.remove("hidden");
}

export function closeDeleteModal() {
  state.eventIdToManage = null;
  document.getElementById("deleteModal")?.classList.add("hidden");
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
    alert(
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
