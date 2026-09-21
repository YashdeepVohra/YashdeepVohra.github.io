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

/* ---------------------------------------------------------------------
   IS THE FEED ACTUALLY PARTITIONED YET?
   ---------------------------------------------------------------------
   No, and while there is one college it should not be. Everybody is in
   `main`, so filtering on it removes nothing and adds a composite index
   the query cannot run without — a failure mode in exchange for no
   benefit. Off, the feed is one query on expiresAt and Firestore's
   automatic index serves it.

   Events still CARRY their circleId, which is the whole point. Turning
   this on is one line and needs no migration, because every event
   written from now on is already tagged. What it will need is the
   circleId + expiresAt index built and enabled first — see
   firestore.indexes.json, which still carries it.

   Flip it when there is a second circle, not before.
   ------------------------------------------------------------------- */
let scopeByCircle = false;

export function feedIsScoped() {
  return scopeByCircle;
}

/** Turn partitioning on (or off again). */
export function setFeedScoping(on) {
  scopeByCircle = !!on;
}

/* ---------------------------------------------------------------------
   WHERE TO PUT WHEN NOBODY HAS SAID WHERE
   ---------------------------------------------------------------------
   Nothing asks anybody for their location, and nothing will until the
   feed actually becomes "near me" — a permission prompt buys nothing
   today and a denied one is sticky, which is the same mistake the
   notification prompt made.

   So a point comes from the CIRCLE, not the device, and there are two
   places to set it. Prefer the first:

     1. circles/main in the Firebase console — { name, lat, lng }.
        No deploy, no code change, and it is the same field every other
        circle will use.
     2. This constant, for when that document does not exist at all.

   Leave it null rather than guessing. An event stamped with a point
   that is not where it happened is worse than one stamped with
   nothing: nothing is visibly absent and gets filled in, whereas a
   wrong point looks like data and survives into the day geography
   starts being trusted. 0,0 in particular is a real place in the Gulf
   of Guinea.

   To set it, replace null with your campus's coordinates:
     export const FALLBACK_GEO = { lat: 28.5450, lng: 77.1926 };
   (that example is IIT Delhi — use your own; right-click the spot in
   Google Maps and the first item on the menu is the pair.)
   ------------------------------------------------------------------- */
export const FALLBACK_GEO = null;

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
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
    return geoPoint(c.lat, c.lng);
  }
  // No document, or one with no coordinates on it.
  if (FALLBACK_GEO && Number.isFinite(FALLBACK_GEO.lat) && Number.isFinite(FALLBACK_GEO.lng)) {
    return geoPoint(FALLBACK_GEO.lat, FALLBACK_GEO.lng);
  }
  return null;
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
