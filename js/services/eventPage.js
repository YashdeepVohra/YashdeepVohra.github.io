/**
 * THE EVENT PAGE — everything about one event on one screen.
 *
 * The card in the feed is a poster: it is built to be read while
 * scrolling, so it clips the place to one line, the note to two, and
 * shows one photo. This is where the rest is: every photo whole, the
 * full place, the full note, when it runs from and to, who is going,
 * the same actions as the card, and a way to report it.
 *
 * Opened by tapping a card's title, place or cover. It reads nothing:
 * everything on it is already in state.eventCache, and renderEvents()
 * repaints it with the feed, so it cannot fall out of step.
 */
import { state } from '../state/store.js';
import { renderAvatar, escapeHtml, safeId, clockTime } from '../utils/formatters.js';
import { toast } from '../utils/ui.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { displayNameFor, usernameFor, avatarFor } from './userService.js';
import { isBlocked, withoutBlocked } from './blockService.js';
import { inRecap, wasCalledOff } from './recapRules.js';
import { eventPhotos } from './photoRules.js';
import {
  vibeColor, posterBand, timeStat, avatarStack, goingText, cardActions, paintVolatile
} from './eventsService.js';

let currentId = null;
let lastHtml = "";

export function isEventPageOpen() {
  return !!currentId && !document.getElementById("eventScreen")?.classList.contains("hidden");
}

export function openEventPage(eventId) {
  const id = safeId(eventId);
  const e = id && state.eventCache[id];
  const now = Date.now();
  if (!e || isBlocked(e.hostUid) || !(e.expiresAt > now || inRecap(e, now, state.uid))) {
    toast("That event has ended.");
    return;
  }
  currentId = id;
  lastHtml = "";
  openOverlay("eventScreen", { onClose: () => { currentId = null; lastHtml = ""; } });
  renderEventPage();
  const body = document.getElementById("eventPageBody");
  if (body) body.scrollTop = 0;
}

export function closeEventPage() {
  closeOverlay("eventScreen");
}

/** "Today, 6:40 pm", "Yesterday, 11:00 pm", "Sat, 7:38 am", "3 Oct, 7:38 am". */
function dayAndTime(ms, now) {
  const d = new Date(ms), t = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(t)) / 86400000);
  const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday"
    : Math.abs(diff) < 7 ? d.toLocaleDateString("en-GB", { weekday: "short" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${label}, ${clockTime(ms)}`;
}

/** When it runs, start to end; the end's day only if it is a different one. */
function whenText(e, now) {
  const sameDay = new Date(e.startTime).toDateString() === new Date(e.expiresAt).toDateString();
  return `${dayAndTime(e.startTime, now)} \u2013 ${sameDay ? clockTime(e.expiresAt) : dayAndTime(e.expiresAt, now)}`;
}

export function renderEventPage() {
  const body = document.getElementById("eventPageBody");
  const id = currentId;
  const e = id && state.eventCache[id];
  if (!body) return;
  if (!e || isBlocked(e.hostUid)) {
    // Deleted, or its host blocked, while it was open.
    closeEventPage();
    return;
  }

  const now = Date.now();
  const ended = e.expiresAt <= now;
  const isHost = e.hostUid === state.uid;
  const participants = e.participantUids || [];
  const unconfirmed = e.unconfirmedUids || [];
  const guests = withoutBlocked(participants.filter((u) => u !== e.hostUid && !unconfirmed.includes(u)));
  const hostId = safeId(e.hostUid);
  const openHost = hostId ? `onclick="window.openProfileScreen('${hostId}')"` : "";

  const going = withoutBlocked(participants.filter((u) => !unconfirmed.includes(u))).length;
  const stats = ended
    ? [{ label: wasCalledOff(e) ? "Called off" : (guests.length === 1 ? "person went" : "people went"),
         value: wasCalledOff(e) ? "—" : String(guests.length), sub: "" }]
    : [timeStat(e, now), { label: "Going", parts: [[String(going), e.maxCapacity ? "/" + e.maxCapacity : ""]], sub: "" }];

  // Every photo, whole: the feed crops to 16:9, this does not. The
  // cover leads, right under the band, because it is what was tapped;
  // the rest wait below the details, so three photos never push the
  // title, the place and the time three screens down.
  const all = eventPhotos(e);
  const img = (url, i) => `
    <img class="ep-photo" src="${escapeHtml(url)}" alt="Photo ${i + 1} of ${all.length}" decoding="async" ${i ? `loading="lazy"` : ""}>`;
  const cover = all.length ? `<div class="ep-photos">${img(all[0], 0)}</div>` : "";
  const rest = all.length > 1 ? `
      <div class="ep-section">
        <div class="ep-label">More photos</div>
        <div class="ep-photos ep-more">${all.slice(1).map((u, i) => img(u, i + 1)).join("")}</div>
      </div>` : "";

  const html = `
    <div class="event ep" data-eid="${id}" style="--vibe:${vibeColor(e.tag)}">
      ${posterBand(e, now, { stats, spent: ended })}
      ${cover}
      <h2 class="ep-title">${escapeHtml(e.title)}</h2>
      <div class="ep-facts">
        <div class="ep-fact">
          <i class='bx bx-map-pin'></i><span>${escapeHtml(e.place)}</span>
        </div>
        <div class="ep-fact">
          <i class='bx bx-time-five'></i><span>${escapeHtml(whenText(e, now))}</span>
        </div>
        ${e.maxCapacity ? `<div class="ep-fact"><i class='bx bx-group'></i><span>${participants.length} of ${e.maxCapacity} spots taken</span></div>` : ""}
        ${e.requiresApproval ? `<div class="ep-fact"><i class='bx bx-lock-alt'></i><span>The host approves who joins</span></div>` : ""}
      </div>
      ${e.description ? `<p class="ep-desc">${escapeHtml(e.description)}</p>` : ""}

      <div class="ep-section">
        <div class="ep-label">Hosted by</div>
        <div class="byline">
          <div class="av-ring ${!ended && now >= e.startTime ? "live" : ""} tappable" ${openHost}>
            <div class="av-inner">${renderAvatar(avatarFor(e.hostUid))}</div>
          </div>
          <span class="byline-name tappable" ${openHost}>${escapeHtml(displayNameFor(e.hostUid))}</span>
          <span class="byline-meta">@${escapeHtml(usernameFor(e.hostUid))}</span>
        </div>
      </div>

      <div class="ep-section">
        <div class="ep-label">${ended ? "Who went" : "Who's going"}</div>
        <div class="going-row">
          ${avatarStack(guests)}
          <span class="going-text">${goingText(guests, unconfirmed.length, isHost)}</span>
        </div>
      </div>

      ${ended ? "" : cardActions(e, id)}

      ${rest}

      ${isHost ? "" : `
        <button type="button" class="ep-report" onclick="window.reportEvent('${id}')">
          <i class='bx bx-flag'></i> Report this event
        </button>`}
    </div>`;

  // Rebuilt only when something on it changed — the minute tick must
  // not reload its photos. Times go through the same data-vt slots as
  // the feed and are painted after.
  if (html !== lastHtml) {
    body.innerHTML = html;
    lastHtml = html;
  }
  paintVolatile(body, now);
}

/** Report the event itself: the host is who it is about. */
export function reportEvent(eventId) {
  const e = state.eventCache[eventId];
  if (!e) return;
  window.openReport?.(e.hostUid, { type: "event", id: eventId });
}
