/**
 * Photos, the pure half: sizes, names and which URLs are ours.
 *
 * No DOM and no Firebase, so every number here is testable on its own.
 * firestore.rules and storage.rules repeat the limits — change them in
 * all three places or the database refuses what the app just made.
 */

/** Where each kind of photo lives: <folder>/<owner uid>/<random>.jpg. */
export const FOLDERS = ["avatars", "events", "chats", "memories", "stories"];

export const PHOTO = {
  // An event carries at most this many. The rules check each index by
  // hand (rules have no loops), so raising it means another line there.
  EVENT_MAX: 4,
  // Longest edge after compression. 1600 is sharp on a phone held
  // close and ~200 KB as JPEG; a profile picture is never shown larger
  // than the profile header, so 512 square is plenty.
  EVENT_EDGE: 1600,
  AVATAR_EDGE: 512,
  QUALITY: 0.82,
  // What storage.rules accepts. Compression lands far under both, so
  // these only ever stop somebody going round the app.
  EVENT_BYTES: 2 * 1024 * 1024,
  AVATAR_BYTES: 400 * 1024,
  // Memories: each person who went may add this many to an event.
  MEMORY_PER_PERSON: 3,
  // Anything a browser can decode goes in; the picker's own filter.
  ACCEPT: "image/*"
};

/** Scale (w, h) down so the longer side is at most `edge`. Never up. */
export function fitWithin(w, h, edge) {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const scale = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** The centred square a profile picture is cut from. */
export function squareCrop(w, h) {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side };
}

/** A file name nobody can guess or collide with: 20 url-safe chars. */
export function photoName(rand = Math.random) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 20; i++) s += abc[Math.floor(rand() * abc.length)];
  return s + ".jpg";
}

/**
 * Is this a download URL for a photo that `uid` put in `folder`?
 *
 * The URL names its BUCKET, which is the point: a photo record always
 * says where it lives, so moving new uploads to a second bucket later
 * (Mumbai, say) is a config change and nothing stored has to move.
 * Any bucket of this project is accepted for the same reason. The
 * rules carry the same pattern — keep them in step.
 */
export function isOurPhotoUrl(url, folder, uid) {
  if (typeof url !== "string" || url.length > 600) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(uid || ""))) return false;
  if (!FOLDERS.includes(folder)) return false;
  const re = new RegExp(
    "^https://firebasestorage\\.googleapis\\.com/v0/b/livesociyaweb[a-z0-9._-]*/o/"
    + folder + "%2F" + uid + "%2F[A-Za-z0-9_-]{8,40}\\.jpg\\?alt=media&token=[A-Za-z0-9-]+$"
  );
  return re.test(url);
}

/** The storage path inside a download URL, or "" if it isn't one. */
export function pathOfUrl(url) {
  const m = /\/o\/([^?]+)\?/.exec(String(url || ""));
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch (e) { return ""; }
}

/** An event's photos, cleaned: ours, the host's, no repeats, capped. */
export function eventPhotos(e) {
  const list = Array.isArray(e && e.photos) ? e.photos : [];
  const seen = new Set();
  return list.filter((u) => {
    if (seen.has(u) || !isOurPhotoUrl(u, "events", e.hostUid)) return false;
    seen.add(u);
    return true;
  }).slice(0, PHOTO.EVENT_MAX);
}
