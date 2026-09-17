// ==========================================
// PROFILES & SETTINGS
// ==========================================
//
// A profile is addressed by uid, never by username. The handle is only
// ever rendered as text.
// ==========================================

import { auth, db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { renderAvatar, escapeHtml, safeId } from '../utils/formatters.js';
import { switchScreen, showTab, toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { syncThemeUI } from '../utils/theme.js';
import { focusEvent, loadRecap, renderEvents, vibeColor } from './eventsService.js';
import { inRecap, wasCalledOff } from './recapRules.js';
import { INTERESTS, INTERESTS_MAX, BIO_MAX, cleanBio, cleanInterests } from './aboutRules.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { closeChat, startChatWithUid } from './chatService.js';
import { fetchUser, displayNameFor, usernameFor, avatarFor, rememberUser } from './userService.js';
import {
  orbitStatus, inOrbit, hasVouched, vouchCount, vouchersYouKnow, renderOrbitRings
} from './orbitService.js';
import {
  isFollowing, followerCount, followingCount,
  isPrivateAccount, hasAskedToFollow, myFollowRequests, syncPrivacyUI, severFollow
} from './followService.js';
import { isBlocked, withoutBlocked, blockUser, unblockUser, submitReport, myBlockList } from './blockService.js';

// The avatar picker only ever writes one of these, or the Google photo.
const ALLOWED_AVATARS = ["\u{1F98A}", "\u{1F43C}", "\u{1F42F}", "\u{1F438}", "\u{1F436}", "\u{1F431}", "\u{1F984}", "\u{1F47D}", "\u{1F47B}"];

export function openProfileModal() { openOverlay("profileModal"); }
export function closeProfileModal() { closeOverlay("profileModal"); }

function applyAvatarEverywhere(avatar) {
  ["topAvatar", "profileAvatarDisplay", "profileLargeAvatar", "sideAvatar"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = renderAvatar(avatar);
  });
}

export function selectAvatar(element, type) {
  const newAvatar = type === "google" ? state.googlePfp : type;
  if (type !== "google" && !ALLOWED_AVATARS.includes(type)) return;

  db.collection("users").doc(state.uid)
    .set({ avatar: newAvatar, updatedAt: Date.now() }, { merge: true })
    .catch((e) => console.error("Avatar save failed:", e.code || e.message));

  state.userAvatar = newAvatar;
  if (state.userCache[state.uid]) {
    state.userCache[state.uid].avatar = newAvatar;
    rememberUser(state.uid, state.userCache[state.uid]);
  }
  applyAvatarEverywhere(newAvatar);
  closeProfileModal();
}

/**
 * Where you were before this profile.
 *
 * Profiles chain: a follower list leads to somebody's profile, whose
 * orbit leads to another. The profile screen is one screen, not a
 * stack, so back used to drop you all the way to the feed from three
 * profiles deep. Each hop remembers the one before it, and back walks
 * them in order — which matches the history entry each hop pushed.
 */
const profileTrail = [];

export function openProfileScreen(targetUid = null) {
  const uid = safeId(targetUid) || state.uid;

  const alreadyOnAProfile = !document
    .getElementById("profileScreen")
    ?.classList.contains("hidden");
  if (alreadyOnAProfile && state.currentProfileUid && state.currentProfileUid !== uid) {
    profileTrail.push(state.currentProfileUid);
  }

  // A profile opened from a chat used to render UNDERNEATH it — the
  // chat sits at a higher layer — so nothing appeared to happen, and
  // the profile was then left stranded once the chat closed. Tear the
  // chat down first and let switchScreen own the swap.
  if (state.currentChat) closeChat({ silent: true });

  state.currentProfileUid = uid;
  switchScreen("profileScreen");
  document.querySelector(".topbar")?.classList.remove("hidden");
  history.pushState({ screen: "profile" }, "", window.location.href);
  loadProfileUI(uid);
}

/**
 * Back out of a profile. One step at a time along the trail; `all`
 * leaves for good, which is what a tab tap wants.
 */
export function closeProfileScreen({ all = false } = {}) {
  if (!all && profileTrail.length) {
    const previous = profileTrail.pop();
    state.currentProfileUid = previous;
    loadProfileUI(previous);
    return;
  }

  profileTrail.length = 0;
  if (state.profileEventsUnsubscribe) {
    state.profileEventsUnsubscribe();
    state.profileEventsUnsubscribe = null;
  }
  state.currentProfileUid = "";
  switchScreen("home");
}

/* ---------------------------------------------------------------------
   HOSTED / JOINED
   ---------------------------------------------------------------------
   This used to be a flat list of titles under "Hosted Events", and it
   cost more than it showed: a live listener over every event the person
   ever hosted, PLUS a second get() of the same documents just to count
   them, PLUS a get() of everything they joined — whose number also
   counted the events they hosted, because a host is in their own
   participant list.

   Now it is two plain get()s, once per profile open. The lists and the
   numbers above them come from the same documents, so they can't
   disagree. Nothing here needs to be realtime; you are looking at a
   history.
   ------------------------------------------------------------------- */

const profileEvents = { uid: "", tab: "hosted", hosted: [], joined: [], joinedLocked: false, loaded: false };

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Tomorrow", "Yesterday", "Sat", "12 Sep", "12 Sep 2025". */
function dayLabel(ms, now) {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const d = new Date(ms);
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "short" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

function sinceLabel(ms, now) {
  const mins = Math.max(1, Math.round((now - ms) / 60000));
  if (mins < 60) return `Started ${mins}m ago`;
  return `Started ${Math.round(mins / 60)}h ago`;
}

function phaseOf(e, now) {
  if (e.expiresAt <= now) return "past";
  return now >= e.startTime ? "live" : "soon";
}

/** Live first, then soonest upcoming, then most recently ended. */
function sortForProfile(events, now) {
  const rank = { live: 0, soon: 1, past: 2 };
  return events.slice().sort((a, b) => {
    const pa = phaseOf(a, now), pb = phaseOf(b, now);
    if (pa !== pb) return rank[pa] - rank[pb];
    if (pa === "soon") return a.startTime - b.startTime;
    if (pa === "live") return b.startTime - a.startTime;
    return b.expiresAt - a.expiresAt;
  });
}

function profileEventRow(e, now, kind) {
  const id = safeId(e.id);
  const phase = phaseOf(e, now);
  const vibe = vibeColor(e.tag);
  const glyph = escapeHtml((e.tag || "").trim().split(" ")[0] || "✨");
  const guests = withoutBlocked((e.participantUids || []).filter((u) => u !== e.hostUid)).length;

  let when;
  let chip;
  if (phase === "live") {
    when = sinceLabel(e.startTime, now);
    chip = `<span class="status-chip live"><span class="live-dot"></span> Live</span>`;
  } else if (phase === "soon") {
    when = `${dayLabel(e.startTime, now)}, ${clock(e.startTime)}`;
    chip = `<span class="status-chip soon">Soon</span>`;
  } else {
    const hoursAgo = Math.round((now - e.expiresAt) / 3600e3);
    const ago = hoursAgo < 1 ? "Just ended"
      : hoursAgo < 12 ? `Ended ${hoursAgo}h ago`
      : dayLabel(e.startTime, now);
    when = wasCalledOff(e) ? `Called off · ${dayLabel(e.expiresAt, now)}` : ago;
    chip = "";
  }

  // Who it involved, in the words that fit the tab.
  let people;
  if (kind === "joined") {
    people = `<i class='bx bx-user'></i> ${escapeHtml(displayNameFor(e.hostUid))}`;
  } else if (phase === "past") {
    people = guests ? `<i class='bx bx-group'></i> ${guests} went` : `<i class='bx bx-group'></i> Nobody else`;
  } else {
    people = `<i class='bx bx-group'></i> ${guests} going`;
  }

  // Live and upcoming open in the feed; a finished one opens in Recap
  // while it is still there. After that there is nowhere to take you,
  // so it isn't a button pretending to be one.
  const reachable = id && (phase !== "past" || inRecap(e, now, state.uid));
  const tag = reachable ? "button" : "div";
  const tap = reachable ? ` onclick="window.jumpToEvent('${id}')"` : "";

  return `
    <${tag} class="pe-row ${phase}${reachable ? " tappable" : ""}" style="--vibe:${vibe}"${tap}>
      <span class="pe-glyph">${glyph}</span>
      <span class="pe-body">
        <span class="pe-title">${escapeHtml(e.title)}</span>
        <span class="pe-sub">
          <span class="pe-when">${escapeHtml(when)}</span>
          <span class="pe-dot">·</span>
          <span class="pe-place"><i class='bx bx-map-pin'></i> ${escapeHtml(e.place)}</span>
        </span>
        <span class="pe-people">${people}</span>
      </span>
      <span class="pe-side">
        ${chip}
        ${reachable ? `<i class='bx bx-chevron-right pe-go'></i>` : ""}
      </span>
    </${tag}>`;
}

function paintProfileTabs() {
  const hostedCount = profileEvents.hosted.length;
  const joinedCount = profileEvents.joined.length;
  const loaded = profileEvents.loaded;

  document.querySelectorAll("#profileEventTabs .pe-tab").forEach((t) => {
    const on = t.dataset.pe === profileEvents.tab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });

  const hc = document.getElementById("peHostedCount");
  const jc = document.getElementById("peJoinedCount");
  if (hc) hc.innerText = loaded ? hostedCount : "";
  if (jc) jc.innerText = loaded && !profileEvents.joinedLocked ? joinedCount : "";

  const statHosted = document.getElementById("statEventsHosted");
  const statJoined = document.getElementById("statEventsJoined");
  if (statHosted) statHosted.innerText = loaded ? hostedCount : "-";
  if (statJoined) statJoined.innerText = !loaded ? "-" : profileEvents.joinedLocked ? "–" : joinedCount;
}

function paintProfileEvents() {
  const list = document.getElementById("myProfileEvents");
  if (!list) return;
  paintProfileTabs();
  if (!profileEvents.loaded) return;

  const now = Date.now();
  const isSelf = profileEvents.uid === state.uid;
  const kind = profileEvents.tab;

  if (kind === "joined" && profileEvents.joinedLocked) {
    list.innerHTML = `
      <div class="pe-empty">
        <span class="pe-empty-icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
        <b>This account is private</b>
        <span>Follow them to see what they've been going to.</span>
      </div>`;
    return;
  }

  const events = sortForProfile(profileEvents[kind], now);

  if (!events.length) {
    const copy = kind === "hosted"
      ? (isSelf
          ? { title: "You haven't hosted anything yet", sub: "Start something and it'll live here after it ends.", cta: true }
          : { title: "Nothing hosted yet", sub: "When they start something, it shows up here." })
      : (isSelf
          ? { title: "You haven't joined anything yet", sub: "Events you join from the feed collect here." }
          : { title: "Hasn't joined anything yet", sub: "Events they go to will show up here." });
    list.innerHTML = `
      <div class="pe-empty">
        <span class="pe-empty-icon"><i class='bx ${kind === "hosted" ? "bx-calendar-star" : "bx-calendar-check"}'></i></span>
        <b>${copy.title}</b>
        <span>${copy.sub}</span>
        ${copy.cta ? `<button class="pe-empty-cta" onclick="window.closeProfileScreen({ all: true }); window.openCreateScreen()"><i class='bx bx-plus'></i> Start an event</button>` : ""}
      </div>`;
    return;
  }

  let lastGroup = "";
  const labels = { live: "Happening now", soon: "Coming up", past: "Earlier" };
  list.innerHTML = events.map((e) => {
    const g = phaseOf(e, now);
    const head = g !== lastGroup ? `<div class="pe-group">${labels[g]}</div>` : "";
    lastGroup = g;
    return head + profileEventRow(e, now, kind);
  }).join("");
}

export function setProfileEventsTab(tab) {
  if (tab !== "hosted" && tab !== "joined") return;
  profileEvents.tab = tab;
  paintProfileEvents();
}

export async function loadUserEvents(targetUid) {
  const list = document.getElementById("myProfileEvents");
  if (!list) return;

  if (state.profileEventsUnsubscribe) {
    state.profileEventsUnsubscribe();
    state.profileEventsUnsubscribe = null;
  }

  const isSelf = targetUid === state.uid;
  // Where someone has been is more personal than what they host. On a
  // private account it is for followers — and not even fetched for
  // anyone else, so it costs nothing either.
  const joinedLocked = !isSelf && isPrivateAccount(targetUid) && !isFollowing(targetUid);

  const fresh = profileEvents.uid !== targetUid;
  Object.assign(profileEvents, {
    uid: targetUid,
    tab: fresh ? "hosted" : profileEvents.tab,
    hosted: [], joined: [], joinedLocked, loaded: false,
  });
  paintProfileTabs();
  list.innerHTML = `<div class="pe-skeleton"></div><div class="pe-skeleton"></div>`;

  const toEvents = (snap) => {
    const out = [];
    snap.forEach((doc) => out.push({ id: doc.id, ...doc.data() }));
    return out;
  };

  try {
    const [hostedSnap, joinedSnap] = await Promise.all([
      db.collection("events").where("hostUid", "==", targetUid).get(),
      joinedLocked
        ? Promise.resolve(null)
        : db.collection("events").where("participantUids", "array-contains", targetUid).get(),
    ]);
    if (state.currentProfileUid !== targetUid) return;

    const hosted = toEvents(hostedSnap).filter((e) => e.hostUid === targetUid);
    const joined = joinedSnap
      ? toEvents(joinedSnap).filter((e) =>
          e.hostUid !== targetUid                              // hosting isn't going
          && (e.participantUids || []).includes(targetUid)
          && !isBlocked(e.hostUid))                          // blocking is total
      : [];

    // Anything you can reach from here should already be in the cache
    // the feed and Recap draw from.
    hosted.concat(joined).forEach((e) => {
      if (!state.eventCache[e.id]) state.eventCache[e.id] = e;
    });

    Object.assign(profileEvents, { hosted, joined, loaded: true });
    if (joined.length) primeHosts(joined);
    paintProfileEvents();
  } catch (error) {
    console.error("Profile events error:", error.code || error.message);
    if (state.currentProfileUid !== targetUid) return;
    Object.assign(profileEvents, { loaded: true });
    list.innerHTML = `<div class="pe-empty"><b>Couldn't load events</b><span>Check your connection and reopen the profile.</span></div>`;
    paintProfileTabs();
  }
}

/** Host names on the Joined tab come from the profile cache. */
async function primeHosts(events) {
  const missing = [...new Set(events.map((e) => e.hostUid))].filter((u) => u && !state.userCache[u]);
  if (!missing.length) return;
  await Promise.all(missing.map((u) => fetchUser(u).catch(() => null)));
  if (state.currentProfileUid === profileEvents.uid) paintProfileEvents();
}

export async function loadProfileUI(targetUid) {
  if (!safeId(targetUid)) return;

  const avatarEl = document.getElementById("profileAvatarDisplay");
  const nameDisplay = document.getElementById("profileDisplayNameDisplay");
  const usernameDisplay = document.getElementById("profileUsernameDisplay");
  const settingsGear = document.getElementById("profileSettingsBtn");
  const editInput = document.getElementById("editDisplayNameInput");
  const statJoined = document.getElementById("statEventsJoined");
  const statHosted = document.getElementById("statEventsHosted");
  const statVouches = document.getElementById("statVouches");
  const statFollowers = document.getElementById("statFollowers");
  const statFollowing = document.getElementById("statFollowing");
  const eventsList = document.getElementById("myProfileEvents");

  // Placeholders while we fetch. innerText everywhere: no markup path.
  if (avatarEl) avatarEl.innerHTML = renderAvatar("\u{1F464}");
  if (nameDisplay) nameDisplay.innerText = "Loading...";
  if (usernameDisplay) usernameDisplay.innerText = "";
  const aboutEl = document.getElementById("profileAbout");
  if (aboutEl) { aboutEl.innerHTML = ""; aboutEl.classList.add("hidden"); }
  if (statJoined) statJoined.innerText = "-";
  if (statHosted) statHosted.innerText = "-";
  if (statVouches) statVouches.innerText = "-";
  if (statFollowers) statFollowers.innerText = "-";
  if (statFollowing) statFollowing.innerText = "-";
  if (eventsList) {
    eventsList.innerHTML = `<div class="pe-skeleton"></div><div class="pe-skeleton"></div>`;
  }

  const isSelf = targetUid === state.uid;
  settingsGear?.classList.toggle("hidden", !isSelf);
  // Forget which profile's events are on screen, so reopening one loads
  // them fresh rather than trusting what was there last time.
  profileEvents.uid = "";
  document.getElementById("profileLocked")?.classList.add("hidden");
  document.getElementById("profileScreen")?.classList.remove("profile-is-locked");
  renderSafetyActions(targetUid, isSelf);
  renderOrbitActions(targetUid, isSelf);

  try {
    await fetchUser(targetUid, { force: true });
    if (state.currentProfileUid !== targetUid) return;

    if (avatarEl) avatarEl.innerHTML = renderAvatar(avatarFor(targetUid));
    if (nameDisplay) nameDisplay.innerText = displayNameFor(targetUid);
    if (usernameDisplay) usernameDisplay.innerText = "@" + usernameFor(targetUid);
    renderOrbitActions(targetUid, isSelf);

    refreshProfileSocial(targetUid);

    if (isSelf) {
      state.userDisplayName = displayNameFor(targetUid);
      state.userAvatar = avatarFor(targetUid);
      if (editInput) editInput.value = state.userDisplayName;
    }

    // Hosted / Joined load from refreshProfileSocial above, once the
    // profile is known not to be locked.
  } catch (e) {
    console.error("Profile load error:", e.code || e.message);
    if (nameDisplay) nameDisplay.innerText = "Could not load profile";
  }
}

// ---------- Settings ----------
export function openSettingsScreen() {
  openOverlay("settingsScreen");
  syncThemeUI();
  refreshBlockedList();
  syncPrivacyUI();

  const nameInput = document.getElementById("editDisplayNameInput");
  if (nameInput) nameInput.value = state.userDisplayName || displayNameFor(state.uid);

  const me = state.userCache[state.uid] || {};
  const bioInput = document.getElementById("editBioInput");
  if (bioInput) bioInput.value = cleanBio(me.bio);
  pendingInterests = cleanInterests(me.interests);
  onBioInput();
  renderInterestPicker();

  state.pendingSettingsAvatar = state.userAvatar;
  document.querySelectorAll("#settingsAvatarGrid .avatar-option").forEach((el) => {
    el.classList.toggle("selected", el.innerText === state.userAvatar);
  });
}

let pendingInterests = [];

export function onBioInput() {
  const el = document.getElementById("editBioInput");
  const count = document.getElementById("bioCount");
  if (!el || !count) return;
  const n = el.value.length;
  count.innerText = `${n}/${BIO_MAX}`;
  count.classList.toggle("near", n > BIO_MAX - 20);
}

function renderInterestPicker() {
  const grid = document.getElementById("settingsInterests");
  const count = document.getElementById("interestCount");
  if (count) count.innerText = `${pendingInterests.length}/${INTERESTS_MAX}`;
  if (!grid) return;
  const full = pendingInterests.length >= INTERESTS_MAX;
  grid.innerHTML = INTERESTS.map((t, i) => {
    const on = pendingInterests.includes(t);
    return `<button type="button" class="interest-chip pick${on ? " on" : ""}" style="--vibe:${vibeColor(t)}"
      aria-pressed="${on}" ${!on && full ? "disabled" : ""} onclick="window.toggleInterest(${i})">${escapeHtml(t)}</button>`;
  }).join("");
}

/** Takes an index, never the label — inline handlers get no text. */
export function toggleInterest(index) {
  const t = INTERESTS[index];
  if (!t) return;
  if (pendingInterests.includes(t)) pendingInterests = pendingInterests.filter((x) => x !== t);
  else if (pendingInterests.length < INTERESTS_MAX) pendingInterests = pendingInterests.concat([t]);
  renderInterestPicker();
}

export function closeSettingsScreen() {
  closeOverlay("settingsScreen");
}

export function selectSettingsAvatar(element, avatarChoice) {
  document.querySelectorAll("#settingsAvatarGrid .avatar-option").forEach((el) => el.classList.remove("selected"));

  if (avatarChoice === "google") {
    state.pendingSettingsAvatar = auth.currentUser?.photoURL || state.googlePfp || "\u{1F464}";
    const originalText = element.innerHTML;
    element.innerHTML = "<i class='bx bx-check'></i> Selected!";
    setTimeout(() => { element.innerHTML = originalText; }, 1500);
    return;
  }

  if (!ALLOWED_AVATARS.includes(avatarChoice)) return;
  state.pendingSettingsAvatar = avatarChoice;
  element.classList.add("selected");
}

export async function saveProfileData() {
  const nameInput = document.getElementById("editDisplayNameInput");
  const btn = document.getElementById("saveProfileBtn");
  const newName = (nameInput?.value || "").trim().slice(0, 20);

  if (!newName) return toast("Your display name can't be empty.");
  if (!auth.currentUser) return;

  const originalText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
    btn.disabled = true;
  }

  try {
    const avatar = state.pendingSettingsAvatar || state.userAvatar;

    // Note: `username` is deliberately absent. Handles are immutable —
    // the rules reject any attempt to change one after it is claimed.
    const bio = cleanBio(document.getElementById("editBioInput")?.value);
    const interests = cleanInterests(pendingInterests);

    await db.collection("users").doc(state.uid).set({
      displayName: newName,
      avatar,
      bio,
      interests,
      updatedAt: Date.now()
    }, { merge: true });

    state.userDisplayName = newName;
    state.userAvatar = avatar;
    if (state.userCache[state.uid]) {
      Object.assign(state.userCache[state.uid], { displayName: newName, avatar, bio, interests });
      rememberUser(state.uid, state.userCache[state.uid]);
    }
    if (state.currentProfileUid === state.uid) renderAbout(state.uid);

    const displayEl = document.getElementById("profileDisplayNameDisplay");
    if (displayEl) displayEl.innerText = newName;
    const sideNameEl = document.getElementById("sideName");
    if (sideNameEl) sideNameEl.innerText = newName;
    applyAvatarEverywhere(avatar);

    if (btn) {
      btn.style.background = "var(--periwinkle)";
      btn.innerHTML = `<i class='bx bx-check'></i> Saved!`;
      setTimeout(() => {
        btn.style.background = "";
        btn.innerHTML = originalText;
        btn.disabled = false;
        closeSettingsScreen();
      }, 800);
    }
  } catch (e) {
    console.error("Profile save error:", e.code, e.message);
    toast(e.code === "permission-denied"
      ? "That change wasn't allowed. Try again."
      : "Couldn't save your profile.");
    if (btn) {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }
}


/* ---------------------------------------------------------------------
   Safety actions
   ------------------------------------------------------------------- */

/**
 * The three numbers, and the follow button. Split out so following
 * somebody can update the profile in place instead of reloading it.
 *
 * Followers is the one that carries weight: the rules let only the
 * follower write their own uid into it, so it is the single social
 * number on a profile that its owner could not have inflated. Vouches
 * sits beside it as the stronger, rarer version of the same idea.
 */
/**
 * Bio and interests, under the name. Shown to everyone — a private
 * account still says who it is. Your own empty profile gets a nudge to
 * fill it in instead of a blank space.
 */
function renderAbout(targetUid) {
  const host = document.getElementById("profileAbout");
  if (!host) return;
  const u = state.userCache[targetUid] || {};
  const bio = cleanBio(u.bio);
  const interests = cleanInterests(u.interests);
  const isSelf = targetUid === state.uid;

  if (!bio && !interests.length) {
    host.classList.toggle("hidden", !isSelf);
    host.innerHTML = isSelf
      ? `<button class="about-add" onclick="window.openSettingsScreen()">
           <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
           Add a bio and what you're into
         </button>`
      : "";
    return;
  }

  host.classList.remove("hidden");
  host.innerHTML = `
    ${bio ? `<p class="profile-bio">${escapeHtml(bio)}</p>` : ""}
    ${interests.length ? `<div class="interest-row">${interests.map((t) =>
      `<span class="interest-chip" style="--vibe:${vibeColor(t)}">${escapeHtml(t)}</span>`).join("")}</div>` : ""}`;
}

export function refreshProfileSocial(targetUid) {
  if (!targetUid || state.currentProfileUid !== targetUid) return;

  renderAbout(targetUid);

  const followers = document.getElementById("statFollowers");
  const following = document.getElementById("statFollowing");
  const vouches = document.getElementById("statVouches");

  if (followers) followers.innerText = followerCount(targetUid);
  if (following) following.innerText = followingCount(targetUid);
  if (vouches) vouches.innerText = vouchCount(targetUid);

  renderOrbitActions(targetUid, targetUid === state.uid);

  applyProfileLock(targetUid);
}

/**
 * A private account you don't follow shows its name, its follower and
 * following counts, and a way to ask. Nothing else: not the lists
 * behind the counts, not vouches, not events, not the orbit button.
 * Being let in (or following) opens the rest in place, and unfollowing
 * closes it again.
 */
export function isProfileLocked(uid) {
  return !!uid
    && uid !== state.uid
    && !isBlocked(uid)
    && isPrivateAccount(uid)
    && !isFollowing(uid);
}

function applyProfileLock(targetUid) {
  const locked = isProfileLocked(targetUid);
  document.getElementById("profileScreen")?.classList.toggle("profile-is-locked", locked);

  const badge = document.getElementById("profilePrivate");
  if (badge) badge.classList.toggle("hidden", !isPrivateAccount(targetUid));

  const panel = document.getElementById("profileLocked");
  if (panel) {
    panel.classList.toggle("hidden", !locked);
    const text = document.getElementById("profileLockedText");
    if (text && locked) {
      text.innerText = hasAskedToFollow(targetUid)
        ? "You've asked to follow " + displayNameFor(targetUid) + ". Once they say yes you'll see their events, who they follow, and their orbit."
        : "Follow " + displayNameFor(targetUid) + " to see their events, who they follow, and their orbit.";
    }
  }

  // Events are only fetched for a profile you're allowed to see — a
  // locked one costs no event reads at all. They load the moment it
  // opens up, and not again after.
  if (!locked && profileEvents.uid !== targetUid) loadUserEvents(targetUid);
}

/**
 * The orbit half of a profile. On your own it is the rings and a way
 * into the Orbit screen; on someone else's it is where you stand with
 * them, their vouches, and — once you are linked — your own vouch.
 */
export function renderOrbitActions(targetUid, isSelf) {
  const host = document.getElementById("profileOrbit");
  const rings = document.getElementById("profileRings");
  if (!host) return;

  const id = safeId(targetUid);
  if (!id) return;

  const requestsHost = document.getElementById("profileRequests");
  if (requestsHost) {
    const waitingToFollow = isSelf ? myFollowRequests().length : 0;
    requestsHost.classList.toggle("hidden", !waitingToFollow);
    requestsHost.innerHTML = waitingToFollow
      ? `<button class="orbit-cta" onclick="window.openProfileList('requests')">
           <i class='bx bx-user-voice'></i>
           <span class="orbit-cta-text">
             <b>${waitingToFollow} ${waitingToFollow === 1 ? "person wants" : "people want"} to follow you</b>
             <small>Your account is private, so they're waiting on you</small>
           </span>
           <span class="orbit-count">${waitingToFollow}</span>
         </button>`
      : "";
  }

  if (isSelf) {
    const n = state.orbitUids.length;
    const waiting = state.orbitIncoming.length;
    host.classList.remove("hidden");
    host.innerHTML = `
      <button class="orbit-cta" onclick="window.openOrbitScreen()">
        <i class='bx bx-planet'></i>
        <span class="orbit-cta-text">
          <b>${n} in your orbit</b>
          <small>${waiting ? waiting + (waiting === 1 ? " request waiting" : " requests waiting") : "People you'd show up for"}</small>
        </span>
        ${waiting ? `<span class="orbit-count">${waiting}</span>` : `<i class='bx bx-chevron-right'></i>`}
      </button>`;
    renderOrbitRings(rings, state.orbitUids, n);
    return;
  }

  // Clear the stamp with the contents, or renderOrbitRings will think
  // its work is already on screen when it isn't.
  if (rings) {
    rings.innerHTML = "";
    rings.classList.add("hidden");
    delete rings.dataset.signature;
  }

  if (isBlocked(targetUid)) {
    host.innerHTML = "";
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");
  const status = orbitStatus(targetUid);
  const known = vouchersYouKnow(targetUid);
  const total = vouchCount(targetUid);

  // The light action sits next to the deliberate one: follow to keep
  // up with someone, orbit for the people you'd actually show up for.
  const following = isFollowing(targetUid);
  const asked = hasAskedToFollow(targetUid);
  let followLabel = "Follow";
  let followIcon = "bx-plus";
  let followClass = "primary";
  if (following) {
    followLabel = "Following"; followIcon = "bx-check"; followClass = "following";
  } else if (asked) {
    followLabel = "Requested"; followIcon = "bx-time-five"; followClass = "pending";
  } else if (isPrivateAccount(targetUid)) {
    followLabel = "Ask to follow"; followIcon = "bx-lock-open-alt";
  }
  const followBtn = `<button class="orbit-btn ${followClass}" onclick="window.toggleFollow('${id}')"><i class='bx ${followIcon}'></i> ${followLabel}</button>`;

  let action;
  if (status === "linked") {
    action = `<button class="orbit-btn linked" onclick="window.confirmLeaveOrbit('${id}')"><i class='bx bx-check-circle'></i> In your orbit</button>`;
  } else if (status === "outgoing") {
    // Not "Requested": that is the follow button's word, and the two sat
    // side by side looking identical, so withdrawing one read as the
    // other disappearing.
    action = `<button class="orbit-btn pending" onclick="window.declineOrbit('${id}')"><i class='bx bx-time-five'></i> Orbit asked</button>`;
  } else if (status === "incoming") {
    action = `
      <button class="orbit-btn primary" onclick="window.acceptOrbit('${id}')"><i class='bx bx-user-check'></i> Accept</button>
      <button class="orbit-btn" onclick="window.declineOrbit('${id}')">Ignore</button>`;
  } else if (following) {
    action = `<button class="orbit-btn primary" onclick="window.pullIn('${id}')"><i class='bx bx-user-plus'></i> Pull into orbit</button>`;
  } else {
    // Orbit comes after following, public or private: you follow
    // someone first, and pull them in later if they're more than that.
    action = "";
  }

  // The trust line. "3 people you know" is worth far more here than a
  // raw total, so it leads, and the total only fills in behind it.
  let trust = "";
  if (known.length) {
    trust = `<div class="vouch-line strong"><i class='bx bxs-badge-check'></i> Vouched for by <b>${known.length}</b> ${known.length === 1 ? "person" : "people"} in your orbit</div>`;
  } else if (total) {
    trust = `<div class="vouch-line"><i class='bx bx-badge-check'></i> Vouched for by ${total} ${total === 1 ? "student" : "students"}</div>`;
  }

  const vouch = status === "linked"
    ? `<button class="orbit-btn ${hasVouched(targetUid) ? "vouched" : ""}" onclick="window.toggleVouch('${id}')"><i class='bx ${hasVouched(targetUid) ? "bxs-badge-check" : "bx-badge-check"}'></i> ${hasVouched(targetUid) ? "You vouched" : "Vouch for them"}</button>`
    : "";

  const locked = isProfileLocked(targetUid);
  const hint = !following && status === "none" && !locked
    ? `<p class="orbit-hint">Follow ${escapeHtml(displayNameFor(targetUid))} first, then you can pull them into your orbit.</p>`
    : "";

  host.innerHTML = `<div class="orbit-actions">${followBtn}${action}</div>`
    + (vouch ? `<div class="orbit-actions second">${vouch}</div>` : "")
    // Vouches are part of what a locked profile keeps to itself.
    + (locked ? "" : trust)
    + hint;
}

/** Block / report controls, shown only on someone else's profile. */
function renderSafetyActions(targetUid, isSelf) {
  const host = document.getElementById("profileSafety");
  if (!host) return;

  if (isSelf) {
    host.innerHTML = "";
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");
  const blocked = isBlocked(targetUid);
  const id = safeId(targetUid);

  host.innerHTML = blocked
    ? `<p class="settings-hint">You've blocked this person. You won't see each other anywhere.</p>
       <button class="btn-ghost" onclick="window.confirmUnblock('${id}')"><i class='bx bx-user-check'></i> Unblock</button>`
    : `<button onclick="window.messageFromProfile('${id}')"><i class='bx bx-message-rounded-dots'></i> Message</button>
       <div class="safety-row">
         <button class="btn-ghost" onclick="window.openReport('${id}')"><i class='bx bx-flag'></i> Report</button>
         <button class="btn-ghost danger-text" onclick="window.confirmBlock('${id}')"><i class='bx bx-block'></i> Block</button>
       </div>`;
}

export async function confirmBlock(targetUid) {
  const name = displayNameFor(targetUid);
  const yes = await askConfirm({
    title: "Block " + name + "?",
    body: "You won't see each other anywhere — not in the feed, not in messages, and neither of you can join the other's events. They are never told.",
    confirm: "Block",
    danger: true
  });
  if (!yes) return;

  // Undo the follow graph first, while the rules still see no block.
  await severFollow(targetUid);
  blockUser(targetUid).then((ok) => {
    if (!ok) return toast("Couldn't block right now. Check your connection.");
    // The blocks listener re-renders everything; just leave the profile.
    closeProfileScreen();
  });
}

export async function confirmUnblock(targetUid) {
  const name = displayNameFor(targetUid);
  const yes = await askConfirm({
    title: "Unblock " + name + "?",
    body: "You'll both be able to see and message each other again.",
    confirm: "Unblock"
  });
  if (!yes) return;
  unblockUser(targetUid).then((ok) => {
    if (!ok) return toast("Couldn't unblock right now.");
    renderSafetyActions(targetUid, false);
  });
}

/* ---------------------------------------------------------------------
   Reporting
   ------------------------------------------------------------------- */

const REPORT_REASONS = [
  "Harassment or bullying",
  "Threats or violence",
  "Sexual or explicit content",
  "Impersonation",
  "Spam or scam",
  "Something else"
];

export function openReport(targetUid) {
  const modal = document.getElementById("reportModal");
  if (!modal) return;

  modal.dataset.target = safeId(targetUid);
  const who = document.getElementById("reportWho");
  if (who) who.innerText = `@${usernameFor(targetUid)}`;

  const list = document.getElementById("reportReasons");
  if (list) {
    list.innerHTML = REPORT_REASONS.map((r, i) =>
      `<button class="reason-pill${i === 0 ? " selected" : ""}" onclick="window.pickReason(this)">${escapeHtml(r)}</button>`
    ).join("");
  }

  const note = document.getElementById("reportNote");
  if (note) note.value = "";
  openOverlay("reportModal");
}

export function closeReport() {
  closeOverlay("reportModal");
}

export function pickReason(el) {
  document.querySelectorAll("#reportReasons .reason-pill").forEach((p) => p.classList.remove("selected"));
  el.classList.add("selected");
}

export async function sendReport() {
  const modal = document.getElementById("reportModal");
  const btn = document.getElementById("reportSubmit");
  if (!modal) return;

  const targetUid = modal.dataset.target;
  const reason = document.querySelector("#reportReasons .reason-pill.selected")?.innerText || REPORT_REASONS[0];
  const note = document.getElementById("reportNote")?.value || "";

  if (btn) { btn.disabled = true; btn.innerHTML = "Sending..."; }

  const ok = await submitReport({ targetUid, reason, note });

  if (btn) { btn.disabled = false; btn.innerHTML = "Send report"; }
  closeReport();

  if (!ok) return toast("Couldn't send the report. Check your connection.");

  if (await askConfirm({
        title: "Report sent",
        body: "Thanks — the admin will take a look. Do you want to block this person as well?",
        confirm: "Block them too",
        cancel: "No thanks",
        danger: true
      })) {
    confirmBlock(targetUid);
  }
}

/* ---------------------------------------------------------------------
   Blocked list, in Settings, so a block can always be undone
   ------------------------------------------------------------------- */

export async function refreshBlockedList() {
  const box = document.getElementById("blockedList");
  if (!box) return;

  box.innerHTML = `<p class="settings-hint">Loading...</p>`;
  const uids = await myBlockList();

  if (!uids.length) {
    box.innerHTML = `<p class="settings-hint">You haven't blocked anyone.</p>`;
    return;
  }

  await Promise.all(uids.map((u) => fetchUser(u)));
  box.innerHTML = uids.map((uid) => {
    const id = safeId(uid);
    return `
      <div class="blocked-row">
        <div class="chat-avatar" style="width:34px;height:34px;font-size:16px;">${renderAvatar(avatarFor(uid))}</div>
        <div style="flex:1;min-width:0;">
          <div class="blocked-name">${escapeHtml(displayNameFor(uid))}</div>
          <div class="settings-hint" style="margin:0;">@${escapeHtml(usernameFor(uid))}</div>
        </div>
        <button class="btn-ghost" style="width:auto;padding:7px 14px;font-size:13px;" onclick="window.confirmUnblock('${id}')">Unblock</button>
      </div>`;
  }).join("");
}


/** Message someone from their profile. */
export function messageFromProfile(targetUid) {
  const uid = safeId(targetUid);
  if (!uid) return;
  closeProfileScreen();
  startChatWithUid(uid);
}


/**
 * From a profile, jump to one of their events: the feed if it's on or
 * coming up, Recap if it has finished and is still there.
 */
export function jumpToEvent(eventId) {
  const e = state.eventCache[eventId];
  const now = Date.now();
  const toRecap = !!e && e.expiresAt <= now;

  // `all`: from three profiles deep, this used to step back one profile
  // and never reach the feed at all.
  closeProfileScreen({ all: true });

  setTimeout(async () => {
    if (!toRecap) {
      showTab("events");
      focusEvent(eventId);
      return;
    }
    if (!inRecap(e, now, state.uid)) return;

    showTab("recap");
    if (!state.recapOrder.length && !state.recapDone) await loadRecap({ reset: true });

    // Not paged in yet: slot it in where it belongs by end time. The
    // pager skips ids it already has, so it won't turn up twice.
    if (!state.recapOrder.includes(eventId)) {
      const at = state.recapOrder.findIndex((id) => (state.eventCache[id]?.expiresAt || 0) < e.expiresAt);
      if (at === -1) state.recapOrder.push(eventId);
      else state.recapOrder.splice(at, 0, eventId);
      renderEvents();
    }
    setTimeout(() => focusEvent(eventId), 60);
  }, 80);
}
