// ==========================================
// ABOUT YOU — bio and interests
// ==========================================
//
// Both live on the profile document everyone already reads to draw a
// profile, so showing them costs nothing extra: no new reads, and one
// write when you save. They are shown on every profile, private or
// not — it's how somebody decides whether to ask.
//
// The list here and the list in firestore.rules must match; the rules
// refuse anything that isn't on it.
// ==========================================

export const BIO_MAX = 160;
export const INTERESTS_MAX = 5;

export const INTERESTS = [
  "☕ Chill", "\u{1F355} Food", "\u{1F389} Party", "\u{1F4DA} Study", "\u{1F3C0} Sports",
  "\u{1F3A7} Music", "\u{1F3AE} Gaming", "\u{1F3A8} Art", "\u{1F4BB} Coding", "\u{1F4F8} Photos",
  "\u{1F3AC} Movies", "\u{1F3CB}️ Gym", "✈️ Travel", "\u{1F3AD} Theatre", "\u{1F4D6} Books"
];

/** Trim, cap, and fold runs of blank lines — a bio is a few lines, not a page. */
export function cleanBio(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").slice(0, 4).join("\n")
    .trim()
    .slice(0, BIO_MAX);
}

/** Only known interests, no repeats, at most five. */
export function cleanInterests(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((t) => INTERESTS.includes(t) && !seen.has(t) && seen.add(t))
    .slice(0, INTERESTS_MAX);
}
