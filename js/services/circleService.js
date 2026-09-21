// ==========================================
// CIRCLES — who shares a feed with you
// ==========================================
//
// The live feed used to be "the sixty events ending furthest away, in
// the whole database". On one campus that is the whole world and it
// works. Past that it stops meaning anything: you would be shown sixty
// events by strangers who are nowhere near you, and LIVE_LIMIT would
// be spent before anything close to you got a look in. A feed about
// walking across campus to a thing has to be partitioned by SOMETHING.
//
// That something is a circle: a place or community you belong to. A
// college is one kind of circle and it is where this starts, but there
// is nothing college-shaped about the field — a city, a neighbourhood
// and a campus are all the same row.
//
// WHY NOT GEOGRAPHY YET
// ---------------------
// Because it is the bigger change and it can be deferred without
// costing anything, as long as the DATA is laid down now. A circle
// carries a point (`lat`, `lng`, `geohash`), and every event written
// under it copies that point. So the day the feed switches to "events
// near me", every event already has coordinates and every user already
// has a position through their circle. See geoRules.js for what the
// switch takes; it is a query change and an index, not a migration.
//
// WHAT IS STORED WHERE
//   circles/{id}      { name, kind, lat, lng, geohash, radiusM }
//                     Read-only from the client — created in the
//                     console. Optional: with no document at all the
//                     app still works, it just has no display name and
//                     no point to copy onto events.
//   users/{uid}       circleId
//   events/{id}       circleId, and geo copied from the circle
// ==========================================

import { db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { safeId } from '../utils/formatters.js';
import { geoPoint } from './geoRules.js';

/**
 * Where everybody starts.
 *
 * Deliberately a real id rather than an empty string, so that a feed
 * query always has something to match on and the app needs no console
 * setup to work at all. Create `circles/main` when you want it to have
 * a name and a position; until then it is simply the one circle.
 */
export const DEFAULT_CIRCLE = "main";

/** The circle this account belongs to. */
export function myCircleId() {
  return safeId(state.circleId) || DEFAULT_CIRCLE;
}

/** Its document, once loaded. Null while unknown or absent. */
export function myCircle() {
  return state.circleDoc && state.circleDoc.id === myCircleId() ? state.circleDoc : null;
}

export function circleName() {
  const c = myCircle();
  return (c && c.name) || "";
}

/**
 * The point to stamp onto an event, or null.
 *
 * Null when the circle has no coordinates on it, which is the ordinary
 * case until somebody fills them in — writing zeroes instead would put
 * every event off the coast of Africa, and a wrong point stored today
 * is exactly the thing that WOULD need a migration later.
 */
export function circleGeo() {
  const c = myCircle();
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
  return geoPoint(c.lat, c.lng);
}

/**
 * One read, once per session, and the app is fully usable without it —
 * everything it supplies is decoration (a name) or groundwork (a
 * point). A missing document is not an error.
 */
export async function loadCircle() {
  const id = myCircleId();
  if (state.circleDoc && state.circleDoc.id === id) return state.circleDoc;
  try {
    const doc = await db.collection("circles").doc(id).get();
    state.circleDoc = doc.exists ? { id, ...doc.data() } : { id };
  } catch (e) {
    console.warn("Circle lookup failed:", e.code || e.message);
    state.circleDoc = { id };
  }
  return state.circleDoc;
}
