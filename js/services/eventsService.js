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
import { primeUsers, displayNameFor, avatarFor } from './userService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Create screen ----------
export function selectTag(element, tag) {
  document.querySelectorAll("#tagSelector .tag").forEach((t) => t.classList.remove("active"));
  element.classList.add("active");
  state.currentSelectedTag = tag || element.innerText;
}

export function setLiveFilter(element, tag) {
  state.currentLiveFilter = tag;
  document.querySelectorAll("#liveFilters .filter-pill").forEach((p) => p.classList.remove("active"));
  element.classList.add("active");
  renderEvents();
}

export function setRecapFilter(element, tag) {
  state.currentRecapFilter = tag;
  document.querySelectorAll("#recapFilters .filter-pill").forEach((p) => p.classList.remove("active"));
  element.classList.add("active");
  renderEvents();
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

  state.eventsUnsubscribe = db
    .collection("events")
    .where("expiresAt", ">", Date.now() - DAY_MS)
    .onSnapshot(
      async (snapshot) => {
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
      (error) => console.error("Feed error:", error.code || error.message)
    );
}

function participantLinks(event) {
  const uids = (event.participantUids && event.participantUids.length)
    ? event.participantUids
    : [event.hostUid];

  const visible = uids.slice(0, 3).map((uid) => {
    const id = safeId(uid);
    const name = escapeHtml(displayNameFor(uid));
    if (!id) return name;
    return `<span onclick="event.stopPropagation(); window.startChatWithUid('${id}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${name}</span>`;
  }).join(", ");

  const extra = uids.length > 3
    ? ` <span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">+${uids.length - 3} more</span>`
    : "";

  return visible + extra;
}

function capacityBar(event, attendees) {
  if (!event.maxCapacity) return "";
  const isFull = attendees >= event.maxCapacity;
  const percent = Math.min((attendees / event.maxCapacity) * 100, 100);
  const barColor = isFull ? "var(--danger)" : "var(--primary)";
  return `
    <div style="margin-top: 12px; margin-bottom: 4px;">
      <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">
        <span><i class='bx bx-user'></i> Capacity</span>
        <span style="color: ${isFull ? "var(--danger)" : "inherit"}">${attendees} / ${event.maxCapacity} ${isFull ? "(Full)" : ""}</span>
      </div>
      <div style="width: 100%; background: #e2e8f0; border-radius: 4px; height: 6px; overflow: hidden;">
        <div style="width: ${percent}%; background: ${barColor}; height: 100%; border-radius: 4px; transition: width 0.3s;"></div>
      </div>
    </div>`;
}

export function renderEvents() {
  const liveList = document.getElementById("events");
  const recapList = document.getElementById("recapEvents");
  if (!liveList || !recapList) return;

  const order = state.eventOrder || [];
  const now = Date.now();
  const oneDayAgo = now - DAY_MS;

  let liveHTML = "";
  let recapHTML = "";
  let activeCount = 0;
  let recapCount = 0;

  order.forEach((eventId) => {
    const e = state.eventCache[eventId];
    if (!e) return;

    const id = safeId(eventId);
    if (!id) return;

    const attendees = (e.participantUids || []).length || 1;
    const hostName = escapeHtml(displayNameFor(e.hostUid));
    const hypeCount = (e.hypedUids || []).length;
    const hasHyped = (e.hypedUids || []).includes(state.uid);
    const hasJoined = (e.participantUids || []).includes(state.uid);
    const isHost = e.hostUid === state.uid;
    const isFull = e.maxCapacity && attendees >= e.maxCapacity;

    const hypeHTML = `<button class="${hasHyped ? "hype-btn active" : "hype-btn"}" onclick="window.toggleHype('${id}', ${hasHyped})"><i class='bx ${hasHyped ? "bxs-hot" : "bx-hot"}'></i> ${hypeCount > 0 ? hypeCount : "Hype"}</button>`;

    const tagHTML = e.tag ? `<div class="event-tag-badge" style="margin-bottom: 0;">${escapeHtml(e.tag)}</div>` : "";
    const descHTML = e.description
      ? `<button class="read-more-btn" onclick="window.toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${escapeHtml(e.description)}</div>`
      : "";

    const statusBadge = now < e.startTime
      ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>`
      : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;

    const avatarHTML = `<div style="display:inline-block; width:24px; height:24px; border-radius:50%; vertical-align:middle; overflow:hidden; border:1px solid var(--border); margin-right:4px;">${renderAvatar(avatarFor(e.hostUid))}</div>`;

    let actionsHTML;
    if (isHost) {
      actionsHTML = `<div style="display:flex; gap:8px; margin-top:16px;">
          <button class="join" style="margin-top:0; flex:2;" onclick="window.openEventChat('${id}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
          <button class="delete-btn" style="margin-top:0; flex:1;" onclick="window.openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage</button>
        </div>`;
    } else if (hasJoined) {
      actionsHTML = `<div style="display:flex; gap:8px; margin-top:16px;">
          <button class="join" style="margin-top:0; flex:3;" onclick="window.openEventChat('${id}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
          <button class="leave-btn" style="margin-top:0; flex:1;" onclick="window.leaveEvent('${id}')"><i class='bx bx-exit'></i></button>
        </div>`;
    } else if (isFull) {
      actionsHTML = `<button class="join" style="background: #cbd5e1; color: #64748b; cursor: not-allowed;" disabled>Event Full \u{1F6D1}</button>`;
    } else {
      actionsHTML = `<button class="join" onclick="window.joinEvent('${id}')">Join Hangout</button>`;
    }

    const matchesLive = state.currentLiveFilter === "All" || e.tag === state.currentLiveFilter;
    const matchesRecap = state.currentRecapFilter === "All" || e.tag === state.currentRecapFilter;

    if (e.expiresAt > now) {
      if (!matchesLive) return;
      activeCount++;
      liveHTML += `
        <div class="event card" id="event-${id}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="display: flex; gap: 8px; align-items: center;">${tagHTML} ${statusBadge}</div>
            ${hypeHTML}
          </div>
          <div class="event-title">${escapeHtml(e.title)}</div>
          <div class="event-meta" style="display:flex; align-items:center;">
            ${avatarHTML} <span>${escapeHtml(e.place)} • hosted by ${hostName}</span>
          </div>
          ${descHTML}
          <div class="attendees">
            <i class='bx bx-group'></i> Going (${attendees}): ${participantLinks(e)}
          </div>
          ${capacityBar(e, attendees)}
          ${actionsHTML}
        </div>`;
    } else if (e.expiresAt > oneDayAgo) {
      if (!matchesRecap) return;
      recapCount++;
      recapHTML += `
        <div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="display: flex; gap: 8px; align-items: center;">${tagHTML}</div>
            ${hypeHTML}
          </div>
          <div class="event-title" style="color: #4b5563;">${escapeHtml(e.title)}</div>
          <div class="event-meta" style="display:flex; align-items:center;">${avatarHTML} <span>${escapeHtml(e.place)} • hosted by ${hostName}</span></div>
          <div class="attendees" style="background:#f3f4f6; color: var(--text-muted);"><i class='bx bx-check-double'></i> Attended (${attendees}): ${participantLinks(e)}</div>
        </div>`;
    }
  });

  liveList.innerHTML = activeCount
    ? liveHTML
    : `<div class="empty-state"><i class='bx bx-ghost'></i><p>Nothing matching that filter right now.</p></div>`;
  recapList.innerHTML = recapCount
    ? recapHTML
    : `<div class="empty-state"><i class='bx bx-history'></i><p>No recent history for this filter.</p></div>`;
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

  if (!isHyped && navigator.vibrate) navigator.vibrate(50);
  ref.update(op).catch((err) => console.error("Hype failed:", err.code || err.message));
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
