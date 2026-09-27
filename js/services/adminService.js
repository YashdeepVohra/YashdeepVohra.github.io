/**
 * REPORT TRIAGE — the admin's screen.
 *
 * The admin is whoever has a document at admins/{uid}, made by hand in
 * the Firebase console (docs/photos.md, "Reports"). The app asks once
 * per sign-in whether YOU are one (a single get the rules allow only
 * about yourself) and shows the way in, in Settings, only if so.
 *
 * Each report says who it is about, what kind of thing (a person, an
 * event, a message, a comment, a memory photo, a story), the reason,
 * the reporter's note, and a COPY of what was said or shown — so a
 * message can be judged without the admin being able to read anybody's
 * conversation. Three outcomes, each recorded on the report:
 *   Remove   takes the thing down (not possible for a direct message:
 *            nobody outside a conversation can touch it — ban instead)
 *   Ban      the person can still read, but can no longer publish
 *   Dismiss  nothing wrong
 */
import { db, FieldValue } from '../config/firebase.js';
import { state } from '../state/store.js';
import { toast } from '../utils/ui.js';
import { askConfirm } from '../utils/confirm.js';
import { openOverlay, closeOverlay } from '../utils/overlays.js';
import { escapeHtml, safeId, formatInboxTime, msOf } from '../utils/formatters.js';
import { displayNameFor, usernameFor, primeUsers, fetchUser } from './userService.js';

let reports = [];
let showAll = false;
let loading = false;

export async function checkAdmin() {
  state.isAdmin = false;
  document.body.classList.remove("is-admin");
  if (!state.uid) return;
  try {
    const doc = await db.collection("admins").doc(state.uid).get();
    state.isAdmin = doc.exists;
    document.body.classList.toggle("is-admin", doc.exists);
  } catch (e) {
    // Not an admin, or offline: either way, no way in.
  }
}

export function openAdminScreen() {
  if (!state.isAdmin) return;
  openOverlay("adminScreen");
  loadReports();
}

export function closeAdminScreen() {
  closeOverlay("adminScreen");
}

export function toggleAdminFilter() {
  showAll = !showAll;
  paint();
}

async function loadReports() {
  if (loading) return;
  loading = true;
  paint();
  try {
    const snap = await db.collection("reports").orderBy("createdAt", "desc").limit(50).get();
    reports = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    await primeUsers([...new Set(reports.flatMap((r) => [r.targetUid, r.reporterUid]).filter(Boolean))]).catch(() => {});
  } catch (e) {
    console.error("Reports failed:", e.code || e.message);
    toast("Couldn't load reports.");
  } finally {
    loading = false;
    paint();
  }
}

const KIND = { user: "Person", event: "Event", message: "Message", comment: "Comment", memory: "Memory photo", story: "Story" };
const REMOVABLE = ["event", "comment", "memory", "story"];

function excerptHtml(text) {
  const lines = String(text || "").split("\n").filter(Boolean);
  return lines.map((l) => /^https:\/\/firebasestorage\.googleapis\.com\//.test(l)
    ? `<img class="ar-photo" src="${escapeHtml(l)}" alt="Reported photo" loading="lazy" onclick="window.openPhoto(this.src)">`
    : `<p class="ar-text">${escapeHtml(l)}</p>`).join("");
}

function paint() {
  const box = document.getElementById("adminReports");
  const toggle = document.getElementById("adminFilter");
  if (toggle) toggle.innerText = showAll ? "Show open only" : "Show all";
  if (!box) return;
  if (loading && !reports.length) { box.innerHTML = `<p class="settings-hint">Loading…</p>`; return; }
  const list = reports.filter((r) => showAll || !r.status);
  if (!list.length) {
    box.innerHTML = `<p class="settings-hint">${showAll ? "No reports yet." : "Nothing waiting. Every report has been handled."}</p>`;
    return;
  }
  box.innerHTML = list.map((r) => {
    const id = safeId(r.id);
    const who = safeId(r.targetUid);
    const type = KIND[r.targetType] ? r.targetType : "user";
    const banned = state.userCache[r.targetUid] && state.userCache[r.targetUid].banned === true;
    return `
      <div class="card ar${r.status ? " handled" : ""}">
        <div class="ar-head">
          <span class="ar-kind">${escapeHtml(KIND[type])}</span>
          <span class="ar-when">${escapeHtml(formatInboxTime(msOf(r.createdAt)))}</span>
          ${r.status ? `<span class="ar-status">${escapeHtml(r.status)}</span>` : ""}
        </div>
        <div class="ar-reason">${escapeHtml(r.reason || "")}</div>
        <div class="ar-about">About <b class="tappable" onclick="window.openProfileScreen('${who}')">${escapeHtml(displayNameFor(r.targetUid))}</b> @${escapeHtml(usernameFor(r.targetUid))}${banned ? " · banned" : ""}</div>
        ${r.excerpt ? `<div class="ar-excerpt">${excerptHtml(r.excerpt)}</div>` : ""}
        ${r.note ? `<div class="ar-note">“${escapeHtml(r.note)}”</div>` : ""}
        <div class="ar-by">Reported by @${escapeHtml(usernameFor(r.reporterUid))}</div>
        ${r.status ? "" : `
        <div class="ar-acts">
          ${REMOVABLE.includes(type) ? `<button type="button" class="ar-btn danger" onclick="window.adminRemove('${id}')">Remove</button>` : ""}
          <button type="button" class="ar-btn danger" onclick="window.adminBan('${id}')">${banned ? "Unban" : "Ban"}</button>
          <button type="button" class="ar-btn" onclick="window.adminDismiss('${id}')">Dismiss</button>
        </div>`}
      </div>`;
  }).join("");
}

async function mark(report, status) {
  await db.collection("reports").doc(report.id).update({
    status, handledAt: FieldValue.serverTimestamp(), handledBy: state.uid
  });
  report.status = status;
  paint();
}

export async function adminDismiss(reportId) {
  const r = reports.find((x) => x.id === reportId);
  if (!r) return;
  try { await mark(r, "dismissed"); } catch (e) { toast("Couldn't update that report."); }
}

/** Where the reported thing lives, from the report's type and id. */
function pathOf(r) {
  const id = String(r.targetId || "");
  const cut = id.indexOf("_");
  if (r.targetType === "event" && safeId(id)) return `events/${id}`;
  if (r.targetType === "story" && safeId(id)) return `stories/${id}`;
  if ((r.targetType === "comment" || r.targetType === "memory") && cut > 0) {
    const eventId = id.slice(0, cut), rest = id.slice(cut + 1);
    if (!safeId(eventId) || !safeId(rest)) return "";
    return `events/${eventId}/${r.targetType === "comment" ? "comments" : "memories"}/${rest}`;
  }
  return "";
}

export async function adminRemove(reportId) {
  const r = reports.find((x) => x.id === reportId);
  const path = r && pathOf(r);
  if (!path) return toast("That can't be removed from here.");
  const yes = await askConfirm({
    title: `Remove this ${(KIND[r.targetType] || "thing").toLowerCase()}?`,
    body: "It comes down for everyone. The report is marked as handled.",
    confirm: "Remove", danger: true
  });
  if (!yes) return;
  try {
    await db.doc(path).delete();
    await mark(r, "removed");
    toast("Removed.");
  } catch (e) {
    console.error("Remove failed:", e.code || e.message);
    toast("Couldn't remove that.");
  }
}

export async function adminBan(reportId) {
  const r = reports.find((x) => x.id === reportId);
  if (!r || !safeId(r.targetUid)) return;
  const user = state.userCache[r.targetUid] || await fetchUser(r.targetUid).catch(() => null) || {};
  const ban = user.banned !== true;
  const yes = await askConfirm({
    title: ban ? `Ban @${usernameFor(r.targetUid)}?` : `Unban @${usernameFor(r.targetUid)}?`,
    body: ban
      ? "They can still open the app and read, but can't post events, stories, memories or comments, and are signed out with a notice."
      : "They can post again.",
    confirm: ban ? "Ban" : "Unban", danger: ban
  });
  if (!yes) return;
  try {
    await db.collection("users").doc(r.targetUid).update({ banned: ban });
    if (state.userCache[r.targetUid]) state.userCache[r.targetUid].banned = ban;
    if (ban) await mark(r, "banned");
    else paint();
    toast(ban ? "Banned." : "Unbanned.");
  } catch (e) {
    console.error("Ban failed:", e.code || e.message);
    toast("Couldn't change that.");
  }
}
