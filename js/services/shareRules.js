// ==========================================
// EVENT LINKS
// ==========================================
//
// Pure functions, no imports — the fourth file of this kind after
// recapRules, messageRules and receiptRules, and for the same reason:
// a link is the one thing here that outlives the app. Somebody pastes
// it into WhatsApp today and taps it next week. The parsing has to be
// exact and it has to be testable without a browser.
//
// WHY THE CANONICAL LINK IS A QUERY PARAM. `livesociya.com/e/AbC123`
// is prettier, and it 404s: nothing in this repo configures a hosting
// rewrite (firebase.json has no `hosting` block), so a static host
// looks for a file at that path and does not find one. `?e=AbC123`
// works on every host today with no configuration at all. The parser
// accepts the path form as well, so the day somebody does add a
// rewrite, every link already in the wild keeps working and the
// canonical form can change with one line.
// ==========================================

export const SITE = "https://livesociya.com";

/** Firebase document ids, and nothing else. */
export function isEventId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ""));
}

/** The link we hand out. */
export function eventLink(eventId, site = SITE) {
  return isEventId(eventId) ? `${site}/?e=${eventId}` : "";
}

/**
 * The event id in a URL, or "".
 *
 * Deliberately strict about the host: this is also what decides
 * whether a link pasted into a chat renders as an event card, so a
 * lookalike domain must not be able to dress itself up as one. Only
 * livesociya.com, its subdomains, and localhost while developing.
 */
export function isOurHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "livesociya.com"
    || h.endsWith(".livesociya.com")
    || h === "localhost"
    || h === "127.0.0.1";
}

export function eventIdFromUrl(raw) {
  let u;
  try {
    u = new URL(String(raw), SITE);
  } catch (e) {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (!isOurHost(u.hostname)) return "";

  // ?e=<id> — the canonical form.
  const q = u.searchParams.get("e");
  if (isEventId(q)) return q;

  // /e/<id> — accepted for the day a rewrite exists.
  const m = u.pathname.match(/^\/e\/([A-Za-z0-9_-]{1,128})\/?$/);
  if (m) return m[1];

  return "";
}

/**
 * The first event link in a piece of text, or "". Used to decide
 * whether a message is really "here is an event" rather than a
 * sentence that happens to contain a link.
 */
export function firstEventLink(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<]+/g) || [];
  for (const m of matches) {
    const id = eventIdFromUrl(m);
    if (id) return { url: m, id };
  }
  return null;
}

/** What goes in the native share sheet. */
export function shareText(event) {
  const title = String((event && event.title) || "Something on campus").trim();
  const place = String((event && event.place) || "").trim();
  return place ? `${title} — ${place}` : title;
}
