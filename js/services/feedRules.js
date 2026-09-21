// ==========================================
// WHAT SITS WHERE IN THE FEED
// ==========================================
//
// Pure functions, no imports — the same shape as recapRules.js and
// matchRules.js, so the weights can be argued with and tested without
// a browser or a database.
//
// The feed used to be ordered by time alone: live things first, most
// recently started at the top of those, then whatever starts soonest.
// That is the right SPINE and it has not moved. What it missed is that
// the question a card answers — "is this worth walking over?" — is
// mostly answered by who is hosting it. The card already knows: the
// trust chip has said "in your orbit" and "vouched by 3 you know"
// since the redesign. It just had no bearing on where the card sat.
//
// WHY THIS IS A TIEBREAK AND NOT A SORT
// -------------------------------------
// The obvious version — everyone you know above everyone you do not —
// is wrong, and badly. It buries a stranger's thing starting in five
// minutes under a friend's thing starting in six hours, and "happening
// now" is the entire product. Urgency has to win.
//
// So time is bucketed first, and the social lift only reorders things
// that are already about as soon as each other. Among events you could
// equally walk to, you see the people you would actually show up for.
// Nothing ever jumps ahead of something genuinely more urgent.
//
// Everything here is free: orbit, following and the vouch list are all
// already in memory for the trust chip. No extra reads.
// ==========================================

/** How wide a "these are about as soon as each other" bucket is. */
export const BUCKET_MS = 60 * 60 * 1000;

/* How much each kind of connection is worth. Orbit is the deliberate,
   mutual tier — the people you would actually show up for — so it
   outranks a one-way follow, which outranks a stranger somebody you
   trust has vouched for. Your own event sits at the top of its bucket
   because you are the one person certain to be there. */
export const WEIGHT = {
  mine: 4,
  orbit: 3,
  following: 2,
  vouched: 1,
  stranger: 0
};

/**
 * How connected you are to whoever is hosting.
 *
 * `graph` is { uid, orbit, following, vouchedBy } — plain arrays, so
 * this file needs to know nothing about where they came from.
 */
export function hostRank(hostUid, graph) {
  if (!hostUid || !graph) return WEIGHT.stranger;
  if (hostUid === graph.uid) return WEIGHT.mine;
  if ((graph.orbit || []).includes(hostUid)) return WEIGHT.orbit;
  if ((graph.following || []).includes(hostUid)) return WEIGHT.following;
  if ((graph.vouchedBy || []).includes(hostUid)) return WEIGHT.vouched;
  return WEIGHT.stranger;
}

/**
 * Which time bucket an event falls in. Lower sorts higher.
 *
 * Live events come first and are bucketed by how recently they
 * started, so something that began a minute ago reads as more
 * immediate than something three hours in. Upcoming events follow,
 * bucketed by how soon. The two ranges cannot overlap, which is what
 * keeps every live event above every upcoming one.
 */
export function timeBucket(event, now = Date.now()) {
  if (!event) return Number.MAX_SAFE_INTEGER;
  const start = event.startTime || 0;
  if (start <= now) {
    // Live. 0, 1, 2 … by hours since it started.
    return Math.floor((now - start) / BUCKET_MS);
  }
  // Upcoming, always below every live bucket.
  return 1000 + Math.floor((start - now) / BUCKET_MS);
}

/**
 * The comparator the feed sorts by.
 *
 * Bucket, then who is hosting, then the clock — so the order inside a
 * bucket is stable and explainable, and two strangers' events an hour
 * apart are still in the order they always were.
 */
export function compareEvents(a, b, graph, now = Date.now()) {
  const bucketA = timeBucket(a, now);
  const bucketB = timeBucket(b, now);
  if (bucketA !== bucketB) return bucketA - bucketB;

  const rankA = hostRank(a.hostUid, graph);
  const rankB = hostRank(b.hostUid, graph);
  if (rankA !== rankB) return rankB - rankA;

  // Inside a bucket, at the same distance from you: live things
  // newest-first, upcoming things soonest-first — which is exactly
  // what the feed did before any of this.
  const liveA = (a.startTime || 0) <= now;
  return liveA
    ? (b.startTime || 0) - (a.startTime || 0)
    : (a.startTime || 0) - (b.startTime || 0);
}

/** Sort a list of events in place and hand it back. */
export function rankFeed(events, graph, now = Date.now()) {
  return (events || []).slice().sort((a, b) => compareEvents(a, b, graph, now));
}
