/**
 * Stories, the pure half: how long one lasts, whose ring comes first,
 * and which song links are allowed. No DOM, no Firebase.
 * firestore.rules repeats STORY_HOURS, CAPTION_MAX and the song hosts.
 */
import { msOf } from '../utils/formatters.js';

/** The choices, in hours. 24 is the most — a story is a day, not a post. */
export const STORY_HOURS = [2, 3, 6, 12, 24];
export const DEFAULT_HOURS = 24;
export const CAPTION_MAX = 150;
export const SONG_TITLE_MAX = 100;
const HOUR = 3600 * 1000;

/** When it goes. `createdAt` is the server's stamp; `hours` the author's choice. */
export function storyEndsAt(s) {
  const start = msOf(s && s.createdAt);
  const hours = STORY_HOURS.includes(s && s.hours) ? s.hours : DEFAULT_HOURS;
  return start ? start + hours * HOUR : 0;
}

export function isStoryLive(s, now = Date.now()) {
  const end = storyEndsAt(s);
  return !!end && end > now;
}

/** "3h left", "40m left", "under a minute left". */
export function leftLabel(s, now = Date.now()) {
  const left = storyEndsAt(s) - now;
  if (left <= 0) return "gone";
  const mins = Math.ceil(left / 60000);
  if (mins <= 1) return "under a minute left";
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h left`;
}

/**
 * The rail: one ring per person, never one per story. Yours first,
 * then anyone with something you haven't seen, newest first; then the
 * ones you've seen all of. Each person's stories play oldest first,
 * the way they were told.
 */
export function storyRings(stories, { me, seen = new Set(), hidden = () => false, blocked = () => false, now = Date.now() } = {}) {
  const byUid = new Map();
  stories.forEach((s) => {
    if (!s || !s.uid || !isStoryLive(s, now) || blocked(s.uid) || hidden(s.id)) return;
    if (!byUid.has(s.uid)) byUid.set(s.uid, []);
    byUid.get(s.uid).push(s);
  });
  const rings = [...byUid.entries()].map(([uid, list]) => {
    list.sort((a, b) => msOf(a.createdAt) - msOf(b.createdAt));
    return {
      uid,
      stories: list,
      latest: msOf(list[list.length - 1].createdAt),
      allSeen: list.every((s) => seen.has(s.id))
    };
  });
  rings.sort((a, b) => {
    if (a.uid === me) return -1;
    if (b.uid === me) return 1;
    if (a.allSeen !== b.allSeen) return a.allSeen ? 1 : -1;
    return b.latest - a.latest;
  });
  return rings;
}

/* ---------- The song sticker ----------
   A story cannot PLAY a song: that needs a licence Instagram pays for
   and a small app cannot get, and Spotify's own terms forbid putting
   their music under a photo. What it can do is SAY which song, and hand
   you to a service that plays it legally. So a song is a link to one
   of these, plus the words "Song — Artist". */
const SONG_HOSTS = {
  "open.spotify.com": "Spotify",
  "music.youtube.com": "YouTube Music",
  "youtube.com": "YouTube",
  "www.youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "www.jiosaavn.com": "JioSaavn",
  "jiosaavn.com": "JioSaavn",
  "music.apple.com": "Apple Music",
  "gaana.com": "Gaana",
  "wynk.in": "Wynk"
};

/** Which service a song link is on, or "" if it isn't one we take. */
export function songService(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:" || String(url).length > 300) return "";
    return SONG_HOSTS[u.hostname] || "";
  } catch (e) {
    return "";
  }
}

/** A clean song for a story, or null. */
export function cleanSong(url, title) {
  const service = songService(url);
  const t = String(title || "").replace(/\s+/g, " ").trim().slice(0, SONG_TITLE_MAX);
  if (!service || !t) return null;
  return { url: new URL(String(url).trim()).href, title: t };
}

/** The Spotify player for a track, only ever for a link we accepted. */
export function spotifyEmbedFor(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "open.spotify.com") return "";
    const m = /^\/(intl-[a-z]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)/.exec(u.pathname);
    return m ? `https://open.spotify.com/embed/${m[2]}/${m[3]}` : "";
  } catch (e) {
    return "";
  }
}
