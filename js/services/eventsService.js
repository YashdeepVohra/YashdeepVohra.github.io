import { auth, db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar } from '../utils/formatters.js';

export function selectTag(element, tag) {
  document.querySelectorAll('#tagSelector .tag').forEach(t => t.classList.remove('active'));
  element.classList.add('active');
  state.currentSelectedTag = element.innerText;
}

export function setLiveFilter(element, tag) {
  state.currentLiveFilter = tag;
  document.querySelectorAll('#liveFilters .filter-pill').forEach(pill => pill.classList.remove('active'));
  element.classList.add('active');
  loadEvents();
}

export function setRecapFilter(element, tag) {
  state.currentRecapFilter = tag;
  document.querySelectorAll('#recapFilters .filter-pill').forEach(pill => pill.classList.remove('active'));
  element.classList.add('active');
  loadEvents();
}

export function toggleEventDesc(eventId) {
  const eventCard = document.getElementById(`event-${eventId}`);
  if (!eventCard) return;
  eventCard.classList.toggle('expanded');
  const btn = eventCard.querySelector('.read-more-btn');
  if (btn) btn.innerText = eventCard.classList.contains('expanded') ? "Hide details" : "Read details...";
}

export function openCreateScreen() {
  document.getElementById("createScreen")?.classList.remove("hidden");
  const now = new Date();
  const inTwoHours = new Date(now.getTime() + (2 * 60 * 60 * 1000));
  const formatForInput = (date) => (new Date(date - (date.getTimezoneOffset() * 60000))).toISOString().slice(0, 16);
  
  const startEl = document.getElementById("startTime");
  const endEl = document.getElementById("endTime");
  if (startEl) startEl.value = formatForInput(now);
  if (endEl) endEl.value = formatForInput(inTwoHours);
}

export function closeCreateScreen() {
  document.getElementById("createScreen")?.classList.add("hidden");
}

export function addEvent(e) {
  const btn = e?.target?.closest('button') || document.querySelector("#createScreen button.submit-btn");
  const title = document.getElementById("title")?.value.trim();
  const place = document.getElementById("place")?.value.trim();
  const description = document.getElementById("description")?.value.trim();
  const startTimeStr = document.getElementById("startTime")?.value;
  const endTimeStr = document.getElementById("endTime")?.value;
  const capacityRaw = document.getElementById("maxCapacity")?.value;
  const maxCapacity = capacityRaw ? parseInt(capacityRaw) : null;

  if (!title || !place || !startTimeStr || !endTimeStr) return alert("Please fill out all event details.");

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Publishing...`;
  }

  const startTimestamp = new Date(startTimeStr).getTime();
  const endTimestamp = new Date(endTimeStr).getTime();

  if (endTimestamp <= startTimestamp) {
    alert("Your event end time must be AFTER the start time.");
    if (btn) { btn.disabled = false; btn.innerHTML = `Publish to Campus <i class='bx bx-send'></i>`; }
    return;
  }

  db.collection("events").add({
    title,
    place,
    description,
    tag: state.currentSelectedTag,
    user: state.user,
    hostAvatar: state.userAvatar,
    startTime: startTimestamp,
    expiresAt: endTimestamp,
    participants: [state.user],
    uid: auth.currentUser.uid,
    hypedBy: [],
    maxCapacity: maxCapacity
  }).then(() => {
    if (document.getElementById("title")) document.getElementById("title").value = "";
    if (document.getElementById("place")) document.getElementById("place").value = "";
    if (document.getElementById("description")) document.getElementById("description").value = "";
    if (document.getElementById("maxCapacity")) document.getElementById("maxCapacity").value = "";
    closeCreateScreen();
    if (btn) { btn.disabled = false; btn.innerHTML = `Publish to Campus <i class='bx bx-send'></i>`; }
  }).catch((error) => {
    console.error("Error:", error);
    alert("Failed to publish. Try again.");
    if (btn) { btn.disabled = false; btn.innerHTML = `Publish to Campus <i class='bx bx-send'></i>`; }
  });
}

export function loadEvents() {
  db.collection("events").orderBy("startTime", "desc").onSnapshot(async (snapshot) => {
    const liveList = document.getElementById("events");
    const recapList = document.getElementById("recapEvents");
    if (!liveList || !recapList) return;

    let eventsArray = [];
    let uniqueUsers = new Set();

    snapshot.forEach(doc => {
      const e = doc.data();
      eventsArray.push({ id: doc.id, ...e });
      uniqueUsers.add(e.user);
      if (e.participants) e.participants.forEach(p => uniqueUsers.add(p));
    });

    for (let u of uniqueUsers) {
      if (!state.userCache[u]) {
        const doc = await db.collection("users").doc(u).get();
        state.userCache[u] = doc.exists ? doc.data() : { displayName: u, avatar: "👤" };
      }
    }

    liveList.innerHTML = "";
    recapList.innerHTML = "";
    let activeCount = 0;
    let recapCount = 0;
    const currentTime = Date.now();
    const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);

    eventsArray.forEach(data => {
      const e = data;
      const id = data.id;
      const attendeesCount = e.participants ? e.participants.length : 1;
      const hostDisplayName = state.userCache[e.user]?.displayName || e.user;
      const hostLiveAvatar = state.userCache[e.user]?.avatar || e.hostAvatar || "👤";

      let attendeeNames = "";
      if (e.participants && e.participants.length > 0) {
        const visibleParticipants = e.participants.slice(0, 3);
        attendeeNames = visibleParticipants.map(p => {
          const pDisplayName = state.userCache[p]?.displayName || p;
          return `<span onclick="event.stopPropagation(); window.startChat('${p}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${pDisplayName}</span>`;
        }).join(", ");

        if (e.participants.length > 3) {
          attendeeNames += ` <span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">+${e.participants.length - 3} more</span>`;
        }
      } else {
        attendeeNames = `<span onclick="event.stopPropagation(); window.startChat('${e.user}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${hostDisplayName}</span>`;
      }

      const hypeCount = e.hypedBy ? e.hypedBy.length : 0;
      const hasHyped = e.hypedBy && e.hypedBy.includes(state.user);
      const hypeClass = hasHyped ? "hype-btn active" : "hype-btn";
      const hypeIcon = hasHyped ? "bxs-hot" : "bx-hot";
      const hypeHTML = `<button class="${hypeClass}" onclick="window.toggleHype('${id}', ${hasHyped})"><i class='bx ${hypeIcon}'></i> ${hypeCount > 0 ? hypeCount : 'Hype'}</button>`;

      const isFull = e.maxCapacity && attendeesCount >= e.maxCapacity;
      let capacityHTML = "";

      if (e.maxCapacity) {
        const percent = Math.min((attendeesCount / e.maxCapacity) * 100, 100);
        const barColor = isFull ? "var(--danger)" : "var(--primary)";
        capacityHTML = `
          <div style="margin-top: 12px; margin-bottom: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">
              <span><i class='bx bx-user'></i> Capacity</span>
              <span style="color: ${isFull ? 'var(--danger)' : 'inherit'}">${attendeesCount} / ${e.maxCapacity} ${isFull ? '(Full)' : ''}</span>
            </div>
            <div style="width: 100%; background: #e2e8f0; border-radius: 4px; height: 6px; overflow: hidden;">
              <div style="width: ${percent}%; background: ${barColor}; height: 100%; border-radius: 4px; transition: width 0.3s;"></div>
            </div>
          </div>
        `;
      }

      const displayTag = e.tag ? `<div class="event-tag-badge" style="margin-bottom: 0;">${e.tag}</div>` : '';
      const displayDesc = e.description ? `<button class="read-more-btn" onclick="window.toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${e.description}</div>` : '';
      let statusBadge = (currentTime < e.startTime) 
        ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>` 
        : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;

      const avatarHTML = `<div style="display:inline-block; width:24px; height:24px; border-radius:50%; vertical-align:middle; overflow:hidden; border:1px solid var(--border); margin-right:4px;">${renderAvatar(hostLiveAvatar)}</div>`;
      const matchesLive = state.currentLiveFilter === 'All' || e.tag === state.currentLiveFilter;
      const matchesRecap = state.currentRecapFilter === 'All' || e.tag === state.currentRecapFilter;

      if (e.expiresAt > currentTime) {
        if (matchesLive) {
          activeCount++;
          const hasJoined = e.participants && e.participants.includes(state.user);
          liveList.innerHTML += `
            <div class="event card" id="event-${id}">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; gap: 8px; align-items: center;">${displayTag} ${statusBadge}</div>
                ${hypeHTML}
              </div>
              <div class="event-title">${e.title}</div>
              <div class="event-meta" style="display:flex; align-items:center;">
                ${avatarHTML} <span>${e.place} • hosted by ${hostDisplayName}</span>
              </div>
              ${displayDesc}
              <div class="attendees">
                <i class='bx bx-group'></i> Going (${attendeesCount}): ${attendeeNames}
              </div>
              ${capacityHTML} ${e.user === state.user 
                ? `<div style="display:flex; gap:8px; margin-top:16px;">
                     <button class="join" style="margin-top:0; flex:2;" onclick="window.openEventChat('${id}', '${e.title.replace(/'/g, "\\'")}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
                     <button class="delete-btn" style="margin-top:0; flex:1;" onclick="window.openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage</button>
                   </div>` 
                : (hasJoined 
                   ? `<div style="display:flex; gap:8px; margin-top:16px;">
                        <button class="join" style="margin-top:0; flex:3;" onclick="window.openEventChat('${id}', '${e.title.replace(/'/g, "\\'")}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
                        <button class="leave-btn" style="margin-top:0; flex:1;" onclick="window.leaveEvent('${id}')"><i class='bx bx-exit'></i></button>
                      </div>` 
                   : (isFull 
                      ? `<button class="join" style="background: #cbd5e1; color: #64748b; cursor: not-allowed;" disabled>Event Full 🛑</button>`
                      : `<button class="join" onclick="window.joinEvent('${id}')">Join Hangout</button>`
                     )
                  )
              }
            </div>`;
        }
      } else if (e.expiresAt > oneDayAgo) {
        if (matchesRecap) {
          recapCount++;
          recapList.innerHTML += `
            <div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; gap: 8px; align-items: center;">${displayTag}</div>
                ${hypeHTML}
              </div>
              <div class="event-title" style="color: #4b5563;">${e.title}</div>
              <div class="event-meta" style="display:flex; align-items:center;">${avatarHTML} <span>${e.place} • hosted by ${hostDisplayName}</span></div>
              <div class="attendees" style="background:#f3f4f6; color: var(--text-muted);"><i class='bx bx-check-double'></i> Attended (${attendeesCount}): ${attendeeNames}</div>
            </div>`;
        }
      }
    });

    if (activeCount === 0) liveList.innerHTML = `<div class="empty-state"><i class='bx bx-ghost'></i><p>Nothing matching that filter right now.</p></div>`;
    if (recapCount === 0) recapList.innerHTML = `<div class="empty-state"><i class='bx bx-history'></i><p>No recent history for this filter.</p></div>`;
  });
}

export function joinEvent(id) {
  db.collection("events").doc(id).update({
    participants: firebase.firestore.FieldValue.arrayUnion(state.user)
  });
}

export function leaveEvent(id) {
  db.collection("events").doc(id).update({
    participants: firebase.firestore.FieldValue.arrayRemove(state.user)
  });
}

export function toggleHype(id, isHyped) {
  const eventRef = db.collection("events").doc(id);
  if (isHyped) {
    eventRef.update({ hypedBy: firebase.firestore.FieldValue.arrayRemove(state.user) });
  } else {
    eventRef.update({ hypedBy: firebase.firestore.FieldValue.arrayUnion(state.user) });
    if (navigator.vibrate) navigator.vibrate(50);
  }
}

export function openDeleteModal(id) {
  state.eventIdToManage = id;
  document.getElementById("deleteModal")?.classList.remove("hidden");
}

export function closeDeleteModal() {
  state.eventIdToManage = null;
  document.getElementById("deleteModal")?.classList.add("hidden");
}

export function confirmMoveToRecap() {
  if (!state.eventIdToManage) return;
  const eventCard = document.getElementById(`event-${state.eventIdToManage}`);
  if (eventCard) {
    eventCard.style.transition = "all 0.3s ease";
    eventCard.style.opacity = "0";
    eventCard.style.transform = "scale(0.9)";
    setTimeout(() => eventCard.classList.add("hidden"), 300);
  }
  const id = state.eventIdToManage;
  closeDeleteModal();
  db.collection("events").doc(id).update({ expiresAt: Date.now() - 1 });
}

export function confirmDeletePermanently() {
  if (!state.eventIdToManage) return;
  const eventId = state.eventIdToManage;
  const eventCard = document.getElementById(`event-${eventId}`);

  if (eventCard) {
    eventCard.style.transition = "all 0.3s ease";
    eventCard.style.opacity = "0";
    eventCard.style.transform = "scale(0.9)";
    setTimeout(() => eventCard.remove(), 300);
  }

  closeDeleteModal();

  db.collection("events").doc(eventId).delete().catch((error) => {
    console.error("🚨 Firestore Delete Error:", error.code, error.message);
    alert(error.code === 'permission-denied' ? "Security Error: You don't have permission to delete this event." : "Connection Error: Could not delete.");
    loadEvents();
  });
}
