// ==========================================
// WHERE SOMETHING IS
// ==========================================
//
// Pure functions, no imports — the same shape as recapRules.js and
// matchRules.js, and for the same reason: this is arithmetic that has
// to be right, and it can be tested without a browser or a database.
//
// NOTHING QUERIES BY GEOGRAPHY YET. The feed is scoped by CIRCLE (see
// circleService.js). This exists because of the one thing about geo
// that cannot be deferred: the value has to be STORED correctly from
// the first event, or switching later means rewriting history.
//
// Events are the easy half — they carry a 72h ttlAt, so by the time
// anything switches, every event written today is long gone and the
// new ones will have been written by the new code. It is the circles
// that have to be right now: a circle's centroid is what gives every
// event written under it a real position, so the day geography turns
// on, the whole existing feed already has coordinates.
//
// WHAT A SWITCH ACTUALLY TAKES, once points are real:
//   - the feed query stops being `where circleId == mine` and becomes
//     a geohash prefix range, `startAt(p)` / `endAt(p + '')`,
//     over the nine cells around you (the one you are in plus its
//     eight neighbours — a point near a cell edge has near neighbours
//     in the next cell along);
//   - neighbour arithmetic lands here, next to `rangeFor`;
//   - the composite index changes from circleId+expiresAt to
//     geo.geohash+expiresAt.
// No document is rewritten by any of that.
// ==========================================

// The geohash alphabet: base 32 with a, i, l and o left out, because
// they are the four that get misread by eye.
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Encode a point as a geohash.
 *
 * Interleaved binary search: each character is five bits, and the bits
 * alternate between narrowing longitude and narrowing latitude. Two
 * points that share a prefix are in the same box, which is the whole
 * reason the format is useful to a database that can only do prefix
 * ranges.
 */
export function geohash(lat, lng, precision = 9) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return "";

  const p = Math.max(1, Math.min(12, Math.round(precision)));
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = "", bits = 0, bitCount = 0, evenBit = true;

  while (hash.length < p) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { bits = (bits << 1) + 1; lngMin = mid; }
      else { bits = bits << 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { bits = (bits << 1) + 1; latMin = mid; }
      else { bits = bits << 1; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bitCount === 5) {
      hash += BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

/**
 * Roughly how wide a geohash cell is, by precision, in metres.
 *
 * Longitude cells narrow towards the poles, so these are the width at
 * the equator — the worst case, which is the one worth sizing against.
 */
const CELL_WIDTH_M = [
  5009400, 1252300, 156500, 39100, 4900, 1200, 152.9, 38.2, 4.8, 1.2, 0.149, 0.037
];

/** The shortest prefix whose cell still covers `radiusM`. */
export function precisionForRadius(radiusM) {
  const r = Number(radiusM);
  if (!Number.isFinite(r) || r <= 0) return 9;
  for (let i = 0; i < CELL_WIDTH_M.length; i++) {
    if (CELL_WIDTH_M[i] <= r) return Math.max(1, i);
  }
  return CELL_WIDTH_M.length;
}

/**
 * The Firestore range that matches every hash inside one cell.
 *
 * `` is the last code point in the Private Use Area, so it sorts
 * above every character a geohash can contain — the same trick the
 * handle search uses to bound a prefix query.
 */
export function rangeFor(prefix) {
  const p = String(prefix || "");
  return { start: p, end: p + "" };
}

/** Metres between two points. Haversine, on a sphere; close enough. */
export function distanceM(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The stored shape, from a point. `null` when there is no point yet —
 * a circle with no coordinates on it is the ordinary case until
 * somebody fills them in, and writing zeroes would be a lie that later
 * reads as "off the coast of Africa".
 */
export function geoPoint(lat, lng, precision = 9) {
  const hash = geohash(lat, lng, precision);
  if (!hash) return null;
  return { lat: Number(lat), lng: Number(lng), geohash: hash };
}
