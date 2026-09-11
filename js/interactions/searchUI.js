// ==========================================
// SEARCH SCREEN
// ==========================================

import { state } from '../state/store.js';
import { escapeHtml, safeId, renderAvatar } from '../utils/formatters.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { showTab } from '../utils/ui.js';
import { displayNameFor, usernameFor, avatarFor } from '../services/userService.js';
import { searchPeople, searchEvents } from '../services/searchService.js';
import { focusEvent } from '../services/eventsService.js';

let debounce = 0;
let lastQuery = "";

export function openSearch() {
  openOverlay("searchScreen");
  const input = document.getElementById("searchInput");
  if (input) {
    input.value = "";
    // A hair of delay or the keyboard fights the opening animation.
    setTimeout(() => input.focus(), 180);
  }
  renderSearch("", [], []);
}

export function closeSearch() {
  closeOverlay("searchScreen");
}

/** Debounced so a fast typist makes one query, not eight. */
export function onSearchInput(value) {
  clearTimeout(debounce);
  const q = String(value || "");
  lastQuery = q;

  if (q.trim().length < 2) {
    renderSearch(q, [], []);
    return;
  }

  // Events are local, so show them immediately; people need a round trip.
  renderSearch(q, [], searchEvents(q), { peopleLoading: true });

  debounce = setTimeout(async () => {
    const people = await searchPeople(q);
    if (lastQuery !== q) return;          // a newer keystroke won
    renderSearch(q, people, searchEvents(q));
  }, 260);
}

function personRow(uid) {
  const id = safeId(uid);
  if (!id) return "";
  return `
    <button class="result-row" onclick="window.searchOpenProfile('${id}')">
      <div class="chat-avatar" style="width:40px;height:40px;font-size:18px;">${renderAvatar(avatarFor(uid))}</div>
      <div class="result-text">
        <div class="result-title">${escapeHtml(displayNameFor(uid))}</div>
        <div class="result-sub">@${escapeHtml(usernameFor(uid))}</div>
      </div>
      <i class='bx bx-chevron-right'></i>
    </button>`;
}

function eventRow(e) {
  const id = safeId(e.id);
  if (!id) return "";
  const now = Date.now();
  const stateLabel = e.expiresAt <= now ? "Ended" : now >= e.startTime ? "Live" : "Soon";
  const cls = e.expiresAt <= now ? "soon" : now >= e.startTime ? "live" : "soon";
  return `
    <button class="result-row" onclick="window.searchOpenEvent('${id}')">
      <div class="result-icon">${escapeHtml((e.tag || "").trim().split(" ")[0] || "\u{1F4C5}")}</div>
      <div class="result-text">
        <div class="result-title">${escapeHtml(e.title)}</div>
        <div class="result-sub">${escapeHtml(e.place)} · ${escapeHtml(displayNameFor(e.hostUid))}</div>
      </div>
      <span class="status-chip ${cls}">${stateLabel}</span>
    </button>`;
}

function renderSearch(query, people, events, { peopleLoading = false } = {}) {
  const box = document.getElementById("searchResults");
  if (!box) return;

  if (query.trim().length < 2) {
    box.innerHTML = `
      <div class="search-hint">
        <i class='bx bx-search-alt'></i>
        <p>Search people by handle, or events by name, place or vibe.</p>
      </div>`;
    return;
  }

  let html = "";

  if (events.length) {
    html += `<div class="result-group">Events</div>` + events.map(eventRow).join("");
  }

  if (people.length) {
    html += `<div class="result-group">People</div>` + people.map(personRow).join("");
  } else if (peopleLoading) {
    html += `<div class="result-group">People</div>
      <div class="skel-card" style="padding:12px">
        <div class="skel-row" style="margin:0">
          <div class="skel skel-avatar"></div>
          <div style="flex:1"><div class="skel skel-line w-40"></div></div>
        </div>
      </div>`;
  }

  if (!html) {
    html = `
      <div class="search-hint">
        <i class='bx bx-ghost'></i>
        <p>Nothing matches “${escapeHtml(query)}”.</p>
      </div>`;
  }

  box.innerHTML = html;
}

// ---- Result actions: close search first, then go ----
export function searchOpenProfile(uid) {
  closeSearch();
  setTimeout(() => window.openProfileScreen(uid), 60);
}

export function searchOpenEvent(eventId) {
  closeSearch();
  setTimeout(() => {
    showTab("events");
    focusEvent(eventId);
  }, 120);
}
