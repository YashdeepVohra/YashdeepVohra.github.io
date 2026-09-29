/**
 * livesociya — one regression pass over everything that has broken before.
 *
 *   cd test && python3 -m http.server 8111 --directory ..   # in one shell
 *   node smoke.mjs                                          # in another
 *
 * It runs the real modules against test/stub.js, a hand-written stand-in
 * for the Firebase compat SDK. No network, no emulator, no credentials —
 * the sandbox this was built in could reach none of those, and it turns
 * out not to need them: every bug found here was in our own code.
 *
 * Add a case whenever something breaks. The list below is not a wish
 * list, it is a list of things that were actually wrong once.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const APP_URL = process.env.SMOKE_URL || 'http://localhost:8111/index.html';
const CHROME = process.env.CHROME_PATH || undefined;   // e.g. /opt/pw-browsers/chromium

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) return console.log('  ✓ ' + name);
  failures++;
  console.log('  ✗ ' + name + (detail ? '  -> ' + detail : ''));
};
const group = (name) => console.log('\n' + name);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

// index.html loads dist/app.js, the bundle. These tests reach into the
// app through its modules (`import('/js/state/store.js')`), and a module
// imported that way is only the SAME instance the app is using if the
// app was loaded from js/ too. So every context here swaps the bundle
// for a one-line module that imports the source. The service worker is
// blocked because requests it serves never reach a route. The bundle
// itself gets its own check in "one file for the browser".
const rawNewContext = browser.newContext.bind(browser);
browser.newContext = async (opts = {}) => {
  const ctx = await rawNewContext({ serviceWorkers: 'block', ...opts });
  await ctx.route('**/dist/app.js', (r) => r.fulfill({
    contentType: 'text/javascript', body: 'import "/js/app.js";'
  }));
  // Photos come from Cloud Storage in production. Here every one is a
  // 1600x1200 drawing, so a cover has a real image to crop and nothing
  // leaves the machine.
  await ctx.route('https://firebasestorage.googleapis.com/**', (r) => r.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#7a9"/><circle cx="800" cy="600" r="300" fill="#fd8"/></svg>'
  }));
  return ctx;
};
browser.newPage = async (opts) => (await browser.newContext(opts)).newPage();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 140)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
    errors.push('console: ' + m.text().slice(0, 140));
  }
});
// Nothing in the app may open a browser dialog.
page.on('dialog', (d) => { errors.push('NATIVE DIALOG: ' + d.message().slice(0, 60)); d.dismiss(); });

await page.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);

group('boot');
ok('no errors on load', errors.length === 0, errors.join(' | '));

/** Put the app into a known signed-in state with `events` in the feed. */
const seed = (events = {}) => page.evaluate(async (events) => {
  const { state } = await import('/js/state/store.js');
  const ui = await import('/js/utils/ui.js');
  const ev = await import('/js/services/eventsService.js');
  const orbit = await import('/js/services/orbitService.js');
  const follow = await import('/js/services/followService.js');
  const prof = await import('/js/services/profileService.js');
  const search = await import('/js/interactions/searchUI.js');
  window.__m = { state, ui, ev, orbit, follow, prof, search };
  window.__authSingleton.currentUser = { uid: 'me' };

  state.uid = 'me'; state.blockedUids = []; state.userAvatar = '\u{1F43C}';
  state.userCache = { me: { uid:'me', username:'me_h', displayName:'Me', avatar:'\u{1F43C}',
                            followers:[], following:[], vouchedBy:[] } };
  ['a','b','c'].forEach((u) => {
    state.userCache[u] = { uid:u, username:u, displayName:u.toUpperCase(), avatar:'\u{1F98A}',
                           followers:[], following:[], vouchedBy:[] };
  });
  state.following = []; state.followRequests = []; state.isPrivate = false;
  state.orbitUids = []; state.orbitIncoming = []; state.orbitOutgoing = [];
  state.eventCache = events; state.eventOrder = Object.keys(events);
  state.recapOrder = []; state.recapDone = true; state.recapLoading = false;
  state.currentLiveFilter = 'All'; state.currentRecapFilter = 'All';

  document.getElementById('loading-screen').classList.add('hidden');
  document.querySelector('.app-frame').classList.remove('hidden');
  document.querySelector('.topbar')?.classList.remove('hidden');
  history.pushState({ screen: 'home' }, '', location.href);
  window.switchScreen('home');

  ui.onSocialChange(ev.renderEvents);
  ui.onSocialChange(orbit.updateOrbitBadge);
  ui.onSocialChange(search.refreshSearchResults);
  ui.onSocialChange(() => prof.refreshProfileSocial(state.currentProfileUid));
  orbit.loadOrbit(() => ui.refreshSocialUI());
  ev.renderEvents();
}, events);

const now = Date.now();
const mkEvent = (id, host, title, tag) => ({
  id, hostUid: host, title, place: 'Lawn', description: '', tag,
  startTime: now - 6e5, expiresAt: now + 72e5,
  participantUids: [host], hypedUids: [], pendingUids: [], unconfirmedUids: [],
  requiresApproval: false, maxCapacity: null,
  // The feed and the recap are both scoped to a circle now, and the
  // stub's event queries really do filter — an event with no circle on
  // it is an event in nobody's feed. 'main' is where everybody starts.
  circleId: 'main'
});

/* ------------------------------------------------------------------ */
group('day one');
await seed({});
const empty = await page.evaluate(() => ({
  heading: document.querySelector('#events .empty-state.first-run h4')?.innerText,
  starters: document.querySelectorAll('#events .starter').length,
  bolt: !!document.querySelector('.first-run img.fr-logo[src="/logo.svg"]'),
  scroll: document.body.scrollWidth <= document.documentElement.clientWidth
}));
ok('empty feed asks for something', !!empty.heading, empty.heading);
ok('three starters plus start-from-scratch', empty.starters === 4, String(empty.starters));
ok('the empty feed shows the firefly logo', empty.bolt);
ok('no horizontal scroll', empty.scroll);

/* ------------------------------------------------------------------ */
group('feed');
await seed({ e1: mkEvent('e1','a','Jam','\u{1F3A7} Music'), e2: mkEvent('e2','b','Revision','\u{1F4DA} Study') });
const feed = await page.evaluate(async () => {
  const { state, ev } = window.__m;
  const nodes = () => [...document.querySelectorAll('#events .event')];
  nodes().forEach((n, i) => { n.__token = 'tok' + i; });
  let anims = 0;
  document.getElementById('events').addEventListener('animationstart', () => anims++, true);
  state.eventCache.e1.hypedUids = ['b'];          // somebody else hypes
  ev.renderEvents();
  const survived = nodes().map((n) => n.__token || 'REBUILT');
  ev.renderEvents();                               // an echo: should touch nothing
  return { survived, anims, cards: nodes().length,
           flame: document.querySelector('#event-e1 .hype-flame')?.getAttribute('fill') };
});
ok('a change rebuilds only the card that changed', feed.survived[1] === 'tok1', feed.survived.join());
ok('nothing re-animates on a re-render', feed.anims === 0, String(feed.anims));
ok('the flame renders for people who have NOT hyped', feed.flame === 'none', String(feed.flame));

const filters = await page.evaluate(async () => {
  const { ev } = window.__m;
  const vis = () => [...document.querySelectorAll('#events .event')]
    .filter((e) => !e.classList.contains('filtered-out')).length;
  const t0 = performance.now();
  ev.setLiveFilter(null, '\u{1F4DA} Study');
  const ms = performance.now() - t0;
  const one = vis();
  ev.setLiveFilter(null, 'All');
  return { one, all: vis(), ms: Math.round(ms), inDom: document.querySelectorAll('#events .event').length };
});
ok('a filter hides rather than rebuilds', filters.inDom === 2 && filters.one === 1 && filters.all === 2);
ok('filtering is instant', filters.ms < 25, filters.ms + 'ms');

/* ------------------------------------------------------------------ */
group('hype');
const hype = await page.evaluate(async () => {
  const { ev } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const w0 = window.__writes; ev.toggleHype('e1');
  const immediate = window.__writes - w0;
  await wait(1100);
  const settled = window.__writes - w0;
  const w1 = window.__writes;
  ev.toggleHype('e1'); await wait(120); ev.toggleHype('e1'); await wait(1100);
  return { immediate, settled, misclick: window.__writes - w1 };
});
ok('the write waits', hype.immediate === 0);
ok('and then goes', hype.settled === 1, String(hype.settled));
ok('a misclick costs nothing', hype.misclick === 0, String(hype.misclick));

/* ------------------------------------------------------------------ */
group('orbit and following');
const social = await page.evaluate(async () => {
  const { state, orbit, follow, prof } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__stubDocs['users/a'] = { username:'a', displayName:'A', avatar:'\u{1F98A}', followers:[], following:[] };
  state.following = ['a'];                          // orbit comes after following
  await orbit.pullIn('a'); await wait(120);
  const asked = orbit.orbitStatus('a');
  const id = ['me','a'].sort().join('_');
  window.__orbit.find((d) => d.id === id).status = 'linked';
  window.__fireOrbit(); await wait(120);
  const linked = orbit.orbitStatus('a');
  const chip = document.querySelector('#event-e1 .trust-chip')?.innerText.trim();

  state.userCache.me.followers = ['a','b'];
  state.following = ['a','b'];
  state.currentProfileUid = 'me';
  window.switchScreen('profileScreen');
  prof.refreshProfileSocial('me');
  const before = follow.followingCount('me');
  state.blockedUids = ['b'];
  prof.refreshProfileSocial('me');
  const after = follow.followingCount('me');
  state.blockedUids = [];
  return { asked, linked, chip, before, after };
});
ok('pulling somebody in lands immediately', social.asked === 'outgoing', social.asked);
ok('accepting links them', social.linked === 'linked', social.linked);
ok('the trust chip appears on their card', social.chip === 'In your orbit', String(social.chip));
ok('blocking removes them from the counts', social.before === 2 && social.after === 1,
   social.before + ' -> ' + social.after);

/* ------------------------------------------------------------------ */
group('avatars');
const avatars = await page.evaluate(async () => {
  const { state, orbit } = window.__m;
  const PFP = 'https://lh3.googleusercontent.com/a/example=s96-c';
  state.userAvatar = PFP;
  state.userCache.me.avatar = PFP;
  ['a','b','c'].forEach((u) => { state.userCache[u].avatar = PFP; });
  state.orbitUids = ['a','b','c'];
  orbit.renderOrbitRings(document.getElementById('profileRings'), state.orbitUids, 3);
  await new Promise((r) => setTimeout(r, 250));
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  return { core: box('.orbit-core img'), face: box('.orbit-face img') };
});
ok('a photo avatar stays square in the orbit centre',
   avatars.core && avatars.core[0] === avatars.core[1] && avatars.core[0] > 0, JSON.stringify(avatars.core));
ok('and on the rings',
   avatars.face && avatars.face[0] === avatars.face[1] && avatars.face[0] > 0, JSON.stringify(avatars.face));

/* ------------------------------------------------------------------ */
group('confirming');
const sheet = await page.evaluate(async () => {
  const { askConfirm } = await import('/js/utils/confirm.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = askConfirm({ title: 'Remove A?', confirm: 'Remove', danger: true });
  await wait(200);
  const open = !document.getElementById('confirmSheet').classList.contains('hidden');
  const danger = document.getElementById('confirmYes').classList.contains('danger-btn');
  window.confirmNo();
  const said = await p;
  const p2 = askConfirm({ title: 'Again?' }); await wait(150);
  window.confirmYes();
  return { open, danger, no: said, yes: await p2 };
});
ok('the sheet opens in the app', sheet.open);
ok('a destructive answer looks like one', sheet.danger);
ok('cancel is false, confirm is true', sheet.no === false && sheet.yes === true);

/* ------------------------------------------------------------------ */
group('recap');
const H = 3600e3;
const past = (id, host, endedAgo, extra = {}) => Object.assign(mkEvent(id, host, 'Past ' + id, '\u{1F389} Party'), {
  startTime: now - endedAgo - 2 * H, expiresAt: now - endedAgo }, extra);
const rules = await page.evaluate(async () => {
  const r = await import('/js/services/recapRules.js');
  const H = 3600e3, t = Date.now();
  const e = (guests, extra = {}) => Object.assign({ hostUid: 'h', startTime: t - 3 * H, expiresAt: t - H,
    participantUids: ['h', ...Array.from({ length: guests }, (_, i) => 'g' + i)], hypedUids: [] }, extra);
  const hrs = (ev, v) => Math.round(r.recapWindow(ev, v) / H);
  return {
    nobody: hrs(e(0)), one: hrs(e(1)), seven: hrs(e(7)), huge: hrs(e(500)),
    mine: hrs(e(0), 'h'), calledOff: hrs(e(9, { expiresAt: t - 4 * H })),
    blip: hrs(e(3, { startTime: t - H - 10 * 60e3 })),
  };
});
ok('a quiet event stays 6h', rules.nobody === 6, String(rules.nobody));
ok('each doubling of guests buys 8h', rules.one === 14 && rules.seven === 30, rules.one + '/' + rules.seven);
ok('nothing stays past 48h', rules.huge === 48, String(rules.huge));
ok('your own stays at least a day', rules.mine === 24, String(rules.mine));
ok('called off stays the minimum', rules.calledOff === 6, String(rules.calledOff));
ok('a ten-minute blip earns half', rules.blip < 22, String(rules.blip));

await seed({});
const recap = await page.evaluate(async ({ events }) => {
  const { state, ev } = window.__m;
  window.__events = events;
  state.recapDone = false;
  await ev.loadRecap({ reset: true });
  const ids = [...document.querySelectorAll('#recapEvents .event')].map((n) => n.id.replace('event-', ''));
  const card = document.querySelector('#event-busy');
  const live = document.querySelector('#recapEvents #event-live');
  return {
    ids,
    // Nothing on a finished card may claim it is still on.
    liveRing: !!card?.querySelector('.av-ring.live'),
    liveDot: !!card?.querySelector('.live-dot'),
    liveClass: !!card?.classList.contains('is-live'),
    // And it has to LOOK different from a live one at a glance: it is a
    // stub, its band is spent, and the big number is the turnout.
    isStub: !!card?.classList.contains('stub'),
    spentBand: !!card?.querySelector('.poster.spent'),
    stat: card?.querySelector('.poster-value')?.innerText.trim(),
    statLabel: card?.querySelector('.poster-label')?.innerText.trim(),
    leakedLive: !!live,
    fading: !!document.querySelector('#event-quiet.fading'),
  };
}, { events: [
  past('quiet', 'a', 5 * H),                                        // 6h window, 1h left
  past('stale', 'a', 7 * H),                                        // 6h window, gone
  past('busy', 'b', 20 * H, { participantUids: ['b','a','c','x','y','z','w','v'] }), // 30h
  past('mine', 'me', 20 * H),                                       // yours: 24h
  mkEvent('live', 'c', 'Still on', '☕ Chill'),
]});
ok('recap holds what earned its time and drops what did not',
   recap.ids.join() === 'quiet,busy,mine', recap.ids.join());
// An ended event had started too, so `now >= startTime` is still true
// for it — which is exactly how a Live chip and a live ring ended up on
// every card in Recap once. Nothing on a finished card may say "on".
ok('nothing on a recap card claims it is still live',
   !recap.liveRing && !recap.liveDot && !recap.liveClass && !recap.leakedLive,
   JSON.stringify({ r: recap.liveRing, d: recap.liveDot, c: recap.liveClass, l: recap.leakedLive }));
// A finished event is a torn-off stub, not a live card with the lights
// off: the band drains and the big number becomes the turnout.
ok('a recap card is a spent stub with the turnout as its stat',
   recap.isStub && recap.spentBand && recap.stat === '7' && /went/i.test(recap.statLabel || ''),
   JSON.stringify({ s: recap.isStub, b: recap.spentBand, n: recap.stat, l: recap.statLabel }));
ok('one about to leave says so', recap.fading);

/* ------------------------------------------------------------------ */
group('profile events');
const prof = await page.evaluate(async ({ events }) => {
  const { state, prof } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__events = events;
  window.__stubDocs['users/me'] = { username:'me_h', displayName:'Me', avatar:'\u{1F43C}', followers:[], following:[] };
  window.__stubDocs['users/b'] = { username:'b', displayName:'B', avatar:'\u{1F98A}', followers:[], following:[] };
  prof.openProfileScreen('me');
  await wait(300);
  const text = (id) => document.getElementById(id)?.innerText.trim();
  // Live and upcoming are rows; finished ones are journal cards. Both count.
  const rows = () => [...document.querySelectorAll('#myProfileEvents .pe-row, #myProfileEvents .jr-card')];
  const hosted = { n: rows().length, stat: text('statEventsHosted'), tab: text('peHostedCount'),
                   first: rows()[0]?.classList.contains('live') };
  prof.setProfileEventsTab('joined');
  const joined = { n: rows().length, stat: text('statEventsJoined'), tab: text('peJoinedCount'),
                   titles: rows().map((r) => r.querySelector('.pe-title, .jr-title').innerText) };
  state.blockedUids = ['b'];
  prof.openProfileScreen('me'); await wait(300);
  prof.setProfileEventsTab('joined');
  const afterBlock = { n: rows().length, stat: text('statEventsJoined') };
  state.blockedUids = [];
  const noScroll = document.body.scrollWidth <= document.documentElement.clientWidth;
  prof.closeProfileScreen({ all: true });
  return { hosted, joined, afterBlock, noScroll };
}, { events: [
  past('h1', 'me', 30 * H),
  mkEvent('h2', 'me', 'On now', '\u{1F355} Food'),
  past('j1', 'b', 3 * H, { participantUids: ['b', 'me'] }),
  mkEvent('j2', 'a', 'Going later', '\u{1F4DA} Study'),
].map((e) => (e.id === 'j2' ? Object.assign(e, { participantUids: ['a', 'me'], startTime: now + 2 * H }) : e)) });
ok('hosted list, tab count and stat agree', prof.hosted.n === 2 && prof.hosted.stat === '2' && prof.hosted.tab === '2',
   JSON.stringify(prof.hosted));
ok('what is live sorts first', prof.hosted.first);
ok('joined does not count events you hosted', prof.joined.n === 2 && prof.joined.stat === '2' && prof.joined.tab === '2',
   JSON.stringify(prof.joined));
ok('a blocked host disappears from joined and its count', prof.afterBlock.n === 1 && prof.afterBlock.stat === '1',
   JSON.stringify(prof.afterBlock));
ok('profile has no horizontal scroll', prof.noScroll);

/* ------------------------------------------------------------------ */
group('private accounts and following');

// A small model of the rules that matter here, so the client is tested
// against refusals and not just a database that says yes.
//
// The follow graph is DOCUMENTS now — users/{uid}/followers/{uid} and
// users/{uid}/followRequests/{uid} — so this models the rules on those
// rather than the array branches that used to live on the profile.
await page.evaluate(() => {
  window.__lastAskAt = 0;
  window.__rules = (path, data, kind) => {
    const me = window.__authSingleton.currentUser?.uid;
    const deny = { code: 'permission-denied' };
    const docs = window.__stubDocs;
    const profile = (u) => docs['users/' + u] || {};

    let m = /^users\/([^/]+)\/followers\/([^/]+)$/.exec(path);
    if (m) {
      const target = m[1], who = m[2];
      // Leaving always works, block or no block.
      if (kind === 'delete') return null;
      // Following yourself in: only your own row, only a public account.
      if (who === me) return profile(target).private === true ? deny : null;
      // Or the owner approving — and only somebody who really asked.
      if (target === me && docs['users/' + target + '/followRequests/' + who]) return null;
      return deny;
    }

    m = /^users\/([^/]+)\/followRequests\/([^/]+)$/.exec(path);
    if (m) {
      const target = m[1], who = m[2];
      if (kind === 'delete') return null;                  // withdraw, or answer
      if (who !== me) return deny;
      if (profile(target).private !== true) return deny;   // nobody asks a public account
      if (docs['users/' + target + '/followers/' + who]) return deny;
      if (Date.now() - window.__lastAskAt < 3000) return deny;
      window.__lastAskAt = Date.now();
      return null;
    }

    // The count on the profile may only be moved by the person named in
    // followerEdge, or by the owner.
    m = /^users\/([^/]+)$/.exec(path);
    if (m && data && ('followerCount' in data)) {
      return (data.followerEdge === me || m[1] === me) ? null : deny;
    }
    return null;
  };
});

const priv = await page.evaluate(async () => {
  const { state, follow } = window.__m;
  const users = await import('/js/services/userService.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const docs = window.__stubDocs;
  const person = (u, extra = {}) => Object.assign({ uid: u, username: u, displayName: u.toUpperCase(),
    avatar: '\u{1F98A}', banned: false, following: [], followerCount: 0 }, extra);

  Object.keys(docs).forEach((k) => { if (k.indexOf('users/') === 0) delete docs[k]; });
  try { window.localStorage.removeItem('livesociya.asks.me'); } catch (e) {}
  docs['users/me'] = person('me');
  docs['users/p1'] = person('p1', { private: true });
  docs['users/p2'] = person('p2', { private: true });
  docs['users/pub'] = person('pub');
  state.following = []; state.followRequests = [];
  window.__updates = []; window.__lastAskAt = 0;
  const out = {};
  const asked = (target) => !!docs['users/' + target + '/followRequests/me'];
  const follows = (target) => !!docs['users/' + target + '/followers/me'];

  // 1. A stale copy says "open"; the account went private since.
  state.userCache.p1 = { uid: 'p1', username: 'p1', displayName: 'P1', avatar: '', private: false };
  await follow.toggleFollow('p1');
  out.wentPrivateBecameAsk = asked('p1') && !follows('p1') && !state.following.includes('p1');

  // 2. Straight away, ask a second private account. Both must stand.
  const t0 = Date.now();
  await follow.toggleFollow('p2');
  out.secondAsk = asked('p2');
  out.firstStillThere = asked('p1');
  out.waitedItsTurn = Date.now() - t0 >= 2500;

  // 3. Reload: the profile cache comes back from localStorage only, and
  //    a private account's request queue is not readable from it at all
  //    any more — the record this device keeps is what answers.
  users.rememberUser('p1', docs['users/p1']);
  state.userCache = { me: state.userCache.me };
  users.hydrateProfileCache();
  out.afterReloadStillAsked = follow.hasAskedToFollow('p1') && follow.isPrivateAccount('p1');

  // 4. Tapping "Requested" asks before withdrawing; No keeps it.
  const p = follow.toggleFollow('p1'); await wait(150);
  out.withdrawAsks = !document.getElementById('confirmSheet').classList.contains('hidden');
  window.confirmNo(); await p;
  out.noKeepsRequest = asked('p1');

  // 5. p2 approves me. My app notices when it next settles up with p2.
  delete docs['users/p2/followRequests/me'];
  docs['users/p2/followers/me'] = { at: Date.now() };
  await follow.syncFollowState('p2'); await wait(50);
  out.approvalHealed = state.following.includes('p2') && docs['users/me'].following.includes('p2');

  // 6. Unfollowing a private account asks first.
  const q = follow.toggleFollow('p2'); await wait(150);
  out.unfollowPrivateAsks = !document.getElementById('confirmSheet').classList.contains('hidden');
  window.confirmYes(); await q;
  out.unfollowed = !state.following.includes('p2') && !follows('p2');

  // 7. A public account: one tap, one atomic batch, a double tap ignored.
  window.__batches = [];
  const a1 = follow.toggleFollow('pub'); const a2 = follow.toggleFollow('pub');
  await a1; await a2;
  out.publicFollow = state.following.includes('pub') && follows('pub');
  out.oneBatch = window.__batches.filter((b) => b.join().includes('users/pub')).length === 1;
  // The count moves with the document, and in the same batch.
  out.countMoved = docs['users/pub'].followerCount === 1;
  out.countRodeAlong = window.__batches.some((b) =>
    b.join().includes('users/pub/followers/me') && b.join().includes('set users/pub'));

  // 8. Private lists are locked to non-followers.
  state.currentProfileUid = 'p1';
  await follow.openFollowList('p1', 'followers'); await wait(100);
  out.listLocked = !!document.querySelector('#followListBody .locked-list');
  follow.closeFollowList(); await wait(200);
  return out;
});
ok('following an account that went private sends a request instead', priv.wentPrivateBecameAsk);
ok('asking two people back to back keeps both requests', priv.secondAsk && priv.firstStillThere,
   JSON.stringify({ second: priv.secondAsk, first: priv.firstStillThere }));
ok('the second ask waits instead of failing', priv.waitedItsTurn);
ok('after a reload a request still reads as Requested, on a private account', priv.afterReloadStillAsked);
ok('withdrawing asks first, and No keeps the request', priv.withdrawAsks && priv.noKeepsRequest);
ok('an approved request turns into following on your side', priv.approvalHealed);
ok('unfollowing a private account asks first', priv.unfollowPrivateAsks && priv.unfollowed);
ok('following a public account is one batch, and a double tap is one write', priv.publicFollow && priv.oneBatch);
ok('a follow writes a document, not a row in an array', priv.countRodeAlong, JSON.stringify(priv.countRodeAlong));
ok('and the count moves in that same batch', priv.countMoved);
ok('a private account\'s followers are locked to non-followers', priv.listLocked);

// The point of the whole shape: a follower list with no ceiling. The
// array it replaced was capped at 5000 by the rules, because that is
// roughly where an array of uids starts threatening the 1 MiB a
// document gets.
const noCeiling = await page.evaluate(async () => {
  const { state, follow } = window.__m;
  const docs = window.__stubDocs;
  docs['users/big'] = { uid: 'big', username: 'big', displayName: 'Big', avatar: '\u{1F98A}',
    banned: false, following: [], followerCount: 7400 };
  state.userCache.big = { uid: 'big', username: 'big', displayName: 'Big', avatar: '', private: false, followerCount: 7400 };
  state.following = state.following.filter((u) => u !== 'big');

  await follow.toggleFollow('big');
  return {
    followed: state.following.includes('big') && !!docs['users/big/followers/me'],
    counted: docs['users/big'].followerCount === 7401
  };
});
ok('somebody well past the old 5000 cap can still be followed', noCeiling.followed);
ok('and their count keeps going up', noCeiling.counted, JSON.stringify(noCeiling));

// A count is only allowed to move with the document it counts, so it
// cannot be typed up on its own.
const forge = await page.evaluate(async () => {
  const docs = window.__stubDocs;
  const fb = await import('/js/config/firebase.js');
  docs['users/pub'].followerCount = 1;
  let refused = false;
  try {
    await fb.db.collection('users').doc('pub').update({ followerCount: 999, followerEdge: 'someone_else' });
  } catch (e) { refused = e.code === 'permission-denied'; }
  return { refused, still: docs['users/pub'].followerCount };
});
ok('a follower count cannot be written for somebody else', forge.refused && forge.still === 1,
   JSON.stringify(forge));

const owner = await page.evaluate(async () => {
  const { state, follow } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const docs = window.__stubDocs;
  Object.keys(docs).forEach((k) => { if (k.indexOf('users/me') === 0) delete docs[k]; });
  docs['users/me'] = { uid: 'me', banned: false, private: true, following: [], followerCount: 0 };
  docs['users/me/followRequests/a'] = { at: Date.now() };
  docs['users/me/followRequests/b'] = { at: Date.now() };
  state.userCache.me = Object.assign(state.userCache.me || {}, { followerCount: 0 });
  state.isPrivate = true; state.privacyChosen = true; state.followRequests = ['a', 'b'];
  const out = {};

  // Going public lets the people waiting in.
  const p = follow.setPrivateAccount(false); await wait(150);
  out.asked = !document.getElementById('confirmSheet').classList.contains('hidden');
  window.confirmYes(); await p;
  out.letIn = docs['users/me'].private === false
    && !!docs['users/me/followers/a'] && !!docs['users/me/followers/b']
    && !docs['users/me/followRequests/a'] && !docs['users/me/followRequests/b'];
  out.counted = docs['users/me'].followerCount === 2;

  // Removing a follower.
  const r = follow.removeFollower('a'); await wait(150);
  window.confirmYes(); await r;
  out.removed = !docs['users/me/followers/a'] && !!docs['users/me/followers/b'];
  out.countDropped = docs['users/me'].followerCount === 1;
  return out;
});
ok('going public asks, then lets everyone waiting in', owner.asked && owner.letIn, JSON.stringify(owner));
ok('approving moves the count with it', owner.counted, JSON.stringify(owner));
ok('you can remove a follower', owner.removed);
ok('and removing one takes the count back down', owner.countDropped, JSON.stringify(owner));

const onboarding = await page.evaluate(async () => {
  const auth = await import('/js/services/authService.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const screen = document.getElementById('usernameScreen');
  screen.classList.remove('hidden');
  const input = document.getElementById('newUsername');
  const btn = document.getElementById('claimBtn');
  input.value = 'fresh_one';
  auth.checkUsernameAvailability(); await wait(600);
  const beforePick = btn.disabled;
  window.pickAccountType(document.querySelector('#claimTypePicker [data-type="private"]'), 'private');
  const afterPick = btn.disabled;
  const cards = [...document.querySelectorAll('#claimTypePicker .type-card')].map((c) => Math.round(c.getBoundingClientRect().height));
  screen.classList.add('hidden');
  return { beforePick, afterPick, cards, selected: document.querySelector('#claimTypePicker .selected')?.dataset.type };
});
ok('join stays off until public or private is picked', onboarding.beforePick === true && onboarding.afterPick === false,
   JSON.stringify(onboarding));
ok('the two choices render as cards', onboarding.cards.length === 2 && onboarding.cards.every((h) => h > 50), JSON.stringify(onboarding.cards));

await page.evaluate(() => { window.__rules = null; });

/* ------------------------------------------------------------------ */
group('follow first, orbit later');
const gate = await page.evaluate(async () => {
  const { state, follow, prof, orbit, search } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const docs = window.__stubDocs;
  // followerCount is the stored number; the followers themselves are
  // documents under the profile, which is what the two rows below seed.
  const person = (u, extra = {}) => Object.assign({ uid: u, username: u, displayName: u.toUpperCase(), avatar: '\u{1F98A}',
    banned: false, following: [], followerCount: 0, vouchedBy: [] }, extra);
  docs['users/lock'] = person('lock', { private: true, followerCount: 2, following: ['z'], vouchedBy: ['x'] });
  docs['users/lock/followers/x'] = { at: Date.now() };
  docs['users/lock/followers/y'] = { at: Date.now() };
  docs['users/open'] = person('open', { followerCount: 1 });
  docs['users/open/followers/x'] = { at: Date.now() };
  state.following = []; state.orbitUids = []; state.orbitOutgoing = []; state.orbitIncoming = [];
  window.__events = [Object.assign({}, { id: 'le1', hostUid: 'lock', title: 'Secret', place: 'Lawn', tag: '',
    startTime: Date.now() - 6e5, expiresAt: Date.now() + 6e5, participantUids: ['lock'], hypedUids: [] })];
  const shown = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden'); };
  const out = {};

  // A private account you don't follow.
  window.__readPaths = [];
  prof.openProfileScreen('lock'); await wait(400);
  out.locked = {
    panel: shown('#profileLocked'),
    events: shown('.pe-section'),
    vouches: shown('#statVouchesBox'),
    counts: document.getElementById('statFollowers').innerText + '/' + document.getElementById('statFollowing').innerText,
    follow: document.querySelector('#profileOrbit .orbit-btn')?.innerText.trim(),
    orbitBtn: [...document.querySelectorAll('#profileOrbit .orbit-btn')].some((b) => /orbit/i.test(b.innerText)),
    eventCards: document.querySelectorAll('#myProfileEvents .pe-row').length,
  };

  // Let in: the rest opens where you are.
  // Both halves of the edge, because that is what following writes now
  // — your own list AND a document under them. The profile watches the
  // second one while it is open and will repair your list to match it,
  // so a fixture that sets only `following` is a fixture that unfollows
  // itself a moment later.
  state.following = ['lock'];
  docs['users/lock/followers/me'] = { at: Date.now() };
  prof.refreshProfileSocial('lock'); await wait(400);
  out.unlocked = { panel: shown('#profileLocked'), events: shown('.pe-section'), vouches: shown('#statVouchesBox'),
    rows: document.querySelectorAll('#myProfileEvents .pe-row').length,
    orbitBtn: [...document.querySelectorAll('#profileOrbit .orbit-btn')].some((b) => /orbit/i.test(b.innerText)) };
  prof.closeProfileScreen({ all: true }); await wait(200);

  // A public account you don't follow: everything visible, no orbit yet.
  state.following = [];
  delete docs['users/lock/followers/me'];
  prof.openProfileScreen('open'); await wait(400);
  out.publicView = { panel: shown('#profileLocked'), events: shown('.pe-section'),
    orbitBtn: [...document.querySelectorAll('#profileOrbit .orbit-btn')].some((b) => /orbit/i.test(b.innerText)),
    hint: !!document.querySelector('#profileOrbit .orbit-hint') };
  await follow.openFollowList('open', 'followers'); await wait(150);
  out.publicListOpen = !document.querySelector('#followListBody .locked-list');
  follow.closeFollowList(); await wait(200);
  prof.closeProfileScreen({ all: true }); await wait(200);

  // Pulling in a stranger is refused with a reason, and writes nothing.
  const w0 = window.__writes;
  await orbit.pullIn('open');
  out.pullRefused = orbit.orbitStatus('open') === 'none' && window.__writes === w0;

  // Unfollowing takes back a waiting orbit request.
  state.following = ['open']; state.orbitOutgoing = ['open'];
  await follow.toggleFollow('open'); await wait(150);
  out.unfollowWithdrew = orbit.orbitStatus('open') === 'none';
  return out;
});
ok('a locked private profile shows counts and a follow button only',
   gate.locked.panel && !gate.locked.events && !gate.locked.vouches && gate.locked.counts === '2/1'
   && /Ask to follow/.test(gate.locked.follow || '') && !gate.locked.orbitBtn && gate.locked.eventCards === 0,
   JSON.stringify(gate.locked));
ok('once you follow, events, vouches and orbit open up in place',
   !gate.unlocked.panel && gate.unlocked.events && gate.unlocked.vouches && gate.unlocked.rows === 1 && gate.unlocked.orbitBtn,
   JSON.stringify(gate.unlocked));
ok('a public profile shows everything but orbit until you follow',
   !gate.publicView.panel && gate.publicView.events && !gate.publicView.orbitBtn && gate.publicView.hint && gate.publicListOpen,
   JSON.stringify(gate.publicView));
ok('pulling a stranger into orbit is refused before any write', gate.pullRefused);
ok('unfollowing withdraws a waiting orbit request', gate.unfollowWithdrew);

/* ------------------------------------------------------------------ */
group('bio and interests');
const about = await page.evaluate(async () => {
  const { state, prof } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const docs = window.__stubDocs;
  const out = {};
  docs['users/me'] = Object.assign(docs['users/me'] || {}, { uid: 'me', displayName: 'Me', avatar: '\u{1F43C}', banned: false });
  state.userCache.me = Object.assign(state.userCache.me || {}, { displayName: 'Me', bio: '', interests: [] });
  state.userDisplayName = 'Me';

  // A private stranger's bio still shows, escaped.
  docs['users/shy'] = { uid: 'shy', username: 'shy', displayName: 'Shy', avatar: '\u{1F431}', private: true,
    followers: [], following: [], followRequests: [], bio: 'Hi <img src=x onerror=alert(1)>\nsecond line',
    interests: ['\u{1F3A7} Music', 'Not a real one', '\u{1F4DA} Study'] };
  state.following = [];
  prof.openProfileScreen('shy'); await wait(350);
  const bioEl = document.querySelector('#profileAbout .profile-bio');
  out.lockedBio = !!bioEl && document.getElementById('profileScreen').classList.contains('profile-is-locked');
  out.escaped = !document.querySelector('#profileAbout img') && /<img/.test(bioEl?.textContent || '');
  out.chips = [...document.querySelectorAll('#profileAbout .interest-chip')].map((c) => c.textContent);
  prof.closeProfileScreen({ all: true }); await wait(200);

  // Your own empty profile nudges you.
  prof.openProfileScreen('me'); await wait(350);
  out.nudge = !!document.querySelector('#profileAbout .about-add');

  // Settings: pick six, get five; save; profile updates in place.
  window.openSettingsScreen(); await wait(250);
  for (let i = 0; i < 6; i++) window.toggleInterest(i);
  document.getElementById('editBioInput').value = '  CS 2027.\n\n\n\nChai > coffee.  ';
  window.onBioInput();
  out.picked = document.querySelectorAll('#settingsInterests .interest-chip.on').length;
  out.sixthDisabled = document.querySelectorAll('#settingsInterests .interest-chip:disabled').length > 0;
  window.saveProfileData(); await wait(1200);
  out.saved = docs['users/me'].bio === 'CS 2027.\n\nChai > coffee.' && docs['users/me'].interests.length === 5;
  out.shownOnOwn = (document.querySelector('#profileAbout .profile-bio')?.textContent || '').startsWith('CS 2027.');
  prof.closeProfileScreen({ all: true }); await wait(200);
  return out;
});
ok('a private account\'s bio shows even when locked', about.lockedBio);
ok('a bio is escaped, never markup', about.escaped);
ok('only known interests are shown', about.chips.join('|') === '\u{1F3A7} Music|\u{1F4DA} Study', about.chips.join('|'));
ok('an empty own profile offers to add a bio', about.nudge);
ok('interests stop at five', about.picked === 5 && about.sixthDisabled, JSON.stringify(about));
ok('saving cleans the bio and updates the profile', about.saved && about.shownOnOwn, JSON.stringify(about));

/* ------------------------------------------------------------------ */
group('editing and taking back a message');
{
  // The rules themselves: pure, so no DOM and no stub needed.
  const r = await page.evaluate(async () => {
    const mr = await import('/js/services/messageRules.js');
    const t0 = 1000000000000;
    const mine   = { id: 'm1', senderUid: 'me', text: 'hi',  time: t0 };
    const theirs = { id: 'm2', senderUid: 'a',  text: 'yo',  time: t0 };
    const old    = { id: 'm3', senderUid: 'me', text: 'old', time: t0 - 16 * 60 * 1000 };
    const gone   = { id: 'm4', senderUid: 'me', text: '',    time: t0, deleted: true };
    return {
      mineNow:     mr.messageActions(mine, 'me', t0).join(','),
      theirsNow:   mr.messageActions(theirs, 'me', t0).join(','),
      mineLate:    mr.messageActions(old, 'me', t0).join(','),
      tombstone:   mr.messageActions(gone, 'me', t0).length,
      atEdge:      mr.canEdit(mine, 'me', t0 + 15 * 60 * 1000 - 1),
      pastEdge:    mr.canEdit(mine, 'me', t0 + 15 * 60 * 1000 + 1),
      retractLate: mr.canRetract(old, 'me'),
      retractGone: mr.canRetract(gone, 'me'),
      label:       mr.editWindowLabel(mine, t0 + 3 * 60 * 1000),
      edited:      mr.isEdited({ ...mine, editedAt: t0 }),
      editedGone:  mr.isEdited({ ...gone, editedAt: t0 })
    };
  });
  ok('your own fresh message offers all four actions', r.mineNow === 'reply,copy,edit,delete', r.mineNow);
  ok("somebody else's offers reply, copy and report — never edit or delete", r.theirsNow === 'reply,copy,report', r.theirsNow);
  ok('past 15 minutes the edit is gone but delete is not', r.mineLate === 'reply,copy,delete', r.mineLate);
  ok('a tombstone offers nothing at all', r.tombstone === 0);
  ok('the window closes exactly at 15 minutes', r.atEdge === true && r.pastEdge === false);
  ok('taking a message back has no clock on it', r.retractLate === true);
  ok('a message already taken back cannot be taken back again', r.retractGone === false);
  ok('the sheet says how long is left', r.label === '12 min left', r.label);
  ok('"edited" shows on an edit, never on a tombstone', r.edited === true && r.editedGone === false);

  // The fifteen minutes run off the SERVER's stamp, not the client's
  // `time` — otherwise dating a message in the future buys an
  // unlimited edit window, and `time` is the field a sender controls.
  const clock = await page.evaluate(async () => {
    const mr = await import('/js/services/messageRules.js');
    const now = 1700000000000;
    const ts = (ms) => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0, toMillis: () => ms });
    const honest = { id: 'h', senderUid: 'me', text: 'hi', time: now, sentAt: ts(now) };
    // Claims to have been sent in the year 2099; the server says now.
    const lying  = { id: 'l', senderUid: 'me', text: 'hi', time: 4070908800000, sentAt: ts(now - 20 * 60 * 1000) };
    // Written offline hours ago, committed a moment ago: the server
    // stamp is what counts, and it says the window is open.
    const offline = { id: 'o', senderUid: 'me', text: 'hi', time: now - 5 * 60 * 60 * 1000, sentAt: ts(now) };
    const legacy = { id: 'g', senderUid: 'me', text: 'hi', time: now };
    return {
      honestOpen:  mr.canEdit(honest, 'me', now + 60 * 1000),
      honestShut:  mr.canEdit(honest, 'me', now + 16 * 60 * 1000),
      lyingShut:   mr.canEdit(lying, 'me', now),
      offlineOpen: mr.canEdit(offline, 'me', now + 60 * 1000),
      retractLying: mr.canRetract(lying, 'me'),
      legacyFalls: mr.sentMs(legacy) === now,
      readsTimestamp: mr.sentMs(honest) === now
    };
  });
  ok('the edit window reads a server Timestamp', clock.readsTimestamp === true);
  ok('and still falls back to `time` when there is no server stamp', clock.legacyFalls === true);
  ok('an honest message can be edited inside fifteen minutes', clock.honestOpen === true);
  ok('and not outside them', clock.honestShut === false);
  ok('a message dated in the future buys no extra window', clock.lyingShut === false);
  ok('but can still be taken back, which has no clock', clock.retractLying === true);
  ok('a message written offline is judged from when it landed', clock.offlineOpen === true);

  // And the whole thing end to end, against the stub.
  const dom = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = Date.now();

    state.currentChat = 'a_me';
    state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked';
    state.currentChatInitiatorUid = '';
    state.currentChatData = { unreadByUid: '', typingUid: '' };
    state.currentOtherUid = 'a';
    window.switchScreen('chatScreen');

    // One of mine, one of theirs already edited, one taken back.
    window.__docs = [
      { id: 'm1', data: () => ({ senderUid: 'me', text: 'typo heer', time: now - 60000 }) },
      { id: 'm2', data: () => ({ senderUid: 'a', text: 'fixed?', time: now - 50000, editedAt: now - 40000 }) },
      { id: 'm3', data: () => ({ senderUid: 'me', text: '', time: now - 30000, deleted: true, replyTo: null }) }
    ];
    chat.loadMessages();
    await wait(200);

    const out = {};
    const box = document.getElementById('messages');
    out.painted = box.querySelectorAll('.msg-wrapper').length;
    out.tombstones = box.querySelectorAll('.msg-gone').length;
    out.tombstoneText = (box.querySelector('.msg-gone')?.innerText || '').trim();
    out.editedTags = box.querySelectorAll('.msg-edited').length;
    out.tombstoneInert = !!box.querySelector('[data-deleted="1"]')
      && !box.querySelector('[data-deleted="1"] .swipe-reply-icon');

    const sheetRows = () => Array.from(document.querySelectorAll('#msgActionList .action-row'))
      .map((b) => b.getAttribute('data-act')).join(',');

    chat.openMessageActions('m1');
    await wait(60);
    out.mineRows = sheetRows();
    out.quoted = document.getElementById('msgActionQuote')?.innerText || '';
    chat.closeMessageActions();
    await wait(120);

    chat.openMessageActions('m2');
    await wait(60);
    out.theirRows = sheetRows();
    chat.closeMessageActions();
    await wait(120);

    // A tombstone must not open the sheet at all.
    chat.openMessageActions('m3');
    await wait(60);
    out.sheetOnTombstone = !document.getElementById('msgActionSheet').classList.contains('hidden');
    await wait(60);

    // ---- Edit ----
    window.__updates = [];
    chat.startEditMessage('m1');
    await wait(80);
    const input = document.getElementById('msgInput');
    out.loadedIntoBox = input.value;
    out.noteIsEditing = !!document.querySelector('.compose-note.editing');
    out.sendBecameTick = document.getElementById('sendBtn')?.dataset.mode === 'edit'
      && !!document.querySelector('#sendBtn svg');

    input.value = 'typo here';
    await window.sendMessage();
    await wait(120);
    const edit = (window.__updates || []).slice(-1)[0] || {};
    out.editKeys = (edit.keys || []).sort().join(',');
    out.editText = edit.patch?.text;
    // A server sentinel, not a number the sender chose.
    out.editStamped = !!edit.patch?.editedAt && edit.patch.editedAt.__op === 'now';
    out.boxCleared = input.value === '';
    out.noteGone = !document.querySelector('.compose-note');
    out.editedOnScreen = box.querySelectorAll('.msg-edited').length;

    // ---- Delete, through the sheet and the confirm ----
    window.__updates = [];
    chat.openMessageActions('m1');
    await wait(60);
    document.querySelector('#msgActionList .action-row[data-act="delete"]').click();
    await wait(140);
    out.asked = !document.getElementById('confirmSheet').classList.contains('hidden');
    window.confirmYes();
    await wait(200);
    const del = (window.__updates || []).slice(-1)[0] || {};
    out.deleteKeys = (del.keys || []).sort().join(',');
    out.deleteBlanks = del.patch?.text === '' && del.patch?.deleted === true && del.patch?.replyTo === null;
    out.tombstonesAfter = box.querySelectorAll('.msg-gone').length;
    out.stillThere = box.querySelectorAll('.msg-wrapper').length;

    chat.closeChat({ silent: true });
    window.showTab('events');
    await wait(120);
    return out;
  });

  ok('three messages paint', dom.painted === 3, String(dom.painted));
  ok('a deleted message reads "This message was deleted"', dom.tombstones === 1
     && /This message was deleted/.test(dom.tombstoneText), dom.tombstoneText);
  ok('an edited message is marked edited', dom.editedTags === 1, String(dom.editedTags));
  ok('a tombstone cannot be swiped to reply', dom.tombstoneInert === true);
  ok('the sheet offers edit and delete on your own message',
     dom.mineRows === 'reply,copy,edit,delete', dom.mineRows);
  ok('the sheet quotes the message it is acting on', /typo heer/.test(dom.quoted), dom.quoted);
  ok("the sheet offers neither on somebody else's, and Report instead", dom.theirRows === 'reply,copy,report', dom.theirRows);
  ok('the sheet refuses to open on a tombstone', dom.sheetOnTombstone === false);
  ok('editing loads the message into the box', dom.loadedIntoBox === 'typo heer', dom.loadedIntoBox);
  ok('the composer says it is editing', dom.noteIsEditing === true && dom.sendBecameTick === true,
     JSON.stringify({ n: dom.noteIsEditing, s: dom.sendBecameTick }));
  ok('saving writes only text and editedAt', dom.editKeys === 'editedAt,text', dom.editKeys);
  ok('saving writes the new text, stamped by the server', dom.editText === 'typo here' && dom.editStamped,
     JSON.stringify({ t: dom.editText, s: dom.editStamped }));
  ok('the composer goes back to normal after saving', dom.boxCleared && dom.noteGone);
  ok('the edited message is marked edited on screen', dom.editedOnScreen === 2, String(dom.editedOnScreen));
  ok('deleting asks first, in the app, not the browser', dom.asked === true);
  ok('deleting writes only the tombstone fields',
     dom.deleteKeys === 'deleted,deletedAt,replyTo,text', dom.deleteKeys);
  ok('deleting blanks the text and drops the quote', dom.deleteBlanks === true);
  ok('the row stays behind as a tombstone', dom.tombstonesAfter === 2 && dom.stillThere === 3,
     JSON.stringify({ t: dom.tombstonesAfter, s: dom.stillThere }));
}

/* ------------------------------------------------------------------ */
group('a screen change takes its layers with it');
{
  const layered = await page.evaluate(async () => {
    const { state, orbit, prof } = window.__m;
    const chat = await import('/js/services/chatService.js');
    const ov = await import('/js/utils/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const shown = (id) => {
      const el = document.getElementById(id);
      return !!el && !el.classList.contains('hidden');
    };
    const out = {};

    state.userCache.lay = { uid: 'lay', username: 'lay', displayName: 'Lay', avatar: '\u{1F98A}' };
    state.orbitUids = ['lay'];

    // From the ORBIT screen, which is a layer at z-index 1500.
    orbit.openOrbitScreen();
    await wait(200);
    out.orbitOpen = shown('orbitScreen');

    prof.openProfileScreen('lay');
    await wait(300);
    // The profile used to open UNDERNEATH the orbit list, and pressing
    // back — which closed the list — was how you found out.
    out.orbitGone = !shown('orbitScreen');
    out.profileUp = shown('profileScreen');
    out.stackEmpty = !ov.anyOverlayOpen();

    prof.closeProfileScreen({ all: true });
    await wait(200);

    // Same for a conversation opened from a layer.
    orbit.openOrbitScreen();
    await wait(200);
    chat.openChat('lay_me', 'lay');
    await wait(250);
    out.chatOverOrbit = shown('chatScreen') && !shown('orbitScreen');
    chat.closeChat({ silent: false });
    await wait(200);

    state.orbitUids = [];
    return out;
  });
  ok('the orbit screen opens as a layer', layered.orbitOpen === true);
  ok('opening a profile from it closes the layer', layered.orbitGone === true,
     JSON.stringify(layered));
  ok('and the profile is the screen you are on', layered.profileUp === true);
  ok('with nothing left on the overlay stack', layered.stackEmpty === true);
  ok('a conversation opened from a layer is not under it either',
     layered.chatOverOrbit === true);
}

/* ------------------------------------------------------------------ */
group('who sits where in the feed');
{
  const rank = await page.evaluate(async () => {
    const f = await import('/js/services/feedRules.js');
    const H = 60 * 60 * 1000;
    const t = 1700000000000;
    const graph = { uid: 'me', orbit: ['orb'], following: ['fol'], vouchedBy: ['vou'] };
    const ev = (id, host, startsIn) => ({ id, hostUid: host, startTime: t + startsIn });
    const order = (list) => f.rankFeed(list, graph, t).map((e) => e.id).join(',');

    return {
      // Who you know, in order.
      mine: f.hostRank('me', graph), orb: f.hostRank('orb', graph),
      fol: f.hostRank('fol', graph), vou: f.hostRank('vou', graph),
      str: f.hostRank('nobody', graph),

      // Live always beats upcoming, whoever is hosting.
      liveWins: order([ev('soonFriend', 'orb', 5 * 60e3), ev('liveStranger', 'zz', -10 * 60e3)]),

      // Inside one hour, the people you know come first — and in the
      // order the weights say.
      withinTheHour: order([
        ev('stranger', 'zz', 10 * 60e3),
        ev('friend', 'fol', 20 * 60e3),
        ev('orbit', 'orb', 30 * 60e3),
        ev('vouched', 'vou', 40 * 60e3)
      ]),

      // But URGENCY still wins across buckets: a stranger's thing in
      // five minutes is above a friend's in six hours.
      urgencyWins: order([ev('friendLater', 'orb', 6 * H), ev('strangerSoon', 'zz', 5 * 60e3)]),

      // Two strangers an hour apart are in the order they always were.
      unchanged: order([ev('later', 'zz', 3 * H), ev('sooner', 'yy', 30 * 60e3)]),

      // Live events: most recently started first, as before.
      liveOrder: order([ev('old', 'zz', -3 * H), ev('fresh', 'yy', -5 * 60e3)]),

      // Your own sits top of its bucket.
      ownFirst: order([ev('theirs', 'orb', 10 * 60e3), ev('ours', 'me', 20 * 60e3)]),

      buckets: [f.timeBucket(ev('a', 'z', -1), t), f.timeBucket(ev('b', 'z', 5 * 60e3), t)]
    };
  });
  ok('your own event outranks everyone', rank.mine > rank.orb);
  ok('orbit outranks a one-way follow', rank.orb > rank.fol);
  ok('a follow outranks a vouched stranger', rank.fol > rank.vou);
  ok('and a vouched stranger outranks a stranger', rank.vou > rank.str);
  ok('anything live is above anything upcoming', rank.liveWins === 'liveStranger,soonFriend', rank.liveWins);
  ok('within the hour, the people you know come first',
     rank.withinTheHour === 'orbit,friend,vouched,stranger', rank.withinTheHour);
  ok('but a stranger five minutes away beats a friend six hours away',
     rank.urgencyWins === 'strangerSoon,friendLater', rank.urgencyWins);
  ok('two strangers still sort by the clock', rank.unchanged === 'sooner,later', rank.unchanged);
  ok('live events are still newest-first', rank.liveOrder === 'fresh,old', rank.liveOrder);
  ok('your own event leads its bucket', rank.ownFirst === 'ours,theirs', rank.ownFirst);
  ok('a live bucket always sorts above an upcoming one', rank.buckets[0] < rank.buckets[1],
     JSON.stringify(rank.buckets));

  // And through the real feed, not just the comparator.
  const feed = await page.evaluate(async () => {
    const { state, ev } = window.__m;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = Date.now();
    const mk = (id, host, startsIn) => ({
      id, hostUid: host, title: id, place: 'Lawn', tag: '☕ Chill',
      startTime: t + startsIn, expiresAt: t + 6 * 3600e3,
      participantUids: [host], hypedUids: [], circleId: 'main'
    });
    ['zz', 'orb'].forEach((u) => {
      state.userCache[u] = { uid: u, username: u, displayName: u, avatar: '\u{1F98A}' };
    });
    state.orbitUids = ['orb'];
    state.following = [];
    window.__events = [mk('stranger', 'zz', 10 * 60e3), mk('orbit', 'orb', 30 * 60e3)];
    ev.loadEvents();
    await wait(400);
    const out = { order: state.eventOrder.join(',') };
    state.orbitUids = [];
    return out;
  });
  ok('the feed itself puts your orbit above a stranger in the same hour',
     feed.order === 'orbit,stranger', feed.order);
}

/* ------------------------------------------------------------------ */
group('circles, and the geography under them');
{
  // The hashes are checked against the reference implementation's own
  // worked examples. This matters more than it looks: nothing queries
  // a geohash yet, so a wrong one would sit in the database unnoticed
  // until the day the feed switches — and THAT is the migration this
  // whole field exists to avoid.
  const geo = await page.evaluate(async () => {
    const g = await import('/js/services/geoRules.js');
    return {
      ezs42: g.geohash(42.6, -5.6, 5),
      london: g.geohash(51.5074, -0.1278, 7),
      origin: g.geohash(0, 0, 6),
      prefixShared: g.geohash(51.5074, -0.1278, 5) === g.geohash(51.5079, -0.1271, 5),
      precision1km: g.precisionForRadius(1000),
      range: JSON.stringify(g.rangeFor('gcpvj')),
      km: Math.round(g.distanceM({ lat: 51.5, lng: -0.12 }, { lat: 51.52, lng: -0.12 })),
      badLat: g.geohash(999, 0, 9),
      point: JSON.stringify(g.geoPoint(42.6, -5.6, 5)),
      noPoint: g.geoPoint(NaN, 0)
    };
  });
  ok('a geohash matches the reference implementation', geo.ezs42 === 'ezs42' && geo.london === 'gcpvj0d',
     geo.ezs42 + ' / ' + geo.london);
  ok('and the origin is where it should be', geo.origin === 's00000', geo.origin);
  ok('two points in the same box share a prefix', geo.prefixShared === true);
  ok('a kilometre wants five characters or so', geo.precision1km === 6, String(geo.precision1km));
  ok('a prefix range is bounded the way Firestore needs',
     geo.range === '{"start":"gcpvj","end":"gcpvj"}', geo.range);
  ok('distance is about right', geo.km > 2100 && geo.km < 2300, String(geo.km));
  ok('an impossible latitude gets no hash at all', geo.badLat === '');
  ok('a point carries its own hash', geo.point === '{"lat":42.6,"lng":-5.6,"geohash":"ezs42"}', geo.point);
  ok('and no point is null, never zero,zero', geo.noPoint === null);

  // The feed is partitioned. Without this it was the sixty events
  // ending furthest away in the whole database.
  const scoped = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const circle = await import('/js/services/circleService.js');
    const ev = await import('/js/services/eventsService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};

    out.defaultsToMain = (state.circleId = '', circle.myCircleId() === 'main');
    state.circleId = 'northgate';
    out.readsTheField = circle.myCircleId() === 'northgate';

    // No circle document is a normal state: the app works, there is
    // simply no name and no point to stamp.
    state.circleDoc = null;
    out.noDocNoGeo = circle.circleGeo() === null && circle.circleName() === '';

    state.circleDoc = { id: 'northgate', name: 'North Gate', lat: 42.6, lng: -5.6 };
    out.named = circle.circleName() === 'North Gate';
    const g = circle.circleGeo();
    out.stamps = !!g && g.geohash.indexOf('ezs42') === 0;

    // A circle whose document has no coordinates stamps nothing —
    // unless FALLBACK_GEO has been filled in, which is the one place
    // to put a campus when there is no circle document at all.
    state.circleDoc = { id: 'northgate', name: 'North Gate' };
    out.noCoordsNoStamp = circle.FALLBACK_GEO
      ? circle.circleGeo() !== null
      : circle.circleGeo() === null;
    out.fallbackIsNullByDefault = circle.FALLBACK_GEO === null;

    // The recap query really filters on it — the stub applies where().
    state.circleId = 'main';
    state.circleDoc = null;
    const H = 3600e3, t = Date.now();
    // Hosted by a stranger and attended by strangers, ON PURPOSE: the
    // receipt folds anything in the event cache that YOU were at, and
    // this test loads the recap twice. An event with 'me' in it would
    // quietly inflate somebody else's assertions further down.
    const past = (id, cid) => ({ id, hostUid: 'zz', title: id, place: 'Lawn', tag: '☕ Chill',
      startTime: t - 3 * H, expiresAt: t - H, participantUids: ['zz', 'g1'], hypedUids: [], circleId: cid });
    const loadRecap = async () => {
      state.recapOrder = []; state.recapCursor = null; state.recapDone = false;
      await ev.loadRecap({ reset: true });
      await wait(200);
      return state.recapOrder.slice();
    };
    window.__events = [past('mine', 'main'), past('theirs', 'elsewhere')];

    // OFF by default, and that is the point: one college, everybody in
    // `main`, so the filter removes nothing and costs an index.
    out.offByDefault = circle.feedIsScoped() === false;
    const unscoped = await loadRecap();
    out.seesEverything = unscoped.includes('mine') && unscoped.includes('theirs');

    // And turning it on is one line, with the events already tagged.
    circle.setFeedScoping(true);
    const scopedOrder = await loadRecap();
    out.recapMine = scopedOrder.includes('mine');
    out.recapNotTheirs = !scopedOrder.includes('theirs');
    circle.setFeedScoping(false);

    // Leave the cache as it was found.
    ['mine', 'theirs'].forEach((id) => {
      delete state.eventCache[id];
      state.recapOrder = (state.recapOrder || []).filter((x) => x !== id);
      state.eventOrder = (state.eventOrder || []).filter((x) => x !== id);
    });
    window.__events = [];
    return out;
  });
  ok('no circle on the account still means a feed', scoped.defaultsToMain === true);
  ok('and one that is set is the one used', scoped.readsTheField === true);
  ok('a circle with no document is not an error', scoped.noDocNoGeo === true);
  ok('a circle with a document carries its name', scoped.named === true);
  ok('and stamps events with its position', scoped.stamps === true, JSON.stringify(scoped));
  ok('a circle with no coordinates falls back, or stamps nothing', scoped.noCoordsNoStamp === true);
  ok('and nothing is guessed until somebody fills it in', scoped.fallbackIsNullByDefault === true);
  ok('recap shows your own circle', scoped.recapMine === true, JSON.stringify(scoped));
  ok("and not somebody else's", scoped.recapNotTheirs === true);

  // A listener that errors is dead, and `failed-precondition` means
  // the query has no index — which no amount of waiting builds. It
  // used to back off 1.2s, 2.4s, 4.8s... and then stop in silence, so
  // a missing index read as a feed that had merely gone slow.
  const noIndex = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // An empty feed first: the failure message deliberately refuses to
    // paint over cards that are already on screen, because stale real
    // events beat an error box.
    window.__events = [];
    ev.loadEvents();
    await wait(300);

    window.__eventsFail = { code: 'failed-precondition' };
    const before = (window.__eventCbs || []).length;
    ev.loadEvents();
    await wait(600);
    const out = {
      saidSo: /can't reach the feed/i.test(document.getElementById('events')?.innerText || ''),
      // And a way back out of it, which a dead feed never used to have.
      offersAWayBack: !!document.querySelector('#events button'),
      gaveUp: (window.__eventCbs || []).length <= before + 1
    };
    window.__eventsFail = null;
    return out;
  });
  ok('a feed with no index says so instead of going quiet', noIndex.saidSo === true,
     JSON.stringify(noIndex));
  ok('and leaves a way back rather than skeletons forever', noIndex.offersAWayBack === true);
  ok('and does not sit there retrying something that cannot succeed', noIndex.gaveUp === true);
  // That test breaks the feed ON PURPOSE, and the whole point of it is
  // that the app complains loudly — so the complaint is expected, and
  // the sweep at the end should not count it.
  {
    const deliberate = errors.filter((e) => /failed-precondition|has no index/.test(e));
    deliberate.forEach((e) => errors.splice(errors.indexOf(e), 1));
    ok('and the complaint is loud enough to be seen', deliberate.length >= 1,
       String(deliberate.length));
  }
  // Put the feed back, so nothing after this runs against a dead one.
  await page.evaluate(async () => {
    const ev = await import('/js/services/eventsService.js');
    window.__eventsFail = null;
    ev.loadEvents();
  });
  await page.waitForTimeout(200);
}

/* ------------------------------------------------------------------ */
group('screens that are already open');
{
  const live = await page.evaluate(async () => {
    const { state, follow, orbit, prof } = window.__m;
    const ui = await import('/js/utils/ui.js');
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const docs = window.__stubDocs;
    const out = {};

    // ---- The Orbit screen carries "Want to follow you" -------------
    state.followRequests = [];
    state.userCache.w1 = { uid: 'w1', username: 'w1', displayName: 'W One', avatar: '' };
    orbit.openOrbitScreen();
    await wait(150);
    out.startsEmpty = !/Want to follow you/.test(document.getElementById('orbitBody')?.innerHTML || '');

    // Somebody asks while it is open. It used to repaint only when the
    // ORBIT listener fired, so a follow request left it showing stale.
    state.followRequests = ['w1'];
    ui.refreshSocialUI();
    await wait(80);
    out.showsTheAsk = /Want to follow you/.test(document.getElementById('orbitBody')?.innerHTML || '');

    // And answering it takes the row away again.
    state.followRequests = [];
    ui.refreshSocialUI();
    await wait(80);
    out.clearsAgain = !/Want to follow you/.test(document.getElementById('orbitBody')?.innerHTML || '');
    orbit.closeOrbitScreen();
    await wait(150);

    // ---- Being approved while you sit on their profile -------------
    docs['users/appr'] = { uid: 'appr', username: 'appr', displayName: 'Appr',
      avatar: '\u{1F98A}', banned: false, private: true, following: [], followerCount: 0 };
    delete docs['users/appr/followers/me'];
    state.following = [];
    state.userCache.appr = { uid: 'appr', username: 'appr', displayName: 'Appr', avatar: '', private: true };

    prof.openProfileScreen('appr');
    await wait(350);
    out.notFollowingYet = !follow.isFollowing('appr');

    // They approve: a document arrives under THEIR profile. Nothing on
    // this side used to be watching it, so the button went on saying
    // "Requested" until you backed out and came in again.
    docs['users/appr/followers/me'] = { at: Date.now() };
    window.__fireDoc('users/appr/followers/me');
    await wait(250);
    out.followsNow = follow.isFollowing('appr');

    prof.closeProfileScreen({ all: true });
    await wait(150);
    return out;
  });
  ok('the orbit screen starts without a request on it', live.startsEmpty === true);
  ok('a request arriving repaints it while it is open', live.showsTheAsk === true);
  ok('and answering one takes the row off again', live.clearsAgain === true);
  ok('a profile you are asking starts as not-following', live.notFollowingYet === true);
  ok('being approved lands on the profile you are standing on', live.followsNow === true);

  // ---- The icebreaker is for strangers ----------------------------
  const ice = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wrapper = document.getElementById('inputWrapper');
    const out = {};

    state.currentChat = 'x_me';
    state.currentChatType = 'direct';
    state.currentOtherUid = 'x';
    state.currentChatStatus = 'icebreaker';
    state.currentChatInitiatorUid = 'me';
    state.myMessageCount = 1;
    window.switchScreen('chatScreen');

    // A stranger: one message, then the box closes until they answer.
    state.currentChatMutual = false;
    chat.updateChatFooterUI();
    out.strangerLocked = wrapper.classList.contains('hidden');

    // Two people who follow each other are not strangers, and this
    // holds on a thread that began before either of them followed.
    state.currentChatMutual = true;
    chat.updateChatFooterUI();
    out.mutualOpen = !wrapper.classList.contains('hidden');

    state.currentChatMutual = false;
    chat.closeChat({ silent: true });
    return out;
  });
  ok('a stranger still gets one message until they reply', ice.strangerLocked === true);
  ok('but people who follow each other have no limit', ice.mutualOpen === true);
}

/* ------------------------------------------------------------------ */
group('stamps');
{
  const pure = await page.evaluate(async () => {
    const f = await import('/js/utils/formatters.js');
    const ms = 1700000000000;
    const ts = { seconds: Math.floor(ms / 1000), nanoseconds: 0, toMillis: () => ms };
    const raw = { seconds: Math.floor(ms / 1000), nanoseconds: 0 };   // no toMillis
    return {
      number: f.msOf(ms) === ms,
      timestamp: f.msOf(ts) === ms,
      rawShape: f.msOf(raw) === ms,
      date: f.msOf(new Date(ms)) === ms,
      nothing: f.msOf(null) === 0 && f.msOf(undefined) === 0,
      formats: f.formatTime(ts) === f.formatTime(ms)
    };
  });
  ok('a stamp reads the same whether it is a number or a Timestamp',
     pure.number && pure.timestamp && pure.date, JSON.stringify(pure));
  ok('including one that has not been through the SDK', pure.rawShape === true);
  ok('and a missing stamp is zero, not a crash', pure.nothing === true);
  ok('so the same moment formats the same either way', pure.formats === true);

  // An event's start and end are chosen, not "now" — but the live feed
  // is the sixty events with the furthest-away end date, so unbounded
  // they were a way to own the feed permanently.
  const publish = await page.evaluate(async () => {
    const ev = await import('/js/services/eventsService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const DAY = 24 * 60 * 60 * 1000;
    const iso = (ms) => {
      const d = new Date(ms);
      return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const attempt = async (start, end) => {
      ev.openCreateScreen();
      document.getElementById('title').value = 'Thing';
      document.getElementById('place').value = 'Lawn';
      document.getElementById('startTime').value = iso(start);
      document.getElementById('endTime').value = iso(end);
      window.__lastBatch = null;
      await ev.addEvent();
      await wait(80);
      const ops = window.__lastBatch || [];
      return ops.find((o) => String(o.path).indexOf('events/') === 0) || null;
    };

    const now = Date.now();
    const out = {};

    // The year 9999 — sixty of these were the whole feed, for everybody.
    out.squat = !(await attempt(now + 60000, 253370764800000));
    // Nine days is longer than the app has ever allowed.
    out.tooLong = !(await attempt(now + 60000, now + 9 * DAY));
    // Half a year ahead.
    out.tooFar = !(await attempt(now + 180 * DAY, now + 180 * DAY + 3600000));

    const good = await attempt(now + 60000, now + 2 * 3600000);
    out.published = !!good;
    out.ttlIsTimestamp = !!good && !!good.data.ttlAt && typeof good.data.ttlAt.toMillis === 'function';
    out.ttlFollowsEnd = out.ttlIsTimestamp
      && good.data.ttlAt.toMillis() === good.data.expiresAt + 72 * 60 * 60 * 1000;
    out.createdOnServer = !!good && good.data.createdAt && good.data.createdAt.__op === 'now';
    ev.closeCreateScreen();
    await wait(120);
    return out;
  });
  ok('an event dated the year 9999 is refused', publish.squat === true);
  ok('so is one that runs longer than a week', publish.tooLong === true);
  ok('and one starting half a year out', publish.tooFar === true);
  ok('an ordinary event still publishes', publish.published === true, JSON.stringify(publish));
  ok('and carries a real Timestamp for the sweep', publish.ttlIsTimestamp === true);
  ok('set from when it ends, not from now', publish.ttlFollowsEnd === true);
  ok('while createdAt is the server saying so', publish.createdOnServer === true);
}

/* ------------------------------------------------------------------ */
group('a thread that stays put');
{
  const thread = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now() - 60 * 60 * 1000;
    const msg = (n) => ({ id: 'n' + n, data: () => ({ senderUid: n % 2 ? 'a' : 'me', text: 'm' + n, time: t0 + n * 1000 }) });
    const range = (from, to) => { const out = []; for (let i = from; i <= to; i++) out.push(msg(i)); return out; };
    const BASE = 'chats/a_me/messages';
    const out = {};

    state.currentChat = 'a_me';
    state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked';
    state.currentChatInitiatorUid = '';
    state.currentChatData = { unreadByUid: '', typingUid: '' };
    state.currentOtherUid = 'a';
    window.switchScreen('chatScreen');
    const box = document.getElementById('messages');
    box.innerHTML = '';

    // ---- The live window is the newest 25: n2..n26 of a 26-message thread.
    window.__docs = range(2, 26);
    chat.loadMessages();
    await wait(200);
    out.windowPainted = box.querySelectorAll('.msg-wrapper').length;

    // Scroll back one page: n1, fetched with endBefore(n2).
    window.__docs = [msg(1)];
    await chat.loadOlderMessages();
    await wait(200);
    out.afterHistory = box.querySelectorAll('.msg-wrapper').length;

    // ---- A new message arrives. The window slides to n3..n27, so n2
    // falls off the FRONT of it — and history stopped before n2, so
    // nothing would ever fetch it again. It used to vanish out of the
    // middle of the thread you were reading.
    window.__docs = range(3, 27);
    window.__fireColl(BASE);
    await wait(200);
    out.afterNewMessage = box.querySelectorAll('.msg-wrapper').length;
    out.n2StillThere = !!document.getElementById('msg-n2');
    out.noGap = ['n1', 'n2', 'n3', 'n4'].every((id) => !!document.getElementById('msg-' + id));

    // ---- And the thread is patched, not rebuilt. Mark a node and open
    // its timestamp; both have to survive the next message arriving.
    // Guarded: if the bubbles are not identified by their document id
    // this is null, and a crash here would hide the assertion below.
    const marked = document.getElementById('msg-n10');
    if (marked) {
      marked.dataset.marker = 'kept';
      marked.classList.add('show-time');
    }
    out.markable = !!marked;
    window.__docs = range(3, 28);
    window.__fireColl(BASE);
    await wait(200);
    const after = document.getElementById('msg-n10');
    out.sameNode = !!after && after.dataset.marker === 'kept';
    out.timeStayedOpen = !!after && after.classList.contains('show-time');
    out.grew = box.querySelectorAll('.msg-wrapper').length === out.afterNewMessage + 1;

    chat.closeChat({ silent: true });
    await wait(120);
    return out;
  });
  ok('the live window paints 25 of 26', thread.windowPainted === 25, String(thread.windowPainted));
  ok('a page of history prepends the 26th', thread.afterHistory === 26, String(thread.afterHistory));
  ok('a message leaving the live window is kept, not dropped',
     thread.n2StillThere === true && thread.afterNewMessage === 27,
     JSON.stringify({ n2: thread.n2StillThere, count: thread.afterNewMessage }));
  ok('so the thread has no hole in the middle of it', thread.noGap === true);
  ok('a bubble is identified by its document id', thread.markable === true);
  ok('an incoming message does not rebuild the bubbles already on screen', thread.sameNode === true);
  ok('and does not close a timestamp the reader had opened', thread.timeStayedOpen === true);
  ok('while the new message itself still arrives', thread.grew === true);

  // ---- Two messages in the same millisecond -------------------------
  const sameMs = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = Date.now() - 5000;

    state.currentChat = 'b_me';
    state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked';
    state.currentChatInitiatorUid = '';
    state.currentChatData = { unreadByUid: '', typingUid: '' };
    state.currentOtherUid = 'b';
    window.switchScreen('chatScreen');
    document.getElementById('messages').innerHTML = '';

    // Identical timestamps, which is all it takes: a bubble used to be
    // identified in the DOM by WHEN it was sent.
    window.__docs = [
      { id: 'sa', data: () => ({ senderUid: 'b', text: 'first', time: t }) },
      { id: 'sb', data: () => ({ senderUid: 'b', text: 'second', time: t }) },
      { id: 'sc', data: () => ({ senderUid: 'me', text: 'answering the first',
          time: t, replyTo: { senderUid: 'b', text: 'first', id: 'sa' } }) }
    ];
    chat.loadMessages();
    await wait(200);

    const out = {};
    out.bothBubbles = !!document.getElementById('msg-sa') && !!document.getElementById('msg-sb');
    out.wrappers = document.querySelectorAll('.msg-wrapper').length;
    out.quotePointsAtFirst =
      document.querySelector('.msg-replied-to')?.getAttribute('data-target-id') === 'sa';

    chat.initiateReply('b', 'second', 'sb');
    out.replyCarriesId = state.replyingToMessage && state.replyingToMessage.id === 'sb';
    chat.cancelReply();

    chat.closeChat({ silent: true });
    await wait(120);
    return out;
  });
  // Sending a message CHANGES the one above it — a lone bubble becomes
  // the top of a pair, which is a different shape and so different
  // markup, so the diff rebuilds it. That is correct. What was not is
  // that a rebuilt bubble replayed the arrival animation, so your own
  // send made the message above it drop out and rise back in.
  const regroup = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = Date.now() - 60000;
    const BASE = 'chats/r_me/messages';

    state.currentChat = 'r_me';
    state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked';
    state.currentChatInitiatorUid = '';
    state.currentChatMutual = false;
    state.currentChatData = { unreadByUid: '', typingUid: '' };
    state.currentOtherUid = 'r';
    window.switchScreen('chatScreen');
    document.getElementById('messages').innerHTML = '';

    const mine = (id, at) => ({ id, data: () => ({ senderUid: 'me', text: id, time: at }) });
    window.__docs = [mine('one', t)];
    chat.loadMessages();
    await wait(250);

    const first = document.getElementById('msg-one');
    const out = { painted: !!first };
    out.shapeBefore = first ? first.querySelector('.msg-bubble').className : '';
    // It animated on the way in, which is right — it had just arrived.
    out.firstArrived = !!first && getComputedStyle(first).animationName === 'rise';

    // Now send a second from the same person.
    window.__docs = [mine('one', t), mine('two', t + 1000)];
    window.__fireColl(BASE);
    await wait(250);

    const after = document.getElementById('msg-one');
    const fresh = document.getElementById('msg-two');
    out.bothThere = !!after && !!fresh;
    out.shapeAfter = after ? after.querySelector('.msg-bubble').className : '';
    out.regrouped = out.shapeBefore !== out.shapeAfter;
    /* The COMPUTED animation, not a class — the bug was that `rise`
       sat on .msg-wrapper itself, so there was no class to be missing.
       A node that is merely rebuilt must come back with no animation at
       all; one that genuinely arrived must have it. */
    out.oldOneStayedPut = !!after && getComputedStyle(after).animationName === 'none';
    out.newOneArrived = !!fresh && getComputedStyle(fresh).animationName === 'rise';

    chat.closeChat({ silent: true });
    await wait(120);
    return out;
  });
  // The floating date answers "which day am I looking at" — a question
  // you ask by scrolling. The thread scrolls ITSELF to the bottom on
  // every new message, and that fires a real scroll event, so sending
  // one used to flash a date chip over the thread.
  const chip = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = Date.now() - 60000;
    const BASE = 'chats/d_me/messages';

    state.currentChat = 'd_me';
    state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked';
    state.currentChatInitiatorUid = '';
    state.currentChatMutual = false;
    state.currentChatData = { unreadByUid: '', typingUid: '' };
    state.currentOtherUid = 'd';
    window.switchScreen('chatScreen');
    document.getElementById('messages').innerHTML = '';

    // Long enough to actually scroll — a thread that fits on screen
    // never fires a scroll event and would prove nothing either way.
    const body = 'a message with enough words in it to take up a line or two of the thread';
    const msg = (n) => ({ id: 'd' + n, data: () => ({ senderUid: 'me', text: body + ' ' + n, time: t + n * 1000 }) });
    const upTo = (n) => { const out = []; for (let i = 1; i <= n; i++) out.push(msg(i)); return out; };

    window.__docs = upTo(24);
    chat.loadMessages();
    await wait(400);

    const box = document.getElementById('messages');
    const out = { scrollable: box.scrollHeight > box.clientHeight + 50 };

    const seen = () => {
      const el = document.getElementById('floatingDate');
      return !!el && el.classList.contains('visible');
    };
    document.getElementById('floatingDate')?.classList.remove('visible');

    // A message arrives; the thread scrolls itself to the bottom, and
    // setting scrollTop fires a real scroll event.
    window.__docs = upTo(25);
    window.__fireColl(BASE);
    await wait(300);
    out.quietOnSend = !seen();

    // But a thumb still gets an answer.
    await wait(250);          // past the window our own scroll claims
    chat.handleChatScroll();
    await wait(60);
    out.answersAScroll = seen();

    chat.closeChat({ silent: true });
    await wait(120);
    return out;
  });
  ok('the thread is tall enough for this to mean anything', chip.scrollable === true,
     JSON.stringify(chip));
  ok('sending a message does not flash the date over the thread', chip.quietOnSend === true,
     JSON.stringify(chip));
  ok('but scrolling still says which day you are on', chip.answersAScroll === true,
     JSON.stringify(chip));

  ok('the first message paints, and rises in', regroup.painted === true && regroup.firstArrived === true,
     JSON.stringify(regroup));
  ok('sending regroups the bubble above it', regroup.regrouped === true,
     regroup.shapeBefore + ' -> ' + regroup.shapeAfter);
  ok('and both messages are on screen', regroup.bothThere === true);
  ok('but the one above does NOT replay its arrival', regroup.oldOneStayedPut === true,
     JSON.stringify(regroup));
  ok('while the message that really arrived does', regroup.newOneArrived === true);

  ok('two messages sent in the same millisecond are still two bubbles',
     sameMs.bothBubbles === true && sameMs.wrappers === 3, JSON.stringify(sameMs));
  ok('a quote points at the message, not at a moment in time', sameMs.quotePointsAtFirst === true);
  ok('and replying carries the message id', sameMs.replyCarriesId === true);

  // ---- Leaving one conversation for another --------------------------
  const carried = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const wrapper = document.getElementById('inputWrapper');
    const out = {};

    // An icebreaker you opened and have already used: composer locked.
    state.currentChat = 'c_me';
    state.currentChatType = 'direct';
    state.currentOtherUid = 'c';
    state.currentChatStatus = 'icebreaker';
    state.currentChatInitiatorUid = 'me';
    state.myMessageCount = 1;
    state.currentChatMutual = false;   // strangers: the wall applies
    window.switchScreen('chatScreen');
    chat.updateChatFooterUI();
    out.lockedThere = wrapper.classList.contains('hidden');

    // Now open somebody else. Anything that repaints before that chat's
    // document arrives used to read the PREVIOUS conversation's state
    // and hide the composer at the wrong person.
    chat.openChat('d_me', 'd');
    out.statusCleared = state.currentChatStatus === 'unlocked'
      && state.currentChatInitiatorUid === ''
      && state.myMessageCount === 0;
    chat.updateChatFooterUI();
    out.openHere = !wrapper.classList.contains('hidden');

    chat.closeChat({ silent: true });
    return out;
  });
  ok('a used icebreaker locks its own composer', carried.lockedThere === true);
  ok('and opening another conversation clears it', carried.statusCleared === true);
  ok('so the next composer is not locked by the last one', carried.openHere === true);
}

/* ------------------------------------------------------------------ */
group('the poster band');
{
  // The halftone has slid under the band's type twice now — first
  // because it was a background layer across the whole band, then
  // because the place sat on the right where the dots are. Averaged
  // over the band the contrast looked fine both times; on the pixel
  // where a dot met a letter it was 2.4:1. Colour checks cannot see
  // that, so this one measures geometry: every word in the band has to
  // finish before the dot field starts.
  const band = await page.evaluate(async ({ events }) => {
    const { state, ev } = window.__m;
    state.eventCache = {};
    state.eventOrder = [];
    events.forEach((e) => { state.eventCache[e.id] = e; state.eventOrder.push(e.id); });
    state.recapOrder = state.eventOrder.filter((id) => state.eventCache[id].expiresAt <= Date.now());
    state.recapDone = true; state.currentLiveFilter = 'All'; state.currentRecapFilter = 'All';
    ev.renderEvents();
    await new Promise((r) => setTimeout(r, 200));

    const out = [];
    // BOTH feeds, and each one has to be ON SCREEN while it is
    // measured. A hidden tab is display:none, and every rect inside a
    // display:none subtree is 0x0 — so measuring the recap tab from
    // the live tab silently "passes" everything while checking
    // nothing, which is exactly what it did the first time.
    const measure = (sel) => document.querySelectorAll(sel + ' .poster').forEach((poster) => {
      // The halftone fills its own column, so that column's rect IS the
      // field — no reconstructing it from computed styles, and nothing
      // to get out of step when the layout changes.
      const deco = poster.querySelector('.poster-deco');
      if (!deco) { out.push({ id: poster.closest('.event').id, hits: ['no deco column'] }); return; }
      const field = deco.getBoundingClientRect();
      // Real rectangle overlap, both axes. Checking x alone passes a
      // layout where the text is simply lower than the dots, which is
      // fine — and fails one where it is merely further right, which
      // is also fine. Only an actual intersection is a bug.
      const hits = [];
      poster.querySelectorAll('.poster-tag, .poster-value, .poster-label, .poster-sub').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (r.right > field.left && r.left < field.right && r.bottom > field.top && r.top < field.bottom) {
          hits.push(el.className + ' "' + el.innerText.trim().slice(0, 14) + '"');
        }
      });
      out.push({ id: poster.closest('.event').id, hits, fieldWidth: Math.round(field.width) });
    });

    window.showTab('events');
    await new Promise((r) => setTimeout(r, 150));
    measure('#events');
    window.showTab('recap');
    await new Promise((r) => setTimeout(r, 150));
    measure('#recapEvents');
    window.showTab('events');
    return out;
  }, { events: [
    mkEvent('p1', 'a', 'Short one', '☕ Chill'),
    Object.assign(mkEvent('p2', 'b', 'One with a great many people going to it indeed', '🏀 Sports'),
                  { participantUids: ['b','a','c','d','x','y','z'], maxCapacity: 12 }),
    Object.assign(mkEvent('p3', 'c', 'Nobody yet', '📚 Study'), { participantUids: ['c'] }),
    // And a finished one, so the stub's band is measured too.
    Object.assign(mkEvent('p4', 'a', 'Already over, plenty came', '🍕 Food'),
                  { participantUids: ['a','b','c','d','x'], startTime: now - 9e6, expiresAt: now - 36e5 })
  ]});

  ok('every card painted a band, live and stub', band.length === 4, JSON.stringify(band.map((b) => b.id)));
  ok('the halftone has a column of its own',
     band.every((b) => b.fieldWidth > 20), JSON.stringify(band.map((b) => b.fieldWidth)));
  const clashes = band.filter((b) => b.hits.length);
  ok('no word in the band sits on the halftone',
     clashes.length === 0,
     JSON.stringify(clashes));
}

/* ------------------------------------------------------------------ */
group('reactions, pins and the receipt');
{
  const pure = await page.evaluate(async () => {
    const mr = await import('/js/services/messageRules.js');
    const rr = await import('/js/services/receiptRules.js');
    const t0 = 1000000000000;
    const [THUMB, HEART, CRY] = [mr.REACTIONS[0], mr.REACTIONS[1], mr.REACTIONS[2]];

    const msg = { id: 'm1', senderUid: 'a', text: 'hi', time: t0,
                  reactions: { me: HEART, b: HEART, c: CRY } };
    const gone = { id: 'm2', senderUid: 'me', text: '', time: t0, deleted: true };

    const ev = (id, mine, host, tag, at) => ({
      id, tag, hostUid: host, startTime: at, expiresAt: at + 1000,
      participantUids: mine
    });
    const now = t0 + 100000;

    let r = rr.emptyReceipt();
    r = rr.foldAll(r, [
      ev('e1', ['me', 'a', 'b'], 'me', '\u2615 Chill', t0),
      ev('e2', ['me', 'a'], 'a', '\u2615 Chill', t0 + 10),
      ev('e3', ['me', 'a', 'c'], 'c', '\uD83C\uDF55 Food', t0 + 20)
    ], 'me', now);
    const again = rr.foldAll(r, [ev('e1', ['me', 'a', 'b'], 'me', '\u2615 Chill', t0)], 'me', now);
    const notMine = rr.foldEvent(r, ev('e9', ['a', 'b'], 'a', '\u2615 Chill', t0), 'me', now);
    const stillOn = rr.foldEvent(r, { id: 'e8', tag: 'x', participantUids: ['me'],
                                      startTime: now, expiresAt: now + 90000 }, 'me', now);
    const sum = rr.summarise(r, rr.monthKey(t0));

    return {
      // reactions
      summary: mr.reactionSummary(msg, 'me').map((x) => x.emoji + x.count + (x.mine ? '*' : '')).join(' '),
      toggleOff: mr.nextReaction(msg, 'me', HEART),
      toggleOver: mr.nextReaction(msg, 'me', THUMB),
      junk: mr.nextReaction(msg, 'me', 'X'),
      reactGone: mr.canReact(gone),
      // pinning
      hostSees: mr.hostActions(msg, { isHost: true }).join(','),
      hostSeesUnpin: mr.hostActions(msg, { isHost: true, pinnedId: 'm1' }).join(','),
      guestSees: mr.hostActions(msg, { isHost: false }).length,
      pinGone: mr.pinPayload(gone, 'me'),
      pinBody: mr.pinPayload(msg, 'me', t0),
      // the receipt
      went: sum.went, hosted: sum.hosted, topTag: sum.topTag,
      people: sum.people.map((x) => x.uid + ':' + x.count).join(','),
      idempotent: again === r,
      notMineIgnored: notMine === r,
      stillOnIgnored: stillOn === r,
      label: typeof sum.label === 'string' && sum.label.length > 2
    };
  });

  ok('reaction chips are grouped, biggest first, yours marked',
     pure.summary === '\u2764\uFE0F2* \uD83D\uDE021', pure.summary);
  ok('tapping the emoji you already gave clears it', pure.toggleOff === '');
  ok('tapping a different one moves yours', pure.toggleOver === '\uD83D\uDC4D', pure.toggleOver);
  ok('an emoji outside the list is refused', pure.junk === null);
  ok('a deleted message cannot be reacted to', pure.reactGone === false);

  ok('only the host is offered a pin', pure.hostSees === 'pin' && pure.guestSees === 0, pure.hostSees);
  ok('the pinned one is offered unpin instead', pure.hostSeesUnpin === 'unpin', pure.hostSeesUnpin);
  ok('a deleted message cannot be pinned', pure.pinGone === null);
  ok('the pin stores a copy, not just an id',
     pure.pinBody && pure.pinBody.messageId === 'm1' && pure.pinBody.text === 'hi'
     && pure.pinBody.senderUid === 'a', JSON.stringify(pure.pinBody));

  ok('the receipt counts what you went to', pure.went === 3 && pure.hosted === 1,
     JSON.stringify({ w: pure.went, h: pure.hosted }));
  ok('it knows your usual vibe', pure.topTag === '\u2615 Chill', pure.topTag);
  ok('and who you keep running into, more than once only',
     pure.people === 'a:3', pure.people);
  ok('folding the same event twice changes nothing', pure.idempotent === true);
  ok("an event you weren't at doesn't count", pure.notMineIgnored === true);
  ok('an event still running does not count yet', pure.stillOnIgnored === true);
  ok('the month has a readable label', pure.label === true);

  // ---- and on screen ----
  const dom = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const mr = await import('/js/services/messageRules.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const now = Date.now();

    // ---- reactions, in a direct chat ----
    state.currentChat = 'a_me'; state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
    state.currentOtherUid = 'a'; state.currentEventData = null;
    window.switchScreen('chatScreen');
    window.__docs = [
      { id: 'r1', data: () => ({ senderUid: 'a', text: 'lawn in 10?', time: now - 60000,
                                 reactions: { b: mr.REACTIONS[1] } }) }
    ];
    chat.loadMessages();
    await wait(200);

    const box = document.getElementById('messages');
    out.chips = box.querySelectorAll('.react-chip').length;
    out.chipMine = box.querySelectorAll('.react-chip.mine').length;

    window.__updates = [];
    chat.openMessageActions('r1');
    await wait(80);
    out.pickers = document.querySelectorAll('#msgReactRow .react-pick').length;
    document.querySelector('#msgReactRow .react-pick[data-react="0"]').click();
    await wait(200);
    const w = (window.__updates || []).slice(-1)[0] || {};
    out.reactKey = (w.keys || []).join(',');
    out.reactValue = w.patch ? w.patch['reactions.me'] : null;
    out.chipsAfter = box.querySelectorAll('.react-chip').length;
    out.mineAfter = box.querySelectorAll('.react-chip.mine').length;

    // Tapping the same one again clears it.
    chat.toggleReaction('r1', 0);
    await wait(200);
    const w2 = (window.__updates || []).slice(-1)[0] || {};
    out.clearedOp = w2.patch ? (w2.patch['reactions.me'] || {}).__op : null;
    out.mineCleared = box.querySelectorAll('.react-chip.mine').length;

    // ---- the pin, in an event chat ----
    state.eventCache.ev1 = { id: 'ev1', title: 'Lawn hang', hostUid: 'me',
                             participantUids: ['me', 'a'], tag: '\u2615 Chill',
                             startTime: now - 7200000, expiresAt: now - 3600000 };
    chat.openEventChat('ev1');
    await wait(150);
    state.currentEventData = { hostUid: 'me', title: 'Lawn hang', participantUids: ['me', 'a'] };
    window.__docs = [
      { id: 'p1', data: () => ({ senderUid: 'me', text: 'north gate, by the bench', time: now - 90000 }) }
    ];
    chat.loadMessages();
    await wait(200);

    chat.openMessageActions('p1');
    await wait(80);
    out.hostRows = Array.from(document.querySelectorAll('#msgActionList .action-row'))
      .map((b) => b.getAttribute('data-act')).join(',');
    document.querySelector('#msgActionList .action-row[data-act="pin"]').click();
    await wait(250);

    const bar = document.getElementById('pinnedBar');
    out.barShown = !bar.classList.contains('hidden');
    out.barText = (bar.innerText || '').replace(/\s+/g, ' ').trim();

    chat.openMessageActions('p1');
    await wait(80);
    out.rowsWhenPinned = Array.from(document.querySelectorAll('#msgActionList .action-row'))
      .map((b) => b.getAttribute('data-act')).join(',');
    chat.closeMessageActions();
    await wait(140);

    await chat.unpinMessage();
    await wait(150);
    out.barGone = document.getElementById('pinnedBar').classList.contains('hidden');

    chat.closeChat({ silent: true });
    out.barGoneOnClose = document.getElementById('pinnedBar').classList.contains('hidden');

    // ---- the receipt ----
    const events = await import('/js/services/eventsService.js');
    const receipt = await import('/js/services/receiptService.js');
    // Earlier groups have already been through the feed, so start the
    // receipt from nothing to keep this measurable.
    receipt.clearReceipt();

    const ev = (id, who, host, tag) => ({ id, tag, hostUid: host, participantUids: who,
                                          startTime: now - 7200000, expiresAt: now - 3600000 });
    state.eventCache = {
      a1: ev('a1', ['me', 'a', 'b'], 'me', '\u2615 Chill'),
      a2: ev('a2', ['me', 'a'], 'a', '\u2615 Chill'),
      a3: ev('a3', ['me', 'a', 'b'], 'b', '\uD83C\uDF55 Food')
    };
    state.eventOrder = []; state.recapOrder = [];
    window.showTab('recap');
    events.renderEvents();
    await wait(450);

    const card = document.getElementById('receiptCard');
    out.receipt = (card.innerText || '').replace(/\s+/g, ' ').trim();
    out.receiptPeople = card.querySelectorAll('.receipt-person').length;
    out.summary = receipt.receiptSummary();

    // Running the feed again must not count the same events twice.
    const writesBefore = window.__writes;
    events.renderEvents();
    await wait(300);
    out.wentAgain = receipt.receiptSummary().went;
    out.extraWrites = window.__writes - writesBefore;

    window.showTab('events');
    await wait(100);
    return out;
  });

  ok('somebody else\u2019s reaction shows as a chip', dom.chips === 1 && dom.chipMine === 0,
     JSON.stringify({ c: dom.chips, m: dom.chipMine }));
  ok('the sheet offers the six reactions', dom.pickers === 6, String(dom.pickers));
  ok('reacting writes only your own key', dom.reactKey === 'reactions.me', dom.reactKey);
  ok('reacting writes the emoji you picked', dom.reactValue === '\uD83D\uDC4D', dom.reactValue);
  ok('your reaction appears as its own chip', dom.chipsAfter === 2 && dom.mineAfter === 1,
     JSON.stringify({ c: dom.chipsAfter, m: dom.mineAfter }));
  ok('tapping it again deletes the key', dom.clearedOp === 'delete' && dom.mineCleared === 0,
     JSON.stringify({ o: dom.clearedOp, m: dom.mineCleared }));

  ok('the host gets Pin in the sheet', dom.hostRows === 'reply,copy,pin,edit,delete', dom.hostRows);
  ok('pinning shows the bar with the message in it',
     dom.barShown === true && /north gate/.test(dom.barText), dom.barText);
  ok('the pinned message offers Unpin instead',
     dom.rowsWhenPinned === 'reply,copy,unpin,edit,delete', dom.rowsWhenPinned);
  ok('unpinning hides the bar', dom.barGone === true);
  ok('leaving the chat clears the bar', dom.barGoneOnClose === true);

  ok('the receipt card fills in from events already on screen',
     /showed up/.test(dom.receipt) && /3 times/.test(dom.receipt)
     && dom.summary.went === 3 && dom.summary.hosted === 1, dom.receipt);
  ok('it names the people you keep running into', dom.receiptPeople === 2
     && dom.summary.people.map((x) => x.uid + ':' + x.count).join(',') === 'a:3,b:2',
     JSON.stringify(dom.summary.people));
  ok('a second pass over the same feed counts nothing twice',
     dom.wentAgain === 3 && dom.extraWrites === 0,
     JSON.stringify({ w: dom.wentAgain, x: dom.extraWrites }));
}

/* ------------------------------------------------------------------ */
group('sharing an event');
{
  // The link is the one thing here that outlives the app — somebody
  // pastes it into WhatsApp today and taps it next week — so the
  // parsing is pure and gets tested on its own.
  const links = await page.evaluate(async () => {
    const sr = await import('/js/services/shareRules.js');
    const id = 'AbC123_-x';
    return {
      made: sr.eventLink(id),
      roundTrip: sr.eventIdFromUrl(sr.eventLink(id)),
      // The path form has no hosting rewrite yet, but links in the
      // wild must keep working the day one is added.
      pathForm: sr.eventIdFromUrl('https://livesociya.com/e/' + id),
      subdomain: sr.eventIdFromUrl('https://www.livesociya.com/?e=' + id),
      dev: sr.eventIdFromUrl('http://localhost:8111/?e=' + id),
      // A lookalike must NOT be able to dress itself up as one of our
      // event cards in somebody's chat.
      lookalike: sr.eventIdFromUrl('https://livesociya.com.evil.tld/?e=' + id),
      notUs: sr.eventIdFromUrl('https://example.com/?e=' + id),
      suffix: sr.eventIdFromUrl('https://notlivesociya.com/?e=' + id),
      javascript: sr.eventIdFromUrl('javascript:alert(1)//livesociya.com/?e=' + id),
      junkId: sr.eventIdFromUrl('https://livesociya.com/?e=' + encodeURIComponent('../../etc')),
      noParam: sr.eventIdFromUrl('https://livesociya.com/'),
      // And picking the event link out of a sentence.
      inSentence: sr.firstEventLink('come to this https://livesociya.com/?e=' + id + ' tonight'),
      noneInSentence: sr.firstEventLink('just a https://example.com/thing here')
    };
  });

  ok('a link round-trips back to its event', links.roundTrip === 'AbC123_-x', links.made);
  ok('the pretty path form is understood too', links.pathForm === 'AbC123_-x', links.pathForm);
  ok('subdomains and localhost count as us',
     links.subdomain === 'AbC123_-x' && links.dev === 'AbC123_-x',
     JSON.stringify([links.subdomain, links.dev]));
  ok('a lookalike domain is not us',
     links.lookalike === '' && links.notUs === '' && links.suffix === '',
     JSON.stringify([links.lookalike, links.notUs, links.suffix]));
  ok('a javascript: url is refused', links.javascript === '', links.javascript);
  ok('an id that is not an id is refused', links.junkId === '', links.junkId);
  ok('a plain homepage link is not an event', links.noParam === '', links.noParam);
  ok('an event link is found inside a sentence',
     links.inSentence && links.inSentence.id === 'AbC123_-x', JSON.stringify(links.inSentence));
  ok('and a non-event link is not mistaken for one', links.noneInSentence === null);

  // And the card it becomes in a thread.
  const embed = await page.evaluate(async ({ id }) => {
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const sr = await import('/js/services/shareRules.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = Date.now();

    state.eventCache[id] = { id, title: 'Chai + assignment panic', place: 'Back lawn',
      tag: '\u2615 Chill', hostUid: 'a', participantUids: ['a'], hypedUids: [],
      startTime: now - 6e4, expiresAt: now + 36e5, description: '',
      pendingUids: [], unconfirmedUids: [] };

    state.currentChat = 'a_me'; state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
    state.currentOtherUid = 'a'; state.currentEventData = null;
    window.switchScreen('chatScreen');
    window.__docs = [
      { id: 's1', data: () => ({ senderUid: 'a', text: sr.eventLink(id), time: now - 6e4 }) },
      { id: 's2', data: () => ({ senderUid: 'a', text: 'https://example.com/not-ours', time: now - 5e4 }) }
    ];
    chat.loadMessages();
    await wait(400);

    const box = document.getElementById('messages');
    const card = box.querySelector('.event-embed');
    return {
      cards: box.querySelectorAll('.event-embed').length,
      title: card && card.querySelector('.event-embed-title').innerText,
      meta: card && card.querySelector('.event-embed-meta').innerText,
      // The address stays on the card, so the message still means
      // something copied anywhere else — but as data-href, so hovering
      // on a laptop doesn't print it at the bottom of the window.
      href: card && card.getAttribute('data-href'),
      hrefOnHover: !!box.querySelector('a[href]'),
      otherLinkStillALink: !!box.querySelector('a[data-href="https://example.com/not-ours"]')
    };
  }, { id: 'AbC123_-x' });

  // Put the app back on the feed. A group that leaves another screen
  // open is not just untidy: innerText stops applying text-transform
  // once an element is not being rendered, which quietly broke the
  // next group's assertion about "20M" vs "20m".
  await page.evaluate(async () => {
    const chat = await import('/js/services/chatService.js');
    chat.closeChat({ silent: true });
    window.showTab('events');
    await new Promise((r) => setTimeout(r, 200));
  });

  ok('an event link in a thread becomes one card', embed.cards === 1, String(embed.cards));
  ok('the card fills in from the cache with no read',
     embed.title === 'Chai + assignment panic' && /Happening now/.test(embed.meta || ''),
     JSON.stringify({ t: embed.title, m: embed.meta }));
  ok('the card still carries its link',
     /livesociya\.com\/\?e=AbC123_-x$/.test(embed.href || ''), embed.href);
  ok('and nothing in the thread has an href to print on hover', embed.hrefOnHover === false);
  ok('someone else\u2019s link is left alone', embed.otherLinkStillALink);
}

/* ------------------------------------------------------------------ */
group('a receipt that already has history');
{
  // THE CARD USED TO LIE. load() was only ever called from
  // harvestReceipt, and harvestReceipt returns early when nothing in
  // the cache is countable — the ordinary case for somebody coming
  // back, since everything finished has already been folded. So the
  // document was never read, the in-memory receipt stayed empty, and
  // the card painted "Go to something and this fills in" at a person
  // with months behind them. It read as a card that had failed to
  // load, and it had.
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const receipt = await import('/js/services/receiptService.js');
    receipt.clearReceipt();

    // A receipt on the server, and NOTHING new to fold: no finished
    // events in the cache at all.
    const key = new Date().toISOString().slice(0, 7);
    window.__stubDocs['users/me/private/receipt'] = {
      months: { [key]: { went: 4, hosted: 1, tags: { '\u2615 Chill': 3 }, people: { a: 2, b: 1 } } },
      counted: ['old1', 'old2', 'old3', 'old4']
    };
    state.eventCache = {}; state.eventOrder = []; state.recapOrder = [];

    window.showTab('recap');
    await wait(500);
    const card = document.getElementById('receiptCard');
    const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
    window.showTab('events');
    await wait(150);
    return { text, went: receipt.receiptSummary().went };
  });

  ok('a receipt with history on the server is read when Recap opens',
     r.went === 4, JSON.stringify(r));
  ok('and the card says so instead of offering the empty state',
     /showed up/.test(r.text) && !/fills in/.test(r.text), r.text);
}

/* ------------------------------------------------------------------ */
group('the line under a bubble');
{
  // formatTime() always spells a day out, so an edited message read
  // "Today at 22:48 · edited Today at 22:51" — the word Today twice,
  // in mono, at the metadata tracking, on a line under a bubble. Wider
  // than the bubble it belonged to.
  const t = await page.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const now = Date.now();
    state.currentChat = 'a_me'; state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
    state.currentOtherUid = 'a'; state.currentEventData = null;
    window.switchScreen('chatScreen');
    window.__docs = [
      { id: 'e1', data: () => ({ senderUid: 'me', text: 'hello', time: now - 9e5,
                                 editedAt: now - 8.5e5 }) }
    ];
    chat.loadMessages();
    await wait(400);
    const wrap = document.querySelector('.msg-wrapper');
    wrap.classList.add('show-time');
    // The reveal is a max-height TRANSITION, so a computed style read
    // in the same tick is the value it is animating from, not the one
    // it is going to. Measuring straight away said max-height: 0 and
    // called a perfectly good line clipped.
    await wait(450);
    const line = wrap.querySelector('.msg-time');
    const cs = getComputedStyle(line);
    const out = {
      text: (line.innerText || '').trim(),
      mono: /mono|Menlo|Consolas|Courier|ui-monospace/i.test(cs.fontFamily),
      tracking: cs.letterSpacing,
      size: parseFloat(cs.fontSize),
      // It reveals by max-height; a wrapped line must not be clipped.
      fits: line.scrollHeight <= parseFloat(cs.maxHeight) + 1,
      // Not against the bubble — a five-letter message has a tiny one
      // and the stamp is never going to be shorter than "Today at
      // 22:48". Against the thread, which is what it can actually
      // overflow.
      overflowsThread: line.scrollWidth > wrap.clientWidth + 1
    };
    chat.closeChat({ silent: true });
    window.showTab('events');
    await wait(150);
    return out;
  });

  // Not by counting the word "Today": the container's clock decides
  // whether that is Today, Yesterday or a date, and a test that only
  // passes before midnight is worse than no test.
  ok('an edited message says the day once, not twice',
     /\u00b7 edited \d{1,2}:\d{2}(\s?[APap][Mm])?$/.test(t.text), t.text);
  ok('and still says when it was edited', /edited \d/.test(t.text), t.text);
  ok('it is still mono, because a timestamp is metadata', t.mono, t.tracking);
  ok('but not at the metadata tracking, which is for caps',
     t.tracking === 'normal' || parseFloat(t.tracking) === 0, t.tracking);
  ok('and smaller than the message above it', t.size <= 11, String(t.size));
  ok('the reveal does not clip the line', t.fits);
  ok('and it does not overflow the thread', !t.overflowsThread);
}

/* ------------------------------------------------------------------ */
group('the action bar on a phone');
{
  // Two things were wrong and only one of them was the arrangement.
  //
  // The arrangement: four controls on one line read as a jumble, and
  // the one control the card is asking you to press was squeezed at the
  // end of it. Two rows now — Hype and Chat as a pair on the left,
  // Share alone on the right, the primary across the full width below.
  // Spreading all three put Chat in the middle of nowhere; the two that
  // act on the event belong together, and Share, which leaves the app,
  // gets the far edge to itself.
  //
  // The spacing, which is what actually made it look unmanaged: `.act`
  // carries `padding: 8px 14px` INSIDE its box, so the flame sat 30px
  // from the card's edge while the title, the place and the byline
  // above it all start at 16. The row was indented from the card it
  // belongs to. So these assertions are against the TITLE, never
  // against the row's own padding box — the glyphs have to land on the
  // same column the words do.
  const bar = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    const now = Date.now();
    const rows = [
      { k: 'Join',   hostUid: 'a',  participantUids: ['a', 'b'] },
      { k: 'Manage', hostUid: 'me', participantUids: ['me'] },
      { k: 'Going',  hostUid: 'a',  participantUids: ['a', 'b', 'me'] }
    ];
    state.eventCache = {}; state.eventOrder = [];
    rows.forEach((row, i) => {
      const id = 'b' + i;
      state.eventCache[id] = Object.assign({ id, title: 'Chai ' + i, place: 'Lawn',
        tag: '\u2615 Chill', hypedUids: ['a'], startTime: now - 6e4, expiresAt: now + 72e5,
        description: '', pendingUids: [], unconfirmedUids: [] }, row);
      state.eventOrder.push(id);
    });
    state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    window.switchScreen('home'); window.showTab('events'); ev.renderEvents();
    await wait(350);

    return [...document.querySelectorAll('#events .event')].map((card, i) => {
      const cb = card.getBoundingClientRect();
      const title = card.querySelector('.event-title').getBoundingClientRect();
      const row = card.querySelector('.card-actions');
      const kids = [...row.children];
      const hypeEl = kids[0];
      const shareEl = kids.find((k) => k.getAttribute('aria-label') === 'Share');
      const chatEl = kids.find((k) => (k.innerText || '').trim() === 'Chat');
      const hype = hypeEl.getBoundingClientRect();
      const primary = kids[kids.length - 1].getBoundingClientRect();
      // The GLYPH, not the button box: the box is pulled out by its own
      // padding precisely so the glyph lands on the column.
      const flame = hypeEl.querySelector('svg').getBoundingClientRect();
      const shareGlyph = shareEl.querySelector('svg');
      const sg = shareGlyph && shareGlyph.getBoundingClientRect();
      const gutter = title.left - cb.left;
      return {
        k: rows[i].k,
        flameOnTextColumn: Math.abs(flame.left - title.left) < 1.5,
        shareOnTextColumn: !!sg && Math.abs((cb.right - gutter) - sg.right) < 1.5,
        // Chat belongs NEXT TO Hype, not adrift in the middle.
        chatBesideHype: !chatEl || (chatEl.getBoundingClientRect().left - hype.right) < 12,
        primaryOnItsOwnLine: primary.top >= hype.bottom - 4,
        primaryOnTextColumn: Math.abs(primary.left - title.left) < 1.5 &&
                             Math.abs((cb.right - primary.right) - gutter) < 1.5,
        // Nothing here may be an icon with no label and no fallback.
        shareHasGlyph: !!shareGlyph
      };
    });
  });

  ok('the flame lands on the same column as the title, not 14px in',
     bar.every((b) => b.flameOnTextColumn), JSON.stringify(bar));
  ok('and share on the column at the other edge',
     bar.every((b) => b.shareOnTextColumn), JSON.stringify(bar));
  ok('chat sits beside hype, not adrift in the middle',
     bar.every((b) => b.chatBesideHype), JSON.stringify(bar));
  ok('the primary gets a line of its own',
     bar.every((b) => b.primaryOnItsOwnLine), JSON.stringify(bar));
  ok('and spans the text column exactly',
     bar.every((b) => b.primaryOnTextColumn), JSON.stringify(bar));
  ok('share is drawn, not set in the icon font \u2014 it has no label to fall back on',
     bar.every((b) => b.shareHasGlyph));
}

/* ------------------------------------------------------------------ */
group('an event that has already ended');
{
  // Tapping a shared card used to swap the tab whatever the event had
  // become — and on a phone it closed the conversation on the way. An
  // event that is over has a stub in Recap only for as long as
  // recapRules says it earned; after that there is no card anywhere,
  // so the reward for closing the chat was an empty tab. Worse, an
  // event missing from the cache entirely read as `ended === false`,
  // so it went to LIVE NOW — a finished event bouncing you into the
  // events tab, which is exactly what it looked like.
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const ev = await import('/js/services/eventsService.js');
    const sr = await import('/js/services/shareRules.js');
    // ui.showTab, NOT window.showTab: the one on window is app.js's
    // goToTab, which closes any open chat on its way to the tab. That
    // is right for a nav button and wrong here — it would close the
    // conversation this group is trying to prove stays open.
    const ui = await import('/js/utils/ui.js');
    const now = Date.now();
    const HOUR = 36e5;

    const mk = (id, expiresAt) => ({ id, title: 'Chai ' + id, place: 'Back lawn',
      tag: '\u2615 Chill', hostUid: 'a', participantUids: ['a', 'b'], hypedUids: [],
      startTime: now - 3 * HOUR, expiresAt, description: '',
      pendingUids: [], unconfirmedUids: [] });

    // Over ten minutes ago: earned a stub, still in Recap.
    // Over three days ago: past even the 48h ceiling, gone from Recap.
    state.eventCache.endedFresh = mk('endedFresh', now - 10 * 6e4);
    state.eventCache.endedOld = mk('endedOld', now - 72 * HOUR);
    state.eventOrder = []; state.recapOrder = []; state.recapDone = true;

    state.currentChat = 'a_me'; state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
    state.currentOtherUid = 'a'; state.currentEventData = null;
    window.switchScreen('chatScreen');
    window.__docs = [
      { id: 'e1', data: () => ({ senderUid: 'a', text: sr.eventLink('endedFresh'), time: now - 6e4 }) },
      { id: 'e2', data: () => ({ senderUid: 'a', text: sr.eventLink('endedOld'), time: now - 5e4 }) }
    ];
    chat.loadMessages();
    await wait(450);

    const box = document.getElementById('messages');
    const cardOf = (id) => box.querySelector('[data-event-embed="' + id + '"]');
    const read = (id) => {
      const c = cardOf(id);
      return c && { gone: c.classList.contains('gone'), dead: c.classList.contains('dead'),
                    go: c.querySelector('.event-embed-go').innerText.trim() };
    };
    const fresh = read('endedFresh');
    const old = read('endedOld');

    const tabNow = () => ['eventsTab', 'recapTab', 'chatsTab']
      .find((t) => !document.getElementById(t).classList.contains('hidden')) || 'none';
    const chatOpen = () => !document.getElementById('chatScreen').classList.contains('hidden');

    // 1. The dead one must not move anything at all.
    ui.showTab('chats');
    const deadTook = ev.showSharedEvent('endedOld');
    await wait(250);
    const afterDead = { tab: tabNow(), chat: chatOpen() };

    // 2. Neither must an event nobody has ever seen.
    const unknownTook = ev.showSharedEvent('neverHeardOfIt');
    await wait(250);
    const afterUnknown = { tab: tabNow(), chat: chatOpen() };

    // 3. The one still in Recap goes to RECAP, and lands on a real
    //    stub — recapOrder is paged, so the id has to be put in it or
    //    renderEvents builds nothing to scroll to.
    const freshTook = ev.showSharedEvent('endedFresh');
    await wait(500);
    const afterFresh = { tab: tabNow(), inOrder: (state.recapOrder || []).includes('endedFresh'),
                         stub: !!document.getElementById('event-endedFresh') };

    chat.closeChat({ silent: true });
    window.showTab('events');
    await wait(200);
    return { fresh, old, deadTook, unknownTook, freshTook, afterDead, afterUnknown, afterFresh };
  });

  ok('a finished event still in Recap offers Recap, not View',
     r.fresh && r.fresh.gone && !r.fresh.dead && r.fresh.go === 'Recap', JSON.stringify(r.fresh));
  ok('one that has aged out offers nothing and is marked dead',
     r.old && r.old.gone && r.old.dead && r.old.go === '', JSON.stringify(r.old));
  ok('tapping a dead card does not change the tab or close the chat',
     r.deadTook === false && r.afterDead.tab === 'chatsTab' && r.afterDead.chat === true,
     JSON.stringify(r.afterDead));
  ok('nor does an event that is not in the cache at all',
     r.unknownTook === false && r.afterUnknown.tab === 'chatsTab' && r.afterUnknown.chat === true,
     JSON.stringify(r.afterUnknown));
  ok('one still in Recap opens Recap and lands on a real stub',
     r.freshTook === true && r.afterFresh.tab === 'recapTab' &&
     r.afterFresh.inOrder && r.afterFresh.stub, JSON.stringify(r.afterFresh));
}

/* ------------------------------------------------------------------ */
group('a song in a thread');
{
  // The Spotify player drew a scrollbar down its side AND along its
  // bottom on Windows. The frame is cross-origin, so no rule of ours
  // reaches inside it and the wrapper's overflow: hidden clips the
  // frame's box without touching the bars drawn within it. The only
  // lever is the attribute, and it cannot be seen on a Mac, where
  // scrollbars float over the content instead of taking space.
  const media = await page.evaluate(async () => {
    const f = await import('/js/utils/formatters.js');
    const wrap = document.createElement('div');
    wrap.innerHTML =
      f.formatMessage('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', true) +
      f.formatMessage('https://www.youtube.com/watch?v=dQw4w9WgXcQ', true) +
      f.formatMessage('look at this https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX', false);
    const frames = [...wrap.querySelectorAll('iframe')];
    const boxes = [...wrap.querySelectorAll('.media-embed')];
    return {
      frames: frames.length,
      allNoScroll: frames.every((i) => i.getAttribute('scrolling') === 'no'),
      spotifySrc: frames[0] && frames[0].getAttribute('src'),
      spaced: boxes.map((b) => b.classList.contains('spaced')),
      noInlineWidths: boxes.every((b) => !b.getAttribute('style'))
    };
  });

  ok('both players render as frames', media.frames === 3, String(media.frames));
  ok('and neither is allowed to draw a scrollbar', media.allNoScroll);
  ok('the spotify frame points at the embed host',
     /^https:\/\/open\.spotify\.com\/embed\/track\//.test(media.spotifySrc || ''), media.spotifySrc);
  ok('an embed that IS the message has no gap above it, one after text does',
     JSON.stringify(media.spaced) === JSON.stringify([false, false, true]), JSON.stringify(media.spaced));
  ok('the sizing lives in the stylesheet, not in a style attribute', media.noInlineWidths);
}

/* ------------------------------------------------------------------ */
group('the minute tick');
{
  // A tick once a minute is what moves an event out of Live Now when
  // it ends and keeps "in 20m" honest. It is supposed to be free.
  //
  // It was not. A card carries the time in its markup, so on every
  // tick every card's html differed from what was on screen, syncList
  // swapped all sixty for new nodes, and the feed visibly blinked —
  // no animation involved, just the whole list being rebuilt. The time
  // lives in empty `data-vt` slots now, filled after insertion, so a
  // card's html no longer depends on when it was built.
  const tick = await page.evaluate(async ({ events }) => {
    const { state, ev } = window.__m;
    state.eventCache = {}; state.eventOrder = [];
    events.forEach((e) => { state.eventCache[e.id] = e; state.eventOrder.push(e.id); });
    state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    ev.renderEvents();
    await new Promise((r) => setTimeout(r, 250));

    const before = [...document.querySelectorAll('#events .event')];
    before.forEach((el, i) => { el.dataset.probe = 'p' + i; });
    const stat = (el) => el.querySelector('.poster-value') && el.querySelector('.poster-value').innerText;
    const statsBefore = before.map(stat);

    const anims = [];
    const onAnim = (e) => anims.push(e.animationName);
    document.addEventListener('animationstart', onAnim, true);

    // The stub counts every get() and every document a listener
    // delivers, so this is the real answer to "does a tick cost reads".
    const readsBefore = window.__reads;
    const writesBefore = window.__writes;

    // Exactly what the interval does, a minute later.
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    ev.renderEvents();
    await new Promise((r) => setTimeout(r, 300));
    Date.now = realNow;
    document.removeEventListener('animationstart', onAnim, true);

    const after = [...document.querySelectorAll('#events .event')];
    return {
      cards: before.length,
      kept: after.filter((el) => el.dataset.probe).length,
      statsBefore, statsAfter: after.map(stat),
      anims,
      reads: window.__reads - readsBefore,
      writes: window.__writes - writesBefore
    };
  }, { events: [
    Object.assign(mkEvent('t1', 'a', 'On now', '☕ Chill'), { startTime: now - 6e4 }),
    Object.assign(mkEvent('t2', 'b', 'Soon', '🍕 Food'), { startTime: now + 20 * 6e4, expiresAt: now + 72e5 }),
    Object.assign(mkEvent('t3', 'c', 'Later', '📚 Study'), { startTime: now + 25 * 6e4, expiresAt: now + 72e5 })
  ]});

  ok('a quiet minute replaces no cards at all', tick.cards === 3 && tick.kept === 3,
     JSON.stringify({ cards: tick.cards, kept: tick.kept }));
  ok('and starts no animations', tick.anims.length === 0, tick.anims.join(','));
  // The whole point of the tick: the clock must still move.
  ok('but the countdowns still tick down',
     tick.statsBefore.join() !== tick.statsAfter.join()
     && /^\d+\s?min$/i.test(tick.statsAfter[1] || ''),
     JSON.stringify({ before: tick.statsBefore, after: tick.statsAfter }));
  ok('and it costs no reads and no writes',
     tick.reads === 0 && tick.writes === 0,
     JSON.stringify({ reads: tick.reads, writes: tick.writes }));
}

/* ------------------------------------------------------------------ */
group('desktop columns');
{
  // The sidebar and the rail are position:sticky at >=1100px. They
  // stopped being sticky for two entirely separate reasons at once,
  // neither of which is visible in the media query that declares it:
  //
  //   1. `body { overflow-x: hidden }`. When one axis is hidden and the
  //      other is visible, the visible one computes to auto — so body
  //      became a scroll container. The page scrolls on html, so body
  //      never scrolls, and sticky inside it had nothing to stick to.
  //   2. A later rule listed .sidebar and .rail alongside things that
  //      need `position: relative` for z-index, at equal specificity,
  //      which flattened sticky back to relative.
  //
  // Either one alone breaks it, which is why this measures the
  // behaviour rather than the CSS: it cannot be fooled by fixing one
  // and leaving the other.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const wide = await ctx.newPage();
  const wideErrs = [];
  wide.on('pageerror', (e) => wideErrs.push(e.message));
  await wide.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await wide.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await wide.waitForTimeout(1600);

  const desk = await wide.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u) => ({ uid: u, username: u, displayName: u, avatar: 'x', followers: [], following: [], vouchedBy: [] });
    state.userCache = Object.fromEntries(['me', 'a', 'b'].map((u) => [u, mk(u)]));
    state.following = []; state.orbitUids = [];
    const t = Date.now();
    state.eventCache = {}; state.eventOrder = [];
    // Enough cards that the page is definitely taller than the viewport.
    for (let i = 0; i < 14; i++) {
      const id = 'd' + i;
      state.eventCache[id] = { id, title: 'Event ' + i, place: 'Lawn', tag: '\u2615 Chill', hostUid: 'a',
        participantUids: ['a', 'b'], hypedUids: [], startTime: t - 6e4, expiresAt: t + 36e5,
        description: '', pendingUids: [], unconfirmedUids: [] };
      state.eventOrder.push(id);
    }
    state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home'); ev.renderEvents();
    await new Promise((r) => setTimeout(r, 400));

    const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top);
    const before = { sidebar: top('.sidebar'), rail: top('.rail') };
    const pageIsTall = document.documentElement.scrollHeight > window.innerHeight + 600;
    window.scrollTo(0, 800);
    await new Promise((r) => setTimeout(r, 250));
    const after = { sidebar: top('.sidebar'), rail: top('.rail'), scrolled: Math.round(window.scrollY) };
    return { before, after, pageIsTall,
             sidebarPosition: getComputedStyle(document.querySelector('.sidebar')).position,
             bodyOverflowY: getComputedStyle(document.body).overflowY };
  });

  ok('the desktop feed is long enough to scroll', desk.pageIsTall && desk.after.scrolled > 700,
     JSON.stringify(desk.after));
  ok('the sidebar and rail are actually sticky, not relative',
     desk.sidebarPosition === 'sticky', desk.sidebarPosition);
  ok('body is not a scroll container (it breaks sticky inside it)',
     desk.bodyOverflowY === 'visible', desk.bodyOverflowY);
  ok('the nav columns stay put while the feed scrolls',
     desk.after.sidebar === 0 && desk.after.rail === 0,
     JSON.stringify({ before: desk.before, after: desk.after }));
  // A SURFACE IS HELD BY ITS BORDER, NOT BY ITS SHADOW. `--lift-1` is
  // nearly nothing on purpose and paper sits 1.13:1 from the canvas,
  // so a rail card with no border is held against the page by almost
  // nothing — and one filled with --wash, at 1.096:1, by less than
  // nothing. Dark mode had an inset hairline bolted on for exactly
  // this reason and light mode had none, which is why it only ever
  // looked wrong in light mode. This asserts the edge exists.
  // `wide`, not `page`: the rail only exists at >=1100px, and on the
  // 430px main page these elements are in the DOM with none of their
  // desktop styling at all — which would have made this pass or fail
  // for reasons that have nothing to do with the rail.
  const rail = await wide.evaluate(() => {
    const page_ = getComputedStyle(document.body).backgroundColor;
    return [...document.querySelectorAll('.rail-card')].map((el) => {
      const cs = getComputedStyle(el);
      return {
        cls: el.className.replace('rail-card', '').trim() || 'plain',
        border: parseFloat(cs.borderTopWidth) || 0,
        sameAsPage: cs.backgroundColor === page_
      };
    });
  });
  ok('every rail card has an edge, not just a shadow',
     rail.length > 0 && rail.every((c) => c.border >= 1), JSON.stringify(rail));
  ok('and none of them is the colour of the page',
     rail.every((c) => !c.sameAsPage), JSON.stringify(rail));

  ok('no errors on the desktop layout', wideErrs.length === 0, wideErrs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('mobile keyboard and zoom');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  const phoneErrors = [];
  phone.on('pageerror', (e) => phoneErrors.push(e.message));
  // A visual viewport the test can move, standing in for a keyboard.
  await phone.addInitScript(() => {
    const vv = new EventTarget();
    Object.assign(vv, { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    window.__vv = (patch) => { Object.assign(vv, patch); vv.dispatchEvent(new Event('resize')); };
  });
  await phone.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await phone.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(1800);

  const kb = await phone.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = await import('/js/state/store.js');
    state.uid = 'me'; window.__authSingleton.currentUser = { uid: 'me' };
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('chatScreen');
    const input = document.querySelector('#chatScreen .chat-footer #msgInput');
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
    const out = { hasInput: !!input };

    // iOS style: layout viewport unchanged, the visible part shrinks and pans.
    input.focus();
    window.__vv({ height: 500, offsetTop: 0 }); await wait(750);
    out.iosFooterBottom = Math.round(rect('#chatScreen .chat-footer').bottom);
    out.open = document.documentElement.classList.contains('kb-open');
    window.__vv({ height: 500, offsetTop: 200 }); await wait(750);
    out.pannedTop = Math.round(rect('#chatScreen').top);
    out.pannedBottom = Math.round(rect('#chatScreen .chat-footer').bottom);

    input.blur();
    window.__vv({ height: 844, offsetTop: 0 }); await wait(750);
    out.closed = !document.documentElement.classList.contains('kb-open')
      && Math.round(rect('#chatScreen .chat-footer').bottom) === 844;

    // Pinch-zoom is not a keyboard.
    window.__vv({ height: 422, scale: 2 }); await wait(750);
    out.pinchNotKeyboard = !document.documentElement.classList.contains('kb-open');
    window.__vv({ height: 844, scale: 1 }); await wait(300);

    out.touchAction = getComputedStyle(document.documentElement).touchAction;
    out.meta = document.querySelector('meta[name=viewport]').content;
    const fire = (ev) => { document.body.dispatchEvent(ev); return ev.defaultPrevented; };
    const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    const key = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '+' });
    let pinch = false;
    try {
      const t = (id, x) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: 100 });
      pinch = fire(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [t(1, 50), t(2, 150)] }));
    } catch (e) { pinch = 'no TouchEvent: ' + e.message; }
    const oneFinger = (() => {
      try {
        const t = new Touch({ identifier: 1, target: document.body, clientX: 50, clientY: 100 });
        return !fire(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [t] }));
      } catch (e) { return true; }
    })();
    out.blocked = [fire(gesture), fire(wheel), fire(key), pinch === true, oneFinger];
    out.smallFields = [...document.querySelectorAll('input, textarea, select')]
      .filter((el) => !['hidden', 'file', 'checkbox', 'radio'].includes(el.type))
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.id || el.className);
    return out;
  });
  ok('composer sits on top of the keyboard', kb.hasInput && kb.open && kb.iosFooterBottom <= 500, JSON.stringify(kb));
  ok('and follows the page when iOS pans it', kb.pannedTop === 200 && kb.pannedBottom === 700, JSON.stringify(kb));
  ok('and goes back down when the keyboard closes', kb.closed);
  ok('pinch-zoom is not mistaken for a keyboard', kb.pinchNotKeyboard);
  ok('zoom is off: only panning is allowed', kb.touchAction === 'pan-x pan-y', kb.touchAction);
  ok('viewport meta refuses scaling', /maximum-scale=1(\.0)?/.test(kb.meta) && /user-scalable=no/.test(kb.meta), kb.meta);
  ok('pinch, gesture and ctrl-zoom events are cancelled', kb.blocked.every(Boolean), JSON.stringify(kb.blocked));
  ok('no text field under 16px on a phone (iOS zooms on those)', kb.smallFields.length === 0, kb.smallFields.join());
  ok('phone page has no errors', phoneErrors.length === 0, phoneErrors.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('dark mode');
{
  const themeRun = async (scheme, stored) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    if (stored) await p.addInitScript((v) => { try { localStorage.setItem('livesociya.theme', v); } catch (e) {} }, stored);
    await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const firstPaint = await p.evaluate(() => document.documentElement.dataset.theme);
    await p.waitForTimeout(1200);
    const out = await p.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.body).backgroundColor,
      bar: document.querySelector('meta[name=theme-color]').content,
    }));
    return { p, ctx, errs, firstPaint, ...out };
  };

  const sysDark = await themeRun('dark');
  ok('a dark-mode device gets dark from the first paint', sysDark.firstPaint === 'dark' && sysDark.theme === 'dark'
     && sysDark.bg === 'rgb(26, 35, 39)' && sysDark.bar === '#1a2327', JSON.stringify({ ...sysDark, p: 0, ctx: 0 }));

  // Picking Light in Settings wins over the device, and sticks.
  const picked = await sysDark.p.evaluate(async () => {
    window.openSettingsScreen?.();
    await new Promise((r) => setTimeout(r, 200));
    window.setThemeChoice('light');
    const now = document.documentElement.dataset.theme;
    const marked = document.querySelector('#themePicker .theme-opt.on')?.dataset.theme;
    return { now, marked, stored: localStorage.getItem('livesociya.theme') };
  });
  ok('choosing Light in Settings overrides a dark device', picked.now === 'light' && picked.marked === 'light' && picked.stored === 'light',
     JSON.stringify(picked));
  ok('no errors switching themes', sysDark.errs.length === 0, sysDark.errs.join(' | '));
  await sysDark.ctx.close();

  const sysLight = await themeRun('light');
  ok('a light device stays light', sysLight.theme === 'light' && sysLight.bg === 'rgb(230, 242, 221)', sysLight.bg);
  await sysLight.ctx.close();

  const forced = await themeRun('light', 'dark');
  ok('a saved Dark choice applies before the app loads', forced.firstPaint === 'dark' && forced.theme === 'dark');
  // Following the device live: only in System.
  await forced.ctx.close();

  const live = await themeRun('light');
  await live.p.emulateMedia({ colorScheme: 'dark' });
  await live.p.waitForTimeout(150);
  ok('on System, the app follows the device when it changes', await live.p.evaluate(() => document.documentElement.dataset.theme) === 'dark');
  await live.ctx.close();
}

/* ------------------------------------------------------------------ */
group('search that forgives a typo');
{
  // Search used to be exact on both sides: people by username prefix,
  // events by literal substring. "chia" found nothing, "sanchitt"
  // found nothing, and looking someone up by the name printed on their
  // card — rather than their handle — found nothing either.
  const m = await page.evaluate(async () => {
    const mr = await import('/js/services/matchRules.js');
    const s = (q, t) => mr.scoreMatch(q, t);
    return {
      exactBeatsEverything: s('chai', 'chai') > s('chai', 'chai latte') &&
                            s('chai', 'chai latte') > s('chai', 'masala chai'),
      // The most common typo of all is two letters the wrong way round,
      // and plain Levenshtein scores that as TWO edits — far enough to
      // miss at any sane threshold. This is the one that proves the
      // distance function counts a swap as one.
      swapIsOneEdit: mr.editDistance('chia', 'chai', 1) === 1,
      typoFound: s('chia', 'Chai + assignment panic') !== null,
      doubledLetter: s('studdy', 'Study grind') !== null,
      droppedLetter: s('stdy', 'Study grind') !== null,
      wordsInAnyOrder: s('panic chai', 'Chai + assignment panic') !== null,
      initialsish: s('sncht', 'Sanchit Kumar') !== null,
      // Forgiving is not the same as indiscriminate.
      nonsenseStillMisses: s('cricket', 'Chai + assignment panic') === null,
      shortQueryIsStrict: mr.slackFor('ab') === 0,
      // And it must give up early rather than fill a matrix for every
      // cached person on every keystroke.
      boundedDistance: mr.editDistance('abcdefgh', 'zzzzzzzz', 2) === 3
    };
  });

  ok('an exact hit still outranks a near one', m.exactBeatsEverything);
  ok('two letters the wrong way round count as one typo, not two', m.swapIsOneEdit);
  ok('"chia" finds the chai', m.typoFound);
  ok('a doubled letter is forgiven', m.doubledLetter);
  ok('a dropped letter is forgiven', m.droppedLetter);
  ok('the words can come in any order', m.wordsInAnyOrder);
  ok('dropped vowels still land', m.initialsish);
  ok('but something unrelated still matches nothing', m.nonsenseStillMisses);
  ok('a two-letter query gets no slack at all', m.shortQueryIsStrict);
  ok('the distance function gives up early', m.boundedDistance);

  // And the same thing through the real event search.
  const found = await page.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    const search = await import('/js/services/searchService.js');
    const now = Date.now();
    state.eventCache = {}; state.eventOrder = [];
    const add = (id, title, place, tag) => {
      state.eventCache[id] = { id, title, place, tag, hostUid: 'a',
        participantUids: [], hypedUids: [], startTime: now - 6e4,
        expiresAt: now + 36e5, description: '', pendingUids: [], unconfirmedUids: [] };
      state.eventOrder.push(id);
    };
    add('f1', 'Chai + assignment panic', 'Nescafe', '☕ Chill');
    add('f2', 'Football, whoever turns up', 'Main ground', '\u{1F3C0} Sports');
    add('f3', 'Study grind', 'Library 303', '\u{1F4DA} Study');
    const ids = (q) => search.searchEvents(q).map((e) => e.id);
    return {
      exact: ids('chai'), typo: ids('chia'), place: ids('nescafee'),
      swapped: ids('fotball'), nonsense: ids('quidditch'), tooShort: ids('c')
    };
  });

  ok('the event search finds the exact thing first', found.exact[0] === 'f1', JSON.stringify(found.exact));
  ok('and finds it when it is typed wrong', found.typo[0] === 'f1', JSON.stringify(found.typo));
  ok('a misspelt place still finds the event', found.place[0] === 'f1', JSON.stringify(found.place));
  ok('a missing letter in the title still finds it', found.swapped[0] === 'f2', JSON.stringify(found.swapped));
  ok('and nothing matches nothing', found.nonsense.length === 0, JSON.stringify(found.nonsense));
  ok('one character is still too little to search on', found.tooShort.length === 0);
}

/* ------------------------------------------------------------------ */
group('opening an event somebody shared');
{
  // There is no separate detail view for an event — the card in the
  // feed IS the event — so View goes to the feed.
  //
  // It used to fork on width: a laptop kept the thread open and put the
  // card in a 360px column beside it, on the theory that closing the
  // conversation threw away the place you were reading. What it threw
  // away was the card. 360px is narrower than a phone gives the feed,
  // so the poster was cramped and the action row wrapped inside a
  // 1280px window. One path now, and the assertions below are
  // deliberately the SAME at both widths.
  // 1440, not 1280: past about 1400px the app frame is centred, so the
  // sidebar no longer starts at x=0. That is the width the old chip
  // offset broke at, and 1280 could not see it.
  const wideCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wide = await wideCtx.newPage();
  await wide.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await wide.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await wide.waitForTimeout(1500);

  const desk = await wide.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    const now = Date.now();
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u) => ({ uid: u, username: u, displayName: u, avatar: 'x', followers: [], following: [], vouchedBy: [] });
    state.userCache = { me: mk('me'), a: Object.assign(mk('a'), { displayName: 'Riya' }) };
    state.following = []; state.orbitUids = [];
    state.eventCache = { sh1: { id: 'sh1', title: 'Chai + assignment panic', place: 'Nescafe',
      tag: '☕ Chill', hostUid: 'a', participantUids: [], hypedUids: [],
      startTime: now - 6e4, expiresAt: now + 36e5, description: '', pendingUids: [], unconfirmedUids: [] } };
    state.eventOrder = ['sh1'];
    state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');

    state.currentChat = 'a_me'; state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
    state.currentOtherUid = 'a'; state.currentEventData = null;
    window.switchScreen('chatScreen');
    await wait(200);

    ev.showSharedEvent('sh1');
    await wait(700);
    const chip = document.getElementById('returnChip');
    return {
      chatClosed: document.getElementById('chatScreen').classList.contains('hidden'),
      feedShowing: !document.getElementById('eventsTab').classList.contains('hidden'),
      cardOnScreen: !!document.getElementById('event-sh1'),
      // The chip is the only way back now that the thread is gone, so
      // it must not merely exist — it has to be on screen. It was
      // display:none above 1100px for as long as the laptop kept the
      // conversation open, which would have stranded you here.
      chipShown: !!chip && getComputedStyle(chip).display !== 'none',
      chipText: chip ? chip.innerText.trim() : '',
      // THE CHIP MUST NOT FLOAT OVER ANYTHING. It used to be fixed at
      // the bottom left, where it covered whatever was under it —
      // reliably a card's action row, since that is what sits at the
      // bottom of a card. It is in the column's flow now, so this can
      // only pass by it genuinely not overlapping.
      chipCovers: (() => {
        if (!chip) return ['no chip'];
        const c = chip.getBoundingClientRect();
        return [...document.querySelectorAll('.event, .card-actions, .sidebar, .rail, .fab')]
          .filter((el) => {
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            const b = el.getBoundingClientRect();
            return b.width && b.height &&
                   c.right > b.left && c.left < b.right && c.bottom > b.top && c.top < b.bottom;
          })
          .map((el) => el.id ? '#' + el.id : '.' + String(el.className).trim().split(/\s+/)[0]);
      })(),
      // And it must sit inside the feed column. The old desktop offset
      // was sidebar-width + a gutter, which only held while the app
      // frame started at x=0; past ~1400px the frame is centred, the
      // sidebar starts at 40px, and the chip landed inside it.
      chipInColumn: (() => {
        if (!chip) return false;
        const c = chip.getBoundingClientRect();
        const col = document.getElementById('home').getBoundingClientRect();
        return c.left >= col.left - 1 && c.right <= col.right + 1;
      })(),
      // Nothing may still be marked as the old two-pane layout.
      noSplit: !document.querySelector('.app-frame').classList.contains('chat-open'),
      // And the feed must have the whole column, not 360px of it.
      feedWidth: Math.round(document.getElementById('home').getBoundingClientRect().width)
    };
  });
  await wideCtx.close();

  ok('on a laptop the conversation closes, same as a phone', desk.chatClosed);
  ok('and the card is on screen in the feed', desk.feedShowing && desk.cardOnScreen,
     JSON.stringify(desk));
  ok('the way back is a chip, and it is actually visible at this width',
     desk.chipShown && /Back to Riya/.test(desk.chipText), JSON.stringify(desk));
  ok('the two-pane split is gone', desk.noSplit);
  ok('the chip covers nothing \u2014 not a card, not an action row',
     desk.chipCovers.length === 0, JSON.stringify(desk.chipCovers));
  ok('and it sits inside the feed column, not in the sidebar', desk.chipInColumn);
  ok('so the feed gets a real column, not 360px', desk.feedWidth > 500, String(desk.feedWidth));

  // On a phone only one of them fits, so the chat does go — but it
  // leaves a way back rather than just vanishing.
  const narrowCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const narrow = await narrowCtx.newPage();
  await narrow.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await narrow.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await narrow.waitForTimeout(1500);

  const ph = await narrow.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    const now = Date.now();
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u, n) => ({ uid: u, username: u, displayName: n || u, avatar: 'x', followers: [], following: [], vouchedBy: [] });
    state.userCache = { me: mk('me'), a: mk('a', 'Riya') };
    state.following = []; state.orbitUids = [];
    state.eventCache = { sh1: { id: 'sh1', title: 'Chai + assignment panic', place: 'Nescafe',
      tag: '☕ Chill', hostUid: 'a', participantUids: [], hypedUids: [],
      startTime: now - 6e4, expiresAt: now + 36e5, description: '', pendingUids: [], unconfirmedUids: [] } };
    state.eventOrder = ['sh1'];
    state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');

    state.currentChat = 'a_me'; state.currentChatType = 'direct';
    state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
    state.currentOtherUid = 'a'; state.currentEventData = null;
    window.switchScreen('chatScreen');
    await wait(200);

    ev.showSharedEvent('sh1');
    await wait(700);
    const chip = document.getElementById('returnChip');
    const fab = document.querySelector('.fab');
    const nav = document.querySelector('.bottom-nav');
    const hit = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
    const cr = chip ? chip.getBoundingClientRect() : null;
    // Where a thumb is: the bottom quarter of the screen, above the tab
    // bar, and not over the shared card's own buttons.
    const reach = !!cr && cr.top > innerHeight * 0.75 && cr.bottom <= innerHeight
      && (!nav || !hit(cr, nav.getBoundingClientRect()));
    const actions = document.querySelector('#event-sh1 .card-actions');
    const coversActions = !!cr && !!actions && hit(cr, actions.getBoundingClientRect());
    const overlapping = (() => {
      if (!chip || !fab || getComputedStyle(fab).display === 'none') return false;
      const a = chip.getBoundingClientRect(), b = fab.getBoundingClientRect();
      return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
    })();
    return {
      chatClosed: document.getElementById('chatScreen').classList.contains('hidden'),
      cardOnScreen: !!document.getElementById('event-sh1'),
      chipText: chip ? chip.innerText.trim() : '',
      // The name belongs to another student: it must be text, never markup.
      chipIsText: chip ? !/<|>/.test(chip.innerHTML.replace(/<i [^>]*><\/i>/, '')) : false,
      overlapping,
      reach, coversActions,
      // And it must not outlive the screen it belongs to.
      clearedOnNavigate: (() => { window.switchScreen('home'); return !document.getElementById('returnChip'); })()
    };
  });
  await narrowCtx.close();

  ok('and on a phone, the very same thing', ph.chatClosed);
  ok('and the shared card is the one on screen', ph.cardOnScreen);
  ok('but it leaves a way back, by name', /Back to Riya/.test(ph.chipText), ph.chipText);
  ok('the name goes in as text, never markup', ph.chipIsText);
  ok('the chip does not sit under the compose button', !ph.overlapping);
  ok('on a phone it is at the bottom, where a thumb reaches, clear of the tab bar', ph.reach);
  ok('and it does not cover the shared card\u2019s buttons', !ph.coversActions);
  ok('and it does not outlive the screen it belongs to', ph.clearedOnNavigate);
}

/* ------------------------------------------------------------------ */
group('nothing is cut off');
{
  // Four separate bugs lived here at once, and none of them was visible
  // at the width anyone develops at:
  //
  //   1. A 320px phone sliced "GOING" off the poster band. The halftone
  //      column had already given up all its width, and the type column
  //      is deliberately un-shrinkable, so the band ran out past the
  //      card's own overflow: hidden.
  //   2. Opening a chat on a laptop put the feed in a 330px column that
  //      was sized for the chat LIST, which cut the band the same way.
  //   3. The live rail bleeds out by one gutter to run edge to edge.
  //      The gutter was hard-coded in three places, and the chat-open
  //      layout changed one of them — so the rail hung 7px over the
  //      divider and into the conversation.
  //   4. The swipe-to-reply icons parked 42px outside the thread, which
  //      left #messages permanently wider than its own box.
  //
  // So this does not test any of those four causes. It renders the app
  // and asks the only question that matters: is anything on screen
  // being sliced off, or reaching somewhere it shouldn't? Each of the
  // four was re-introduced one at a time and this caught all four.
  const look = async (width, height, mode) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
    await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);

    const rows = await p.evaluate(async (mode) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const { state } = await import('/js/state/store.js');
      const ev = await import('/js/services/eventsService.js');
      const chat = await import('/js/services/chatService.js');
      const now = Date.now();
      window.__authSingleton.currentUser = { uid: 'me' };
      state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
      state.userAvatar = '\u{1F43C}'; state.username = 'you';
      const mk = (u) => ({ uid: u, username: u, displayName: u === 'a' ? 'Sanchit Kumar' : u,
                           avatar: '\u{1F98A}', followers: [], following: [], vouchedBy: [] });
      state.userCache = Object.fromEntries(['me', 'a', 'b', 'c'].map((u) => [u, mk(u)]));
      state.following = []; state.orbitUids = [];
      const tags = ['☕ Chill', '\u{1F355} Food', '\u{1F389} Party', '\u{1F4DA} Study', '\u{1F3C0} Sports'];
      // THE ACTION ROW IS WIDEST WHEN THE CARD IS YOURS, and this used
      // to seed six identical events hosted by somebody else, joined by
      // nobody. That is the NARROWEST row the app can draw - hype,
      // share, Join - so the day Share was added to the row, the three
      // variants that then overflowed (Manage, Going and "2 requests",
      // each of which also brings the Chat button along) were the three
      // this never rendered. Every variant is seeded now.
      const rows = [
        // Join, with two photos: the cover has to fit at every width too.
        { hostUid: 'a', participantUids: ['a', 'b'],
          photos: [1, 2].map((n) => 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/events%2Fa%2FPhotoNumber' + n + 'xxxxxxxx.jpg?alt=media&token=t-' + n),
          place: 'Nescafe, back lawn, behind the old library, next to the cycle stand by gate three' },
        { hostUid: 'me', participantUids: ['me'] },                     // Chat + Manage
        { hostUid: 'a', participantUids: ['a', 'b', 'me'] },            // Chat + Going
        { hostUid: 'me', participantUids: ['me'], pendingUids: ['b', 'c'] }, // Chat + 2 requests
        { hostUid: 'a', participantUids: ['a'], requiresApproval: true },    // Request
        { hostUid: 'a', participantUids: ['a', 'b'], maxCapacity: 2 }        // Full
      ];
      state.eventCache = {}; state.eventOrder = [];
      rows.forEach((row, i) => {
        const id = 'o' + i;
        state.eventCache[id] = Object.assign({
          id, title: 'Chai + assignment panic ' + i, place: 'Nescafe, back lawn',
          tag: tags[i % 5], hypedUids: ['a'],
          startTime: now - 6e4, expiresAt: now + 36e5, description: '',
          pendingUids: [], unconfirmedUids: [] }, row);
        state.eventOrder.push(id);
      });
      state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
      document.getElementById('loading-screen').classList.add('hidden');
      document.querySelector('.app-frame').classList.remove('hidden');
      window.switchScreen('home'); ev.renderEvents();
      await wait(300);

      if (mode !== 'feed') {
        state.currentChat = 'a_me'; state.currentChatType = 'direct';
        state.currentChatStatus = 'unlocked'; state.currentChatData = { unreadByUid: '' };
        state.currentOtherUid = 'a'; state.currentEventData = null;
        window.switchScreen('chatScreen');
        const m = (id, senderUid, text, extra = {}) =>
          ({ id, data: () => Object.assign({ senderUid, text, time: now - 1000 }, extra) });
        window.__docs = [
          m('x1', 'a', 'you free tonight?'),
          m('x2', 'me', 'u shut up snake', { reactions: { a: '\u{1F62E}' } }),
          m('x3', 'me', 'hello', { editedAt: now - 500, reactions: { a: '\u{1F525}' } }),
          m('x4', 'me', 'https://livesociya.com/?e=o0'),
          m('x5', 'a', 'https://example.com/a/very/long/url/that/will/not/wrap/at/all/ever/no/spaces/here'),
          // An embed is the widest fixed thing a bubble ever holds.
          m('x5b', 'a', 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
          m('x6', 'me', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        ];
        chat.loadMessages();
        await wait(450);
      }
      // The state a laptop lands in after tapping View in a thread.
      // This used to set up the two-pane split by hand; there is no
      // split any more, so it walks the real path instead — which is
      // the screenshot that started this: a card, at 1280, reached
      // from a conversation.
      if (mode === 'both') {
        ev.showSharedEvent('o1');
        await wait(700);
      }
      // The event page, with its photos and a place too long for a card.
      if (mode === 'page') {
        window.openEventPage('o0');
        await wait(500);
      }

      const out = [];
      const nameOf = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
        (typeof e.className === 'string' && e.className
          ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      const shows = (e) => {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const clipperOf = (e) => {
        for (let q = e.parentElement; q; q = q.parentElement) {
          if (getComputedStyle(q).overflowX !== 'visible') return q;
        }
        return null;
      };
      document.querySelectorAll('*').forEach((e) => {
        if (!shows(e)) return;
        const s = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        const c = clipperOf(e);
        const cs = c ? getComputedStyle(c) : null;
        // A horizontal scroller is SUPPOSED to hold wider content.
        const scroller = cs && (cs.overflowX === 'auto' || cs.overflowX === 'scroll');
        const limit = c ? c.getBoundingClientRect().right : document.documentElement.clientWidth;
        if (!scroller && r.right > limit + 1) {
          out.push({ why: 'reaches past ' + (c ? nameOf(c) : 'the window'), el: nameOf(e), by: Math.round(r.right - limit) });
        }
        // An element that CLIPS, holding content wider than itself, is
        // the only case where something is actually sliced. Visible
        // overflow is just layout, and the check above judges where it
        // lands. One-line ellipsis and line-clamp are on purpose.
        const onPurpose = (s.textOverflow === 'ellipsis' && s.whiteSpace === 'nowrap') ||
                          (s.webkitLineClamp && s.webkitLineClamp !== 'none');
        const clips = s.overflowX === 'hidden' || s.overflowX === 'clip';
        if (clips && !onPurpose && e.scrollWidth > e.clientWidth + 2) {
          out.push({ why: 'slices its own content', el: nameOf(e), by: e.scrollWidth - e.clientWidth });
        }
      });
      // And nothing in the feed column may reach past the column: a
      // full-bleed row escapes its padding on purpose, but past the
      // column it is over the divider and into the chat.
      const home = document.getElementById('home');
      if (home && !home.classList.contains('hidden')) {
        const edge = home.getBoundingClientRect().right;
        const inScroller = (e) => {
          for (let q = e.parentElement; q && q !== home; q = q.parentElement) {
            const o = getComputedStyle(q).overflowX;
            if (o === 'auto' || o === 'scroll') return true;
          }
          return false;
        };
        home.querySelectorAll('*').forEach((e) => {
          if (!shows(e) || inScroller(e)) return;
          const r = e.getBoundingClientRect();
          if (r.right > edge + 1) out.push({ why: 'past the feed column', el: nameOf(e), by: Math.round(r.right - edge) });
        });
      }
      const seen = new Map();
      out.forEach((o) => { const k = o.why + '|' + o.el; if (!seen.has(k) || seen.get(k).by < o.by) seen.set(k, o); });
      return [...seen.values()].sort((a, b) => b.by - a.by).slice(0, 4);
    }, mode);

    await ctx.close();
    return { rows, errs };
  };

  const small = await look(320, 700, 'feed');
  ok('a 320px phone slices nothing off the feed', small.rows.length === 0, JSON.stringify(small.rows));

  const smallChat = await look(320, 700, 'chat');
  ok('and nothing off a thread either, shared cards and long links included',
     smallChat.rows.length === 0, JSON.stringify(smallChat.rows));

  const phone = await look(390, 844, 'chat');
  ok('a normal phone thread is clean', phone.rows.length === 0, JSON.stringify(phone.rows));

  const beside = await look(1280, 860, 'both');
  ok('and after View lands you on a card from a thread, at 1280',
     beside.rows.length === 0, JSON.stringify(beside.rows));

  const pageSmall = await look(320, 700, 'page');
  ok('the event page slices nothing at 320, photos and a long place included',
     pageSmall.rows.length === 0, JSON.stringify(pageSmall.rows));

  const pageWide = await look(1280, 860, 'page');
  ok('nor at 1280', pageWide.rows.length === 0, JSON.stringify(pageWide.rows));

  // On a laptop the page is TWO columns: the event, and beside it the
  // people, the actions and (on a finished event) the comment box —
  // not one 640px column with the box stretched across the window.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage();
    await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const lay = await p.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const { state } = await import('/js/state/store.js');
      const now = Date.now();
      window.__authSingleton.currentUser = { uid: 'me' };
      state.uid = 'me'; state.blockedUids = [];
      state.userCache = { me: { uid: 'me', username: 'me_h', displayName: 'Me' }, a: { uid: 'a', username: 'a', displayName: 'A' } };
      state.eventCache = { z: { id: 'z', hostUid: 'a', title: 'Done', place: 'Lawn', tag: '\u2615 Chill', description: '',
        startTime: now - 5 * 36e5, expiresAt: now - 36e5, participantUids: ['a', 'me'], hypedUids: [], pendingUids: [], unconfirmedUids: [] } };
      document.getElementById('loading-screen').classList.add('hidden');
      document.querySelector('.app-frame').classList.remove('hidden');
      window.openEventPage('z');
      await wait(500);
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const main = r('#eventPageBody'), side = r('.ep-side'), box = r('#epCompose');
      return {
        beside: side.left >= main.right, sameTop: Math.abs(side.top - main.top) < 4,
        boxInSide: box.left >= side.left - 1 && box.right <= side.right + 1 && box.bottom <= side.bottom + 1,
        boxWidth: Math.round(box.width), used: Math.round(side.right - main.left)
      };
    });
    await ctx.close();
    ok('on a laptop the event page is two columns, side by side', lay.beside && lay.sameTop, JSON.stringify(lay));
    ok('and the comment box sits in the side column, not across the window', lay.boxInSide && lay.boxWidth < 420);
    ok('using the width of a laptop, not 640px of it', lay.used > 900);
  }

  ok('no errors while measuring any of that',
     [small, smallChat, phone, beside, pageSmall, pageWide].every((r) => r.errs.length === 0),
     [small, smallChat, phone, beside, pageSmall, pageWide].flatMap((r) => r.errs).join(' | '));
}

/* ------------------------------------------------------------------ */
group('pull to refresh');
{
  // The browser's own went out with the bounce — they are one feature,
  // and `overscroll-behavior-y: none` turns off both. Installed to a
  // home screen there is no address bar and no reload button either,
  // so there was no way to reload at all. This is ours, and the two
  // things worth holding are that it arms at the top of the feed and
  // that it does NOT arm anywhere else.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1600);

  const out = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    const now = Date.now();
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u) => ({ uid: u, username: u, displayName: u, avatar: 'x',
                         followers: [], following: [], vouchedBy: [] });
    state.userCache = Object.fromEntries(['me', 'a'].map((u) => [u, mk(u)]));
    state.following = []; state.orbitUids = [];
    state.eventCache = {}; state.eventOrder = [];
    for (let i = 0; i < 12; i++) {
      const id = 'p' + i;
      state.eventCache[id] = { id, title: 'Chai ' + i, place: 'Lawn', tag: '\u2615 Chill',
        hostUid: 'a', participantUids: ['a'], hypedUids: [], startTime: now - 6e4,
        expiresAt: now + 72e5, description: '', pendingUids: [], unconfirmedUids: [] };
      state.eventOrder.push(id);
    }
    state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home'); ev.renderEvents();
    await wait(400);

    // A pull is three touch events. Dispatched rather than driven,
    // because what is being tested is the arming logic, not the
    // browser's own gesture recognition.
    // On an ELEMENT, not on document. A real touch always lands on one,
    // and the listeners here are delegated, so dispatching at the
    // document gives every handler in the app a target with no
    // closest() — which is a property of the test, not of the app.
    const onto = () => document.getElementById('events') || document.body;
    const touch = (type, y) => {
      const el = onto();
      const t = new Touch({ identifier: 1, target: el, clientX: 40, clientY: y });
      el.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t], bubbles: true, cancelable: true
      }));
    };
    const pull = async (to) => { touch('touchstart', 20); await wait(20);
                                 touch('touchmove', to); await wait(40); };
    const node = () => document.getElementById('pullRefresh');

    // 1. A short pull at the top shows the indicator but does not fire.
    await pull(80);
    const shortPull = { exists: !!node(), moved: node() && node().style.transform };
    touch('touchend', 80); await wait(60);
    const afterShort = { spinning: !!node() && node().classList.contains('spinning') };

    // 2. Scrolled down, the same gesture must do nothing at all.
    window.scrollTo(0, 400); await wait(80);
    const before = node() ? node().style.transform : '';
    await pull(200);
    const scrolledDown = { unchanged: (node() ? node().style.transform : '') === before };
    touch('touchend', 200); await wait(40);
    window.scrollTo(0, 0); await wait(120);

    // 3. An upward drag at the top is the page scrolling, not a pull.
    touch('touchstart', 200); await wait(20); touch('touchmove', 150); await wait(40);
    const up = { unchanged: node().style.transform === '' || !/translateY\((?!-)/.test(node().style.transform) };
    touch('touchend', 150); await wait(40);

    return { shortPull, afterShort, scrolledDown, up,
             listeners: typeof Touch === 'function' };
  });

  // The long pull is last and in its own evaluate, because it really
  // does reload the page.
  const fired = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const touch = (type, y) => {
      const el = document.getElementById('events') || document.body;
      const t = new Touch({ identifier: 1, target: el, clientX: 40, clientY: y });
      el.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t], bubbles: true, cancelable: true
      }));
    };
    touch('touchstart', 20); await wait(20);
    touch('touchmove', 260); await wait(40);
    touch('touchend', 260); await wait(80);      // well inside the 260ms beat
    const n = document.getElementById('pullRefresh');
    return { spinning: !!n && n.classList.contains('spinning') };
  });
  await ctx.close();

  ok('a pull at the top of the feed moves the indicator',
     out.shortPull.exists && /translateY\(\d/.test(out.shortPull.moved || ''),
     JSON.stringify(out.shortPull));
  ok('letting go short of the trigger does not reload', !out.afterShort.spinning);
  ok('pulling past it does', fired.spinning, JSON.stringify(fired));
  ok('a scrolled feed does not arm at all', out.scrolledDown.unchanged);
  ok('and neither does an upward drag', out.up.unchanged);
  ok('no errors from any of that', errs.length === 0, errs.join(' | '));
}

/* ------------------------------------------------------------------ */
group('everything scrolls to its bottom');
{
  // The profile's inner box is the scroller on a phone, where the
  // profile is a fixed full-screen layer. On a laptop the wrapper
  // joins the grid with `min-height: 100dvh` instead, so that box grew
  // to its own content: scrollHeight === clientHeight, 1086px tall in
  // an 860px window, and still a scroll container carrying
  // `overscroll-behavior: contain`. It could never scroll a pixel, and
  // it sat over the whole column telling the browser not to pass the
  // wheel on.
  //
  // Chromium happens to pass it through anyway, which is why this
  // tests the STRUCTURE rather than the gesture: a browser that takes
  // `contain` at its word strands the bottom of the page, and a test
  // that only drives a wheel in Chromium would never see it. The rule
  // is simple enough to hold everywhere — a box that can never scroll
  // has no business being a scroll container.
  const sweep = async (width, height) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
    await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);

    await p.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const { state } = await import('/js/state/store.js');
      const ev = await import('/js/services/eventsService.js');
      const now = Date.now();
      window.__authSingleton.currentUser = { uid: 'me' };
      state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
      state.userAvatar = 'x'; state.username = 'you';
      const many = Array.from({ length: 20 }, (_, i) => 'u' + i);
      const mk = (u) => ({ uid: u, username: u, displayName: 'Person ' + u, avatar: 'x',
        followers: many, following: many, vouchedBy: [],
        bio: 'A long enough bio that the profile has something to scroll past. '.repeat(3),
        interests: ['music', 'football', 'chai', 'film', 'code'] });
      state.userCache = Object.fromEntries(['me', ...many].map((u) => [u, mk(u)]));
      state.following = many; state.orbitUids = many.slice(0, 8);
      state.eventCache = {}; state.eventOrder = []; state.recapOrder = [];
      for (let i = 0; i < 14; i++) {
        const id = 's' + i;
        state.eventCache[id] = { id, title: 'Event ' + i, place: 'Lawn', tag: '☕ Chill',
          hostUid: 'u1', participantUids: ['u1'], hypedUids: [], startTime: now - 6e4,
          expiresAt: now + 36e5, description: '', pendingUids: [], unconfirmedUids: [] };
        state.eventOrder.push(id);
      }
      state.recapDone = true; state.currentLiveFilter = 'All';
      document.getElementById('loading-screen').classList.add('hidden');
      document.querySelector('.app-frame').classList.remove('hidden');
      window.switchScreen('home'); ev.renderEvents();
      await wait(350);
    });

    // Every scroll container that can never scroll while being taller
    // than the window. Each one is a place a wheel can land and go
    // nowhere.
    const dead = async () => p.evaluate(() => {
      const out = [];
      const vh = document.documentElement.clientHeight;
      document.querySelectorAll('*').forEach((e) => {
        const s = getComputedStyle(e);
        if (!['auto', 'scroll'].includes(s.overflowY)) return;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (e.scrollHeight <= e.clientHeight + 2 && r.height > vh + 2) {
          out.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
            (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : '') +
            ' ' + Math.round(r.height) + 'px in ' + vh);
        }
      });
      return out;
    });

    const go = async (how) => {
      await p.evaluate(async (how) => {
        document.querySelectorAll('.full-screen-view:not(.hidden)').forEach((e) => e.classList.add('hidden'));
        window.scrollTo(0, 0);
        if (how === 'profile') window.openProfileScreen('me');
        else if (how === 'claim') window.switchScreen('usernameScreen');
        else if (how) window[how]?.();
        await new Promise((r) => setTimeout(r, 450));
      }, how);
      const found = await dead();
      // Then scroll everything there is to scroll and see whether the
      // last thing on the screen can be got to.
      // Enough wheel to cover the whole feed however tall a card is:
      // the band grew a line when its stat went vertical, and fourteen
      // cards outran the old fixed 4800px.
      const tall = await p.evaluate(() => document.documentElement.scrollHeight);
      for (let i = 0; i < Math.max(8, Math.ceil(tall / 600) + 2); i++) {
        await p.mouse.move(width / 2, height * 0.6);
        await p.mouse.wheel(0, 600);
        await p.waitForTimeout(90);
      }
      const reached = await p.evaluate((how) => {
        const sel = how === 'profile' ? '.profile-scroll-body'
          : how === 'claim' ? '#usernameScreen'
            : how ? '.full-screen-view:not(.hidden) .screen-body' : '#eventsTab';
        const box = document.querySelector(sel);
        const last = box && box.lastElementChild;
        if (!last) return true;
        return last.getBoundingClientRect().bottom <= document.documentElement.clientHeight + 6;
      }, how);
      return { found, reached };
    };

    const results = {};
    for (const how of [null, 'profile', 'openSettingsScreen', 'openCreateScreen', 'claim']) {
      results[how || 'feed'] = await go(how);
    }
    await ctx.close();
    return { results, errs };
  };

  // The third one is the point: a landscape phone, or a laptop window
  // dragged to half height. Claiming a handle has no inner scroller —
  // the layer itself is it — and `.full-screen-view` sets
  // `overflow: hidden`, so the account-type cards and the Join button
  // went off the bottom with nothing to scroll. Nothing is short
  // enough to show that at the other two sizes.
  for (const [w, h, label] of [[1280, 860, 'a laptop'], [390, 700, 'a phone'], [820, 460, 'a short window']]) {
    const { results, errs } = await sweep(w, h);
    const stuck = Object.entries(results).filter(([, r]) => r.found.length);
    const unreachable = Object.entries(results).filter(([, r]) => !r.reached).map(([k]) => k);

    ok(`no dead scroll containers on ${label}`, stuck.length === 0,
       JSON.stringify(stuck.map(([k, r]) => k + ': ' + r.found.join(', '))));
    ok(`and the bottom of every screen can be reached on ${label}`,
       unreachable.length === 0, unreachable.join(', '));
    ok(`no errors getting there on ${label}`, errs.length === 0, errs.join(' | '));
  }
}

/* ------------------------------------------------------------------ */
group('sharing an event to several people');
{
  // The sheet used to send the moment a face was tapped: one person per
  // open, only people you had already messaged, and a misplaced thumb
  // was a message you could not take back. Now it is pick, then Send —
  // and each send obeys the same icebreaker rules as the composer.
  const phCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const ph = await phCtx.newPage();
  const errs = [];
  ph.on('pageerror', (e) => errs.push(e.message));
  await ph.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await ph.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await ph.waitForTimeout(1500);

  const r = await ph.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const share = await import('/js/services/shareService.js');
    const now = Date.now();
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u, n) => ({ uid: u, username: u, displayName: n || u, avatar: 'x', followers: [], following: [], vouchedBy: [] });
    state.userCache = { me: mk('me'), a: mk('a', 'Riya'), b: mk('b', 'Arjun'), c: mk('c', 'Neha'), d: mk('d', 'Kabir') };
    state.recentChatUids = ['a', 'd'];
    state.following = ['b', 'c', 'a'];
    state.eventCache = { e1: { id: 'e1', title: 'Chai + assignment panic', place: 'Back lawn',
      tag: '☕ Chill', hostUid: 'a', participantUids: [], hypedUids: [],
      startTime: now - 6e4, expiresAt: now + 36e5, description: '', pendingUids: [], unconfirmedUids: [] } };
    // a: an open conversation. b: follows me back, no chat yet.
    // c: I follow, they don't, never talked — a stranger's icebreaker.
    // d: I already spent my one opener and they never replied.
    window.__stubDocs['chats/a_me'] = { userUids: ['a', 'me'], status: 'unlocked', initiatedByUid: 'a', icebreakerUsed: false };
    window.__stubDocs['users/me/followers/b'] = { at: 1 };
    window.__stubDocs['chats/d_me'] = { userUids: ['d', 'me'], status: 'icebreaker', initiatedByUid: 'me', icebreakerUsed: true };
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');

    share.openShare('e1');
    await wait(350);
    const sheet = document.querySelector('#shareSheet .share-sheet');
    const rows = () => [...document.querySelectorAll('#sharePeople .share-row')].map((x) => x.getAttribute('data-uid'));
    const order = rows();
    const box = sheet.getBoundingClientRect();
    const writesBefore = window.__writes;
    const tap = (uid) => document.querySelector(`#sharePeople [data-uid="${uid}"]`).click();
    tap('a');
    await wait(50);
    const tappedSent = window.__writes !== writesBefore;
    const sendShownAfterOne = !document.getElementById('shareSendBar').classList.contains('hidden');
    const outHiddenAfterOne = document.getElementById('shareOut').classList.contains('hidden');
    tap('b'); tap('c');
    const label = document.getElementById('shareSendBtn').textContent.trim();
    tap('c'); tap('c');           // untick and tick again: still three
    const labelAgain = document.getElementById('shareSendBtn').textContent.trim();

    // Search filters the list, and what you ticked stays ticked.
    const search = document.getElementById('shareSearch');
    search.value = 'ney'; search.dispatchEvent(new Event('input'));
    await wait(20);
    const filteredEmptyOrNot = rows();
    search.value = 'ne'; search.dispatchEvent(new Event('input'));
    await wait(20);
    const filtered = rows();
    const stillOn = document.querySelector('#sharePeople [data-uid="c"]').classList.contains('on');
    search.value = ''; search.dispatchEvent(new Event('input'));
    await wait(20);

    document.getElementById('shareNote').value = 'come through';
    document.getElementById('shareSendBtn').click();
    await wait(600);
    const msgs = (id) => Object.keys(window.__stubDocs)
      .filter((k) => k.startsWith('chats/' + id + '/messages/')).map((k) => window.__stubDocs[k]);
    const toastText = (document.getElementById('toastBox') || {}).innerText || '';

    // The one who has not replied yet: refused before anything is written.
    share.openShare('e1');
    await wait(100);
    const w2 = window.__writes;
    document.querySelector('#sharePeople [data-uid="d"]').click();
    document.getElementById('shareSendBtn').click();
    await wait(400);
    const dToast = (document.getElementById('toastBox') || {}).innerText || '';

    return {
      order, tappedSent, sendShownAfterOne, outHiddenAfterOne, label, labelAgain,
      filtered, stillOn, filteredEmptyOrNot,
      sheetOnBottom: Math.abs(box.bottom - innerHeight) < 2 && box.left >= 0 && box.right <= innerWidth + 0.5,
      closedAfterSend: document.getElementById('shareSheet').classList.contains('hidden'),
      aText: (msgs('a_me')[0] || {}).text || '',
      bChat: window.__stubDocs['chats/b_me'] || null, bMsgs: msgs('b_me').length,
      cChat: window.__stubDocs['chats/c_me'] || null, cMsgs: msgs('c_me').length,
      toastText, dWrites: window.__writes - w2, dMsgs: msgs('d_me').length, dToast,
      noScrollbars: getComputedStyle(document.documentElement).scrollbarWidth === 'none'
        && getComputedStyle(document.getElementById('sharePeople')).scrollbarWidth === 'none',
      noVerifiedLine: !/verified students/i.test(document.getElementById('login').innerText
        + document.getElementById('login').textContent),
    };
  });

  ok('conversations come first, then the people you follow', JSON.stringify(r.order) === JSON.stringify(['a', 'd', 'b', 'c']), JSON.stringify(r.order));
  ok('the sheet is a bottom sheet on a phone, inside the screen', r.sheetOnBottom);
  ok('tapping a person ticks them and sends nothing', !r.tappedSent);
  ok('one tick swaps the ways out for the Send bar', r.sendShownAfterOne && r.outHiddenAfterOne);
  ok('Send says how many', r.label === 'Send to 3' && r.labelAgain === 'Send to 3', r.label + ' / ' + r.labelAgain);
  ok('search narrows the list and keeps what you ticked', JSON.stringify(r.filtered) === JSON.stringify(['c']) && r.stillOn, JSON.stringify(r.filtered));
  ok('Send closes the sheet', r.closedAfterSend);
  ok('an open conversation gets the note and the link in ONE message',
     /^come through\n/.test(r.aText) && /\?e=e1/.test(r.aText), JSON.stringify(r.aText));
  ok('somebody who follows you back gets an unlocked chat',
     !!r.bChat && r.bChat.status === 'unlocked' && r.bMsgs === 1, JSON.stringify(r.bChat));
  ok('a stranger gets the icebreaker, and it is spent in the same write',
     !!r.cChat && r.cChat.status === 'icebreaker' && r.cChat.icebreakerUsed === true && r.cMsgs === 1, JSON.stringify(r.cChat));
  ok('one toast says who it went to', /Sent to Riya and 2 others/.test(r.toastText), r.toastText);
  ok('an opener already spent is refused before anything is written',
     r.dWrites === 0 && r.dMsgs === 0 && /Wait for them to reply/.test(r.dToast), JSON.stringify({ w: r.dWrites, t: r.dToast }));
  ok('no scrollbars are drawn, the page or the sheet', r.noScrollbars);
  ok('the front door no longer says "verified students only"', r.noVerifiedLine);
  ok('no errors from any of that', errs.length === 0, errs.join(' | '));
  await phCtx.close();
}

/* ------------------------------------------------------------------ */
group('icons, the orbit, the emoji picker and the inbox');
{
  // Every Boxicons class the app uses must be DRAWN in style.css now —
  // there is no icon font any more, so a name with no rule is an empty
  // square on screen. This is a static check: it reads the source.
  const fs = await import('node:fs');
  const root = new URL('..', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  const walk = (dir) => fs.readdirSync(new URL(dir, root), { withFileTypes: true })
    .flatMap((d) => d.isDirectory() ? walk(dir + d.name + '/') : (d.name.endsWith('.js') ? [dir + d.name] : []));
  const source = [read('index.html'), ...walk('js/').map(read)].join('\n');
  const css = read('style.css');
  const used = [...new Set(source.match(/\bbx[sl]?-[a-z0-9-]+/g) || [])];
  const undrawn = used.filter((n) => !new RegExp('\\.' + n + '\\s*\\{').test(css));
  ok('every icon name the app uses is drawn in the stylesheet', undrawn.length === 0, undrawn.join(', '));

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await pg.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(1500);

  const r = await pg.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const ui = await import('/js/utils/ui.js');
    const chat = await import('/js/services/chatService.js');
    const prof = await import('/js/services/profileService.js');
    const orbit = await import('/js/services/orbitService.js');
    const now = Date.now();
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u, n, a) => ({ uid: u, username: u, displayName: n, avatar: a, followers: [], following: [], vouchedBy: [] });
    const ppl = [['r', 'Riya', '🦊'], ['a', 'Arjun', '🐻'], ['n', 'Neha', '🐯'], ['k', 'Kabir', '🐨'], ['z', 'Zoya', '🐸'], ['d', 'Dev', '🐱']];
    state.userCache = { me: mk('me', 'Me', '🐼') };
    ppl.forEach(([u, n, a]) => { state.userCache[u] = mk(u, n, a); window.__stubDocs['users/' + u] = mk(u, n, a); });
    window.__stubDocs['users/me'] = mk('me', 'Me', '🐼');
    state.following = ppl.map((p) => p[0]); state.followRequests = [];
    state.orbitUids = ppl.map((p) => p[0]); state.orbitIncoming = []; state.orbitOutgoing = [];
    state.eventCache = {}; state.eventOrder = []; state.recapOrder = []; state.recapDone = true;
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('login').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');
    const out = {};

    // Drawn, not fetched.
    out.noIconFont = !document.querySelector('link[href*="boxicons"]');
    const navIcons = [...document.querySelectorAll('.side-item i.bx')];
    out.navDrawn = navIcons.length >= 3 && navIcons.every((i) => {
      const cs = getComputedStyle(i);
      const mask = cs.webkitMaskImage || cs.maskImage || '';
      const box = i.getBoundingClientRect();
      return /data:image\/svg/.test(mask) && box.width >= 12 && box.height >= 12;
    });

    // The inbox says when, and where each conversation stands.
    window.__stubDocs['chats/me_r'] = { userUids: ['me', 'r'], status: 'unlocked', lastUpdated: now - 6e4, unreadByUid: 'me', initiatedByUid: 'r' };
    window.__stubDocs['chats/a_me'] = { userUids: ['a', 'me'], status: 'unlocked', lastUpdated: now - 2e5, unreadByUid: '', initiatedByUid: 'me', typingUid: 'a' };
    window.__stubDocs['chats/me_n'] = { userUids: ['me', 'n'], status: 'icebreaker', lastUpdated: now - 3e5, unreadByUid: '', initiatedByUid: 'me', icebreakerUsed: true };
    window.showTab('chats');
    chat.loadChatList();
    await wait(400);
    const rows = [...document.querySelectorAll('#chatList .chat-item')];
    out.rowCount = rows.length;
    out.allTimed = rows.length === 3 && rows.every((x) => (x.querySelector('.chat-when')?.innerText || '').trim().length > 0);
    out.subs = rows.map((x) => x.querySelector('.chat-sub span')?.innerText.trim());
    out.unreadMarked = rows[0]?.classList.contains('unread');

    // Emoji: goes in at the caret, keeps the field focused on a laptop,
    // and Escape puts the panel away.
    chat.openChat('d_me', 'd');
    await wait(400);
    out.helloShown = !document.getElementById('threadHello').classList.contains('hidden');
    const input = document.getElementById('msgInput');
    input.value = 'ab';
    input.focus();
    input.setSelectionRange(1, 1);
    const btn = document.getElementById('emojiBtn');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn.click();
    await wait(100);
    const panel = document.getElementById('emojiPanel');
    out.panelOpen = !!panel && !panel.classList.contains('hidden');
    const cell = panel.querySelector('.emoji-cell');
    const picked = cell.dataset.emoji;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    cell.click();
    out.inserted = input.value === 'a' + picked + 'b';
    out.caretAfter = input.selectionStart === 1 + picked.length;
    out.focusKept = document.activeElement === input;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.escCloses = panel.classList.contains('hidden');
    btn.click();
    out.recentHasIt = [...panel.querySelectorAll('.emoji-cell')].some((c) => c.dataset.emoji === picked)
      && panel.querySelector('.emoji-tab.on')?.dataset.cat === 'recent';
    // An opener fills the box; it does not send.
    const w0 = window.__writes;
    document.querySelector('#threadHello [data-opener]').click();
    out.openerFills = /Hey/.test(input.value) && window.__writes === w0;
    chat.closeChat({ silent: true });
    await wait(50);
    out.closedWithChat = panel.classList.contains('hidden') && document.getElementById('threadHello').classList.contains('hidden');

    // The orbit: faces travel round the ring but are never turned.
    prof.openProfileScreen('me');
    await wait(900);
    await wait(900);
    const faces = [...document.querySelectorAll('.orbit-face')];
    const angle = (el) => {
      let m = new DOMMatrix();
      const chain = [];
      for (let n = el; n && !n.classList.contains('orbit-system'); n = n.parentElement) chain.unshift(n);
      chain.forEach((n) => { const t = getComputedStyle(n).transform; if (t && t !== 'none') m = m.multiply(new DOMMatrix(t)); });
      return Math.atan2(m.b, m.a) * 180 / Math.PI;
    };
    out.faceCount = faces.length;
    out.angles = faces.map((f) => Math.round(angle(f)));
    return out;
  });

  ok('no icon font is loaded at all', r.noIconFont);
  ok('the sidebar icons are painted from the stylesheet', r.navDrawn);
  ok('every inbox row says when', r.allTimed, JSON.stringify(r.subs));
  ok('and where the conversation stands', JSON.stringify(r.subs) === JSON.stringify(['New message', 'typing…', 'Waiting for a reply']), JSON.stringify(r.subs));
  ok('an unread conversation is marked', r.unreadMarked === true);
  ok('an empty conversation greets you', r.helloShown);
  ok('the emoji button opens the panel', r.panelOpen);
  ok('an emoji goes in at the caret', r.inserted && r.caretAfter);
  ok('and the field keeps its focus on a laptop', r.focusKept);
  ok('Escape puts the panel away', r.escCloses);
  ok('what you used shows up under Recent', r.recentHasIt);
  ok('an opener fills the box and sends nothing', r.openerFills);
  ok('closing the chat takes the panel and the greeting with it', r.closedWithChat);
  ok('orbit faces are drawn', r.faceCount >= 6, String(r.faceCount));
  ok('and every one of them is upright', r.angles.length > 0 && r.angles.every((a) => Math.abs(a) <= 2), JSON.stringify(r.angles));
  ok('no errors from any of that', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('previews, active now, clock times and quiet links');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await pg.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(1500);

  const r = await pg.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    const pres = await import('/js/services/presenceService.js');
    const fm = await import('/js/utils/formatters.js');
    const mr = await import('/js/services/messageRules.js');
    const search = await import('/js/interactions/searchUI.js');
    const now = Date.now();
    const out = {};

    // ---- Clock times: the same shape in every locale ----
    out.clocks = [
      fm.clockTime(new Date(2026, 8, 26, 0, 58).getTime()),
      fm.clockTime(new Date(2026, 8, 26, 12, 5).getTime()),
      fm.clockTime(new Date(2026, 8, 26, 21, 30).getTime())
    ];
    out.inboxClock = fm.formatInboxTime(new Date(2026, 8, 26, 0, 58).getTime(), new Date(2026, 8, 26, 1, 3).getTime());

    // ---- The preview text itself ----
    const ours = (u) => u.includes('livesociya.com/?e=');
    out.previews = [
      mr.previewOf('  see\n you   there ', { isOurEvent: ours }),
      mr.previewOf('https://livesociya.com/?e=abc123', { isOurEvent: ours }),
      mr.previewOf('come!\nhttps://livesociya.com/?e=abc123', { isOurEvent: ours }),
      mr.previewOf('https://example.com/x', { isOurEvent: ours })
    ];
    out.previewCapped = mr.previewOf('x'.repeat(300)).length <= mr.PREVIEW_MAX;

    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u, n) => ({ uid: u, username: u, displayName: n, avatar: '🦊', followers: [], following: [], vouchedBy: [] });
    const ppl = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
    state.userCache = { me: mk('me', 'Me') };
    ppl.forEach((u, i) => { state.userCache[u] = mk(u, 'Person ' + i); window.__stubDocs['users/' + u] = mk(u, 'Person ' + i); });
    state.following = []; state.orbitUids = []; state.eventCache = {}; state.eventOrder = []; state.recapOrder = []; state.recapDone = true;
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('login').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');

    // ---- The search screen's empty hint is centred ----
    search.openSearch();
    await wait(300);
    const hint = document.querySelector('#searchResults .search-hint');
    const hi = hint && hint.querySelector('i');
    if (hi) {
      const a = hi.getBoundingClientRect(), b = hint.getBoundingClientRect();
      out.hintOffset = Math.abs((a.left + a.width / 2) - (b.left + b.width / 2));
    }
    search.closeSearch();
    await wait(300);

    // ---- Presence: somebody fresh, somebody stale, somebody hidden ----
    window.__stubDocs['presence/p1'] = { visible: true, at: { toMillis: () => now - 60e3 } };
    window.__stubDocs['presence/p2'] = { visible: true, at: { toMillis: () => now - 20 * 60e3 } };
    window.__stubDocs['presence/p3'] = { visible: false };
    ppl.forEach((u, i) => {
      const id = ['me', u].sort().join('_');
      window.__stubDocs['chats/' + id] = { userUids: ['me', u].sort(), status: 'unlocked', lastUpdated: now - i * 6e4, unreadByUid: '', initiatedByUid: u };
    });
    // p1's chat has a preview; the newest message was theirs, unread.
    Object.assign(window.__stubDocs['chats/me_p1'], { lastText: 'see you there', lastSenderUid: 'p1', lastMsgId: 'x1', unreadByUid: 'me' });
    Object.assign(window.__stubDocs['chats/me_p2'], { lastText: 'on my way', lastSenderUid: 'me', lastMsgId: 'x2' });
    Object.assign(window.__stubDocs['chats/me_p3'], { lastText: '', lastSenderUid: 'p3', lastMsgId: 'x3' });

    await pres.startPresence();
    out.myBeat = window.__stubDocs['presence/me'] || null;

    window.__readPaths = [];
    window.showTab('chats');
    chat.loadChatList();
    await wait(500);
    const presReads = () => (window.__readPaths || []).filter((p) => p.startsWith('presence/')).length;
    out.presenceReads = presReads();
    const row = (u) => document.querySelector(`#chatList .chat-item[data-uid="${u}"]`);
    const dotOn = (u) => { const d = row(u)?.querySelector('.presence-dot'); return !!d && !d.classList.contains('hidden'); };
    out.dots = { p1: dotOn('p1'), p2: dotOn('p2'), p3: dotOn('p3') };
    out.subs = ['p1', 'p2', 'p3'].map((u) => row(u)?.querySelector('.chat-sub span')?.innerText.trim());
    out.p1Strong = row('p1')?.querySelector('.chat-sub')?.classList.contains('strong');

    // A second look inside the cache window reads nothing.
    window.__readPaths = [];
    chat.loadChatList();
    await wait(300);
    out.rereads = presReads();

    // The header of an open chat says it in words.
    chat.openChat('me_p1', 'p1');
    await wait(300);
    out.headerNow = document.getElementById('chatPresence')?.innerText.trim();
    chat.closeChat({ silent: true });
    chat.openChat('me_p2', 'p2');
    await wait(300);
    out.headerAgo = document.getElementById('chatPresence')?.innerText.trim();
    chat.closeChat({ silent: true });

    // ---- Sending writes the preview in the chat write it already makes ----
    chat.openChat('me_p4', 'p4');
    await wait(300);
    state.currentChatData = { ...window.__stubDocs['chats/me_p4'] };
    state.currentChatLoaded = true;
    const input = document.getElementById('msgInput');
    input.value = 'hello there';
    await window.sendMessage();
    await wait(200);
    const c4 = window.__stubDocs['chats/me_p4'];
    const msgKey = Object.keys(window.__stubDocs).find((k) => k.startsWith('chats/me_p4/messages/') && window.__stubDocs[k].text === 'hello there');
    out.sentPreview = { text: c4.lastText, sender: c4.lastSenderUid, matches: !!msgKey && msgKey.endsWith('/' + c4.lastMsgId) };
    chat.closeChat({ silent: true });

    // ---- Turning it off: nothing stored to read, and nothing shown ----
    await pres.setShowActivity(false);
    out.hiddenDoc = { ...(window.__stubDocs['presence/me'] || {}) };
    window.__readPaths = [];
    window.showTab('chats');
    chat.loadChatList();
    await wait(400);
    out.readsWhileHidden = presReads();
    out.dotsWhileHidden = document.querySelectorAll('#chatList .presence-dot:not(.hidden)').length;
    out.switchOff = !document.getElementById('activitySwitch').classList.contains('on');
    await pres.setShowActivity(true);

    // ---- Quiet links: armed only when the browser needs them ----
    const box = document.getElementById('messages');
    const a = document.createElement('a');
    a.dataset.href = 'https://example.com/x';
    a.textContent = 'x';
    box.appendChild(a);
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    out.hoverHref = a.hasAttribute('href');
    a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    out.rightClickHref = a.getAttribute('href');
    a.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    out.afterLeave = a.hasAttribute('href');
    a.remove();
    return out;
  });

  ok('a clock time never reads 0:58', JSON.stringify(r.clocks) === JSON.stringify(['12:58 am', '12:05 pm', '9:30 pm']), JSON.stringify(r.clocks));
  ok('and neither does the inbox', r.inboxClock === '12:58 am', r.inboxClock);
  ok('a preview is one tidy line', r.previews[0] === 'see you there', r.previews[0]);
  ok('a shared event reads as one, not as a URL',
     r.previews[1] === 'Shared an event' && r.previews[2] === 'come! · shared an event', JSON.stringify(r.previews));
  ok('any other bare link says so', r.previews[3] === 'Shared a link', r.previews[3]);
  ok('and a preview is capped', r.previewCapped);
  ok('the search hint’s icon is centred over its text', typeof r.hintOffset === 'number' && r.hintOffset < 2, String(r.hintOffset));
  ok('opening the app says you are active, stamped by the server',
     !!r.myBeat && r.myBeat.visible === true && !!r.myBeat.at, JSON.stringify(r.myBeat));
  ok('the inbox asks about at most eight people', r.presenceReads > 0 && r.presenceReads <= 8, String(r.presenceReads));
  ok('and looking again inside a few minutes reads nothing', r.rereads === 0, String(r.rereads));
  ok('a green dot for someone active now, and only for them',
     r.dots.p1 === true && r.dots.p2 === false && r.dots.p3 === false, JSON.stringify(r.dots));
  ok('rows show the last message, "You:" for yours, and a deleted one as such',
     JSON.stringify(r.subs) === JSON.stringify(['see you there', 'You: on my way', 'Message deleted']), JSON.stringify(r.subs));
  ok('an unread preview is bold', r.p1Strong === true);
  ok('the chat header says Active now', r.headerNow === 'Active now', r.headerNow);
  ok('or how long ago', r.headerAgo === 'Active 20m ago', r.headerAgo);
  ok('sending writes the preview, from you, pointing at that message',
     r.sentPreview.text === 'hello there' && r.sentPreview.sender === 'me' && r.sentPreview.matches, JSON.stringify(r.sentPreview));
  ok('turning it off stores nothing to read', r.hiddenDoc.visible === false && !('at' in r.hiddenDoc), JSON.stringify(r.hiddenDoc));
  ok('and you stop seeing anybody else’s', r.readsWhileHidden === 0 && r.dotsWhileHidden === 0,
     JSON.stringify({ reads: r.readsWhileHidden, dots: r.dotsWhileHidden }));
  ok('the switch in Settings says off', r.switchOff);
  ok('hovering a link gives the browser no URL to print', r.hoverHref === false);
  ok('right-click still gets the real link', r.rightClickHref === 'https://example.com/x', String(r.rightClickHref));
  ok('and it goes quiet again when the pointer leaves', r.afterLeave === false);
  ok('no errors from any of that', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('the event band reads top to bottom, and the inbox counts');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await pg.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(1500);

  const r = await pg.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    const chat = await import('/js/services/chatService.js');
    const out = {};
    const H = 36e5;

    // ---- Pure: durations and days, the way a person says them ----
    out.durs = [5 * 6e4, 45 * 6e4, 60 * 6e4, 100 * 6e4, 11 * H, 30 * H, 72 * H]
      .map((ms) => ev.durParts(ms).map(([n, u]) => n + u).join(' '));
    const base = new Date(2026, 8, 26, 14, 0).getTime();   // a Saturday, 2 pm
    out.days = [
      ev.dayClock(new Date(2026, 8, 26, 18, 40).getTime(), base),
      ev.dayClock(new Date(2026, 8, 27, 7, 38).getTime(), base),
      ev.dayClock(new Date(2026, 8, 29, 19, 0).getTime(), base),
      ev.dayClock(new Date(2026, 9, 10, 9, 5).getTime(), base)
    ];

    // ---- On a card ----
    const now = Date.now();
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    const mk = (u, n) => ({ uid: u, username: u, displayName: n, avatar: '🦊', followers: [], following: [], vouchedBy: [] });
    state.userCache = { me: mk('me', 'Me'), a: mk('a', 'Riya') };
    state.following = []; state.orbitUids = [];
    const E = (id, start, dur, extra = {}) => Object.assign({ id, hostUid: 'a', title: id, place: 'Lawn', description: '', tag: '☕ Chill',
      startTime: now + start, expiresAt: now + start + dur, participantUids: ['a'], hypedUids: [], pendingUids: [], unconfirmedUids: [],
      requiresApproval: false, maxCapacity: null, circleId: 'main' }, extra);
    const evs = [E('soon', 45 * 6e4 + 20e3, 2 * H), E('live', -10 * 6e4, 100 * 6e4 + 20e3), E('capped', 3 * H, H, { maxCapacity: 6, participantUids: ['a', 'me'] })];
    state.eventCache = {}; evs.forEach((e) => { state.eventCache[e.id] = e; });
    state.eventOrder = evs.map((e) => e.id); state.recapOrder = []; state.recapDone = true; state.currentLiveFilter = 'All';
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('login').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');
    ev.renderEvents();
    await wait(300);
    const stat = (id, i = 0) => {
      const st = document.querySelectorAll(`#event-${id} .poster-stat`)[i];
      if (!st) return null;
      const q = (c) => st.querySelector(c);
      const lr = q('.poster-label').getBoundingClientRect(), vr = q('.poster-value').getBoundingClientRect();
      const sr = q('.poster-sub') ? q('.poster-sub').getBoundingClientRect() : null;
      return {
        label: q('.poster-label').innerText.trim(), value: q('.poster-value').innerText.trim(),
        sub: q('.poster-sub') ? q('.poster-sub').innerText.trim() : '',
        stacked: lr.bottom <= vr.top + 1 && (!sr || vr.bottom <= sr.top + 1)
      };
    };
    out.soon = stat('soon');
    out.live = stat('live');
    out.capped = stat('capped', 1);

    // A minute past its start, the SAME card says it is on — the label
    // is volatile too now, not frozen in the markup at "Starts in".
    const realNow = Date.now;
    Date.now = () => realNow() + 47 * 6e4;
    ev.renderEvents();
    await wait(200);
    out.flipped = stat('soon');
    Date.now = realNow;
    ev.renderEvents();

    // ---- The inbox: counts, and paging ----
    const t = Date.now();
    for (let i = 0; i < 25; i++) {
      const u = 'u' + String(i).padStart(2, '0');
      state.userCache[u] = mk(u, 'Person ' + i);
      window.__stubDocs['users/' + u] = mk(u, 'Person ' + i);
      window.__stubDocs['chats/me_' + u] = { userUids: ['me', u], status: 'unlocked', lastUpdated: t - i * 6e4, unreadByUid: '', initiatedByUid: u, lastText: 'hi ' + i, lastSenderUid: u, lastMsgId: 'm' + i };
    }
    Object.assign(window.__stubDocs['chats/me_u00'], { unreadByUid: 'me', unreadCount: 6 });
    Object.assign(window.__stubDocs['chats/me_u01'], { unreadByUid: 'me', unreadCount: 2 });
    Object.assign(window.__stubDocs['chats/me_u02'], { unreadByUid: 'me', unreadCount: 1 });
    window.showTab('chats');
    chat.loadChatList();
    await wait(500);
    const rows = () => [...document.querySelectorAll('#chatList .chat-item')];
    const sub = (u) => document.querySelector(`#chatList .chat-item[data-uid="${u}"] .chat-sub span`)?.innerText.trim();
    const badge = (u) => document.querySelector(`#chatList .chat-item[data-uid="${u}"] .unread-count`)?.innerText.trim();
    out.counts = { six: sub('u00'), two: sub('u01'), one: sub('u02'), sixBadge: badge('u00') };
    out.firstPage = rows().length;
    out.hasMore = !!document.getElementById('inboxMore');
    window.__readPaths = [];
    const readsBefore = window.__reads;
    document.getElementById('inboxMore').click();
    await wait(400);
    out.afterMore = rows().length;
    out.moreGone = !document.getElementById('inboxMore');
    out.olderReads = window.__reads - readsBefore;
    out.noDupes = new Set(rows().map((x) => x.getAttribute('data-uid'))).size === rows().length;

    // ---- Sending counts up while they haven't read it ----
    await chat.sendDirectText('u10', 'one');
    await chat.sendDirectText('u10', 'two');
    await chat.sendDirectText('u10', 'three');
    out.sentCount = window.__stubDocs['chats/me_u10'].unreadCount;
    out.sentWaiting = window.__stubDocs['chats/me_u10'].unreadByUid;
    return out;
  });

  ok('durations are said in words', JSON.stringify(r.durs) === JSON.stringify(['5min', '45min', '1hr', '1h 40m', '11hrs', '1day', '3days']), JSON.stringify(r.durs));
  ok('and when is a day and a time', JSON.stringify(r.days) === JSON.stringify(['at 6:40 pm', 'tomorrow 7:38 am', 'Tue 7:00 pm', '10 Oct, 9:05 am']), JSON.stringify(r.days));
  ok('an upcoming band reads "Starts in / 45 min / at …"',
     !!r.soon && /starts in/i.test(r.soon.label) && /^45\s?min$/i.test(r.soon.value) && /^at \d{1,2}:\d\d [ap]m$/i.test(r.soon.sub),
     JSON.stringify(r.soon));
  ok('label, number and detail are stacked, not side by side', r.soon?.stacked && r.live?.stacked, JSON.stringify([r.soon, r.live]));
  ok('a live band says how long is left and until when',
     !!r.live && /happening now/i.test(r.live.label) && /^1\s?h\s?30\s?m$/i.test(r.live.value) && /^left · till \d{1,2}:\d\d [ap]m$/i.test(r.live.sub),
     JSON.stringify(r.live));
  ok('a capped event shows going out of how many', r.capped && /^2\s?\/6$/.test(r.capped.value), JSON.stringify(r.capped));
  ok('when it starts, the same card says it is on', /happening now/i.test(r.flipped?.label || ''), JSON.stringify(r.flipped));
  ok('several waiting say how many: "4+ new messages"', r.counts.six === '4+ new messages' && r.counts.sixBadge === '6', JSON.stringify(r.counts));
  ok('two say "2 new messages", one shows the message', r.counts.two === '2 new messages' && r.counts.one === 'hi 2', JSON.stringify(r.counts));
  ok('the live inbox is twenty conversations', r.firstPage === 20 && r.hasMore, JSON.stringify({ n: r.firstPage, more: r.hasMore }));
  ok('older ones are a button away, read once, no duplicates',
     r.afterMore === 25 && r.moreGone && r.noDupes && r.olderReads <= 5, JSON.stringify({ n: r.afterMore, gone: r.moreGone, reads: r.olderReads }));
  ok('sending counts up while they have not read it', r.sentCount === 3 && r.sentWaiting === 'u10', JSON.stringify({ c: r.sentCount, w: r.sentWaiting }));
  ok('no errors from any of that', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('one file for the browser, a phone on its side, and Send');
{
  // The browser gets one file. It must be built from the js/ that is
  // here now, or a change would test green and ship stale.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  let fresh = false, why = '';
  try {
    const { build } = await import('esbuild');
    const { OPTIONS } = await import(new URL('../build.mjs', import.meta.url).href);
    const out = await build({ ...OPTIONS, absWorkingDir: root, write: false });
    const js = out.outputFiles.find((f) => f.path.endsWith('app.js'));
    fresh = js && js.text === readFileSync(join(root, 'dist/app.js'), 'utf8');
    if (!fresh) why = 'dist/app.js is older than js/ — run npm run build';
  } catch (e) { why = 'could not rebuild: ' + e.message.slice(0, 120); }
  ok('dist/app.js is built from the current js/', fresh, why);
  ok('index.html loads the bundle, and preloads it',
     /<script type="module" src="dist\/app\.js"><\/script>/.test(html) && /rel="modulepreload" href="dist\/app\.js"/.test(html));
  ok('the Firebase SDK does not block the first paint',
     [...html.matchAll(/<script[^>]*firebasejs[^>]*>/g)].every((m) => /\sdefer\b/.test(m[0])));

  // And the real bundle, not the source, actually starts.
  {
    const ctx = await rawNewContext({ serviceWorkers: 'block' });
    const real = await ctx.newPage();
    const errs = [];
    real.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
    await real.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
    await real.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await real.waitForTimeout(1800);
    const r = await real.evaluate(() => ({
      booted: !!window.__livesociyaBooted,
      scripts: performance.getEntriesByType('resource').filter((e) => /\/(js|dist)\//.test(e.name)).map((e) => new URL(e.name).pathname)
    }));
    ok('the bundle boots on its own', r.booted && errs.length === 0, errs.join(' | '));
    ok('and it is the only app script the browser fetches', r.scripts.length === 1 && r.scripts[0] === '/dist/app.js', r.scripts.join(', '));
    await ctx.close();
  }

  const boot = await page.evaluate(() => ({
    booted: !!window.__livesociyaBooted,
    error: document.getElementById('boot-error').classList.contains('hidden'),
    slow: document.getElementById('boot-slow').classList.contains('hidden')
  }));
  ok('a booted app shows no boot warning', boot.booted && boot.error && boot.slow, JSON.stringify(boot));

  const send = await page.evaluate(() => {
    const btn = document.getElementById('sendBtn');
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    return { kept: ev.defaultPrevented, drawn: !!btn.querySelector('svg'), type: btn.type };
  });
  const blankIcons = await page.evaluate(() => [...document.querySelectorAll('.back-btn, .icon-btn, .fab, .brand-dot, .login-mark')]
    .filter((el) => !el.querySelector('svg') && !(el.tagName === 'IMG' && /\.svg$/.test(el.getAttribute('src') || '')))
    .map((el) => el.className + (el.getAttribute('onclick') ? ' ' + el.getAttribute('onclick') : '')));
  ok('every icon-only button is drawn, not a font glyph', blankIcons.length === 0, blankIcons.join(' | '));
  ok('Send never takes focus from the field', send.kept, JSON.stringify(send));

  const titles = await page.evaluate(async () => {
    const ui = await import('/js/utils/ui.js');
    const out = {};
    window.switchScreen('home'); ui.showTab('recap'); out.recap = document.title;
    ui.showTab('events'); out.live = document.title;
    ui.setTitleUnread(true); out.unread = document.title;
    ui.showTab('chats'); out.unreadStays = document.title;
    ui.setTitleUnread(false); ui.showTab('events');
    return out;
  });
  ok('the tab says livesociya on every screen', titles.recap === 'livesociya' && titles.live === 'livesociya', JSON.stringify(titles));
  ok('and an unread message survives a tab change', titles.unread === '(1) livesociya' && titles.unreadStays === '(1) livesociya', JSON.stringify(titles));
  ok('and its icon is drawn, not a font glyph', send.drawn && send.type === 'button', JSON.stringify(send));

  const turn = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = document.documentElement;
    const cover = document.querySelector('.rotate-cover');
    const out = { hiddenUpright: getComputedStyle(cover).display === 'none' };
    root.classList.add('rotate-lock'); await wait(50);
    out.coverShown = getComputedStyle(cover).display !== 'none' && getComputedStyle(cover).visibility === 'visible';
    out.appHidden = [...document.body.children].filter((el) => el !== cover && el.tagName !== 'SCRIPT')
      .every((el) => getComputedStyle(el).visibility === 'hidden');
    root.classList.remove('rotate-lock'); await wait(50);
    out.back = getComputedStyle(cover).display === 'none';
    return out;
  });
  ok('upright, the rotate cover is not there', turn.hiddenUpright, JSON.stringify(turn));
  ok('sideways, the cover is all that paints', turn.coverShown && turn.appHidden, JSON.stringify(turn));
  ok('and turning back puts the app back', turn.back, JSON.stringify(turn));
}

/* ------------------------------------------------------------------ */
group('photos, the event page and the location');
{
  // Photos are BUILT BUT OFF until the Blaze plan (js/config/features.js).
  // Off must mean nobody can tell: no picker, no tray, no slot.
  const U = (host, n) => 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/events%2F'
    + host + '%2FPhotoNumber' + n + 'xxxxxxxx.jpg?alt=media&token=t-' + n;
  const longPlace = 'Nescafe, back lawn, behind the old library, next to the cycle stand by gate three';
  const withPhotos = Object.assign(mkEvent('p1', 'a', 'Sunset jam', '\u{1F3A7} Music'),
    { photos: [U('a', 1), U('a', 2), U('a', 3)], place: longPlace, description: 'Bring a mat.\nWe start at the steps.' });
  // Someone pasting a URL of their own into `photos` gets nothing drawn.
  const foreign = Object.assign(mkEvent('p2', 'b', 'Not a cover', '\u{1F4DA} Study'),
    { photos: ['https://example.com/tracker.jpg', U('a', 9)] });
  const plain = mkEvent('p3', 'me', 'Mine, no photos', '☕ Chill');
  await seed({ p1: withPhotos, p2: foreign, p3: plain });
  await page.waitForTimeout(400);

  const off = await page.evaluate(async () => {
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
    window.openCreateScreen();
    await new Promise((r) => setTimeout(r, 200));
    const out = {
      tray: shown(document.getElementById('createPhotos')),
      slot: shown(document.getElementById('settingsPhotoSlot')),
      bodyFlag: document.body.classList.contains('photos-on')
    };
    window.closeCreateScreen();
    await new Promise((r) => setTimeout(r, 200));
    return out;
  });
  ok('while photos are off, the create sheet has no photo tray', off.tray === false, JSON.stringify(off));
  ok('and settings has no photo slot', off.slot === false && off.bodyFlag === false);

  const feed = await page.evaluate(() => {
    const card = document.getElementById('event-p1');
    const cover = card?.querySelector('.event-cover');
    const img = cover?.querySelector('img');
    const kids = [...(card?.children || [])].map((k) => k.className.split(' ')[0]);
    const r = cover?.getBoundingClientRect();
    return {
      cover: !!cover, src: img?.getAttribute('src'), count: cover?.querySelector('.cover-count')?.innerText,
      order: kids.slice(0, 3).join(','),
      ratio: r ? +(r.width / r.height).toFixed(2) : 0,
      foreign: !!document.querySelector('#event-p2 .event-cover'),
      plain: !!document.querySelector('#event-p3 .event-cover')
    };
  });
  ok('a card with photos shows its first as the cover', feed.cover && feed.src && feed.src.indexOf('PhotoNumber1') > 0, JSON.stringify(feed));
  ok('under the band and above the title, so the band keeps the top', feed.order === 'poster,event-cover,card-body', feed.order);
  ok('at 16:9 on a phone, whatever shape the photo is', Math.abs(feed.ratio - 16 / 9) < 0.05, String(feed.ratio));
  ok('and says there are more', feed.count === '1/3', feed.count);
  ok('a photo that is not the host\'s own upload is never drawn', feed.foreign === false);
  ok('and a card with no photos is the card it always was', feed.plain === false);

  const pg = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#event-p1 .event-title').click();
    await wait(400);
    const screen = document.getElementById('eventScreen');
    const place = screen.querySelector('.ep-fact span');
    const firstImg = screen.querySelector('.ep-photo');
    const out = {
      open: !screen.classList.contains('hidden'),
      photos: screen.querySelectorAll('.ep-photo').length,
      order: [...screen.querySelectorAll('.ep > .ep-photos, .ep-title, .ep-more')]
        .map((n) => n.classList.contains('ep-more') ? 'more' : n.classList.contains('ep-title') ? 'title' : 'photo').join(','),
      placeWhole: place?.innerText,
      placeWraps: place ? place.getBoundingClientRect().height > 20 : false,
      desc: screen.querySelector('.ep-desc')?.innerText,
      actions: !!screen.querySelector('.card-actions .act.primary'),
      report: !!screen.querySelector('.ep-report'),
      timeFilled: !!screen.querySelector('[data-vt="value"]')?.textContent.trim()
    };
    // The minute tick repaints the feed, and the page with it — but must
    // not throw its photos away and load them again.
    window.__m.ev.renderEvents();
    await wait(50);
    out.sameImg = screen.querySelector('.ep-photo') === firstImg;
    // Somebody joins while it is open: the page follows.
    window.__m.state.eventCache.p1.participantUids = ['a', 'b'];
    window.__m.ev.renderEvents();
    await wait(50);
    out.follows = /B|1/.test(screen.querySelector('.going-text')?.innerText || '');

    // Report from the page: a report about THIS EVENT, not just its host.
    window.__adds = []; Object.keys(window.__stubDocs).filter((k) => k.startsWith('reports/')).forEach((k) => delete window.__stubDocs[k]);
    screen.querySelector('.ep-report').click();
    await wait(300);
    const modal = document.getElementById('reportModal');
    out.reportAbout = document.getElementById('reportWho')?.innerText;
    out.reportOpen = !modal.classList.contains('hidden');
    // Not awaited: after sending it asks whether to block them too.
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); window.sendReport();
    await wait(400);
    const rep = (() => { const d = Object.entries(window.__stubDocs).find(([k]) => k.startsWith('reports/')); return d ? { data: d[1] } : null; })();
    out.filed = rep ? [rep.data.targetUid, rep.data.targetType, rep.data.targetId].join('|') : '';
    window.confirmNo?.();
    await wait(300);
    window.closeEventPage();
    await wait(300);
    out.closed = screen.classList.contains('hidden');

    // Your own event: no Report, and no photos section at all.
    window.openEventPage('p3');
    await wait(300);
    out.ownReport = !!screen.querySelector('.ep-report');
    out.ownPhotos = !!screen.querySelector('.ep-photos');
    window.closeEventPage();
    await wait(300);
    return out;
  });
  ok('tapping a card\'s title opens the event page', pg.open, JSON.stringify(pg));
  ok('with every photo on it', pg.photos === 3, String(pg.photos));
  ok('the cover first, the rest after the details', pg.order === 'photo,title,more', pg.order);
  ok('the whole place, wrapping rather than cut', pg.placeWhole === longPlace && pg.placeWraps);
  ok('and the whole note, line breaks kept', pg.desc === 'Bring a mat.\nWe start at the steps.', JSON.stringify(pg.desc));
  ok('the same actions as the card', pg.actions === true);
  ok('and its time filled in like the card\'s', pg.timeFilled === true);
  ok('the minute tick does not reload its photos', pg.sameImg === true);
  ok('and it follows the event while open', pg.follows === true);
  ok('Report on the page is about this event', pg.reportOpen && pg.reportAbout === 'this event', pg.reportAbout);
  ok('and is filed as the event, against its host', pg.filed === 'a|event|p1', pg.filed);
  ok('the page closes', pg.closed === true);
  ok('your own event has no Report and no empty photo section', pg.ownReport === false && pg.ownPhotos === false);

  // THE LOCATION used to take any length and lose the end on save.
  const place = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.openCreateScreen();
    await wait(200);
    const el = document.getElementById('place');
    const count = document.getElementById('placeCount');
    el.value = 'Lawn'; el.dispatchEvent(new Event('input'));
    const quiet = count.classList.contains('hidden');
    el.value = 'x'.repeat(72); el.dispatchEvent(new Event('input'));
    const out = { max: el.maxLength, title: document.getElementById('title').maxLength,
                  quiet, shows: !count.classList.contains('hidden'), text: count.innerText };
    window.closeCreateScreen();
    await wait(200);
    return out;
  });
  ok('the location box stops at 80, the same as the rules', place.max === 80 && place.title === 80, JSON.stringify(place));
  ok('with a count that appears only near the limit', place.quiet && place.shows && place.text === '72/80');

  // ON: the whole path, with a real file through the real picker —
  // compressed on the device, uploaded, and put on the event AFTER it
  // has published.
  await page.evaluate(async () => {
    const f = await import('/js/config/features.js');
    f.features.photos = true;
    f.applyFeatureFlags();
    window.__uploads = []; window.__storageDeletes = []; window.__updates = [];
  });
  // A real 3000x2000 PNG, drawn in the page, as the file a phone hands over.
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const x = c.getContext('2d'); x.fillStyle = '#c84'; x.fillRect(0, 0, 3000, 2000);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await b.arrayBuffer())];
  }));
  await page.evaluate(() => window.openCreateScreen());
  await page.waitForTimeout(250);
  const trayShown = await page.evaluate(() => getComputedStyle(document.getElementById('createPhotos')).display !== 'none');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => document.querySelector('#createPhotos .tray-add').click())
  ]);
  await chooser.setFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(250);
  const on = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { isOurPhotoUrl } = await import('/js/services/photoRules.js');
    const out = {
      tiles: document.querySelectorAll('#createPhotos .tray-tile').length,
      coverTag: !!document.querySelector('#createPhotos .tray-cover'),
      counter: document.getElementById('photoCount').innerText
    };
    document.getElementById('title').value = 'With a photo';
    document.getElementById('place').value = 'Steps';
    window.__lastBatch = null;
    await window.__m.ev.addEvent();
    const ev = (window.__lastBatch || []).find((o) => String(o.path).indexOf('events/') === 0);
    out.publishedWithoutPhotos = !!ev && !('photos' in ev.data);
    // The upload runs behind the publish.
    for (let i = 0; i < 40 && !(window.__updates || []).some((u) => u.keys.includes('photos')); i++) await wait(100);
    const up = window.__uploads[0] || {};
    const upd = (window.__updates || []).find((u) => u.keys.includes('photos'));
    out.uploads = window.__uploads.length;
    out.jpeg = up.type === 'image/jpeg';
    out.small = up.size > 0 && up.size < 400 * 1024;
    out.mine = /^events\/me\/[A-Za-z0-9_-]{20}\.jpg$/.test(up.path || '');
    out.sameEvent = !!upd && !!ev && upd.path === ev.path;
    out.urlOk = !!upd && upd.patch.photos.length === 1 && isOurPhotoUrl(upd.patch.photos[0], 'events', 'me');
    return out;
  });
  ok('switched on, the tray is there', trayShown === true);
  ok('a picked photo lands in it, marked as the cover', on.tiles === 1 && on.coverTag && on.counter === '1/4', JSON.stringify(on));
  ok('publishing does not wait for it', on.publishedWithoutPhotos === true);
  ok('it is uploaded once, as a JPEG, into your own folder', on.uploads === 1 && on.jpeg && on.mine, JSON.stringify(on));
  ok('squeezed on the device from a 3000px original', on.small === true);
  ok('and put on the event it belongs to, as a URL the rules accept', on.sameEvent && on.urlOk);

  // Settings: your own photo as your profile picture.
  await page.evaluate(() => { window.__uploads = []; window.openSettingsScreen(); });
  await page.waitForTimeout(300);
  const [chooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => document.getElementById('settingsPhotoSlot').click())
  ]);
  await chooser2.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
  const pfp = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && !window.__uploads.length; i++) await wait(100);
    await wait(150);
    const { state } = window.__m;
    const up = window.__uploads[0] || {};
    const slot = document.getElementById('settingsPhotoSlot');
    const out = {
      path: up.path, square: false,
      pending: String(state.pendingSettingsAvatar || '').indexOf('avatars%2Fme%2F') > 0,
      selected: slot.classList.contains('selected') && !!slot.querySelector('img')
    };
    // Picking an emoji afterwards and saving deletes the unused upload.
    window.__storageDeletes = [];
    const fox = [...document.querySelectorAll('#settingsAvatarGrid .avatar-option')].find((e) => e.innerText === '\u{1F98A}');
    window.selectSettingsAvatar(fox, '\u{1F98A}');
    await window.saveProfileData();
    await wait(1100);
    out.saved = state.userAvatar === '\u{1F98A}';
    out.cleaned = window.__storageDeletes.some((p) => p === up.path);
    return out;
  });
  ok('a profile photo uploads into avatars/<your uid>/', /^avatars\/me\/[A-Za-z0-9_-]{20}\.jpg$/.test(pfp.path || ''), JSON.stringify(pfp));
  ok('and is picked, ready for Save', pfp.pending && pfp.selected);
  ok('choosing something else instead deletes the upload nobody kept', pfp.saved && pfp.cleaned);

  // Off again for everything after this.
  await page.evaluate(async () => {
    const f = await import('/js/config/features.js');
    f.features.photos = false;
    f.applyFeatureFlags();
  });

  // The pure rules the database mirrors.
  const pure = await page.evaluate(async () => {
    const r = await import('/js/services/photoRules.js');
    const u = 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/events%2Fabc%2FAbCdEfGhIj0123456789.jpg?alt=media&token=12ab-cd';
    return {
      ok: r.isOurPhotoUrl(u, 'events', 'abc'),
      otherOwner: r.isOurPhotoUrl(u, 'events', 'xyz'),
      otherFolder: r.isOurPhotoUrl(u, 'avatars', 'abc'),
      otherProject: r.isOurPhotoUrl(u.replace('livesociyaweb', 'someoneelse'), 'events', 'abc'),
      mumbai: r.isOurPhotoUrl(u.replace('livesociyaweb.firebasestorage.app', 'livesociyaweb-mumbai'), 'events', 'abc'),
      path: r.pathOfUrl(u),
      fit: JSON.stringify(r.fitWithin(4032, 3024, 1600)),
      noUpscale: JSON.stringify(r.fitWithin(800, 600, 1600))
    };
  });
  ok('a photo URL is ours only for its owner, folder and project',
     pure.ok && !pure.otherOwner && !pure.otherFolder && !pure.otherProject, JSON.stringify(pure));
  ok('and a second bucket of this project is fine, so moving to Mumbai later is config', pure.mumbai === true);
  ok('its storage path can be read back for a delete', pure.path === 'events/abc/AbCdEfGhIj0123456789.jpg');
  ok('a phone photo is scaled to 1600 on its long edge, never up', pure.fit === '{"w":1600,"h":1200}' && pure.noUpscale === '{"w":800,"h":600}');
}

/* ------------------------------------------------------------------ */
group('chat photos, memories, stories and reports');
{
  const SU = (folder, host, n) => 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/'
    + folder + '%2F' + host + '%2FPhotoNumber' + n + 'xxxxxxxx.jpg?alt=media&token=t-' + n;
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
    const x = c.getContext('2d'); x.fillStyle = '#6a9'; x.fillRect(0, 0, 1200, 900);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await b.arrayBuffer())];
  }));
  const pick = async (trigger) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(trigger)]);
    await chooser.setFiles({ name: 'p.png', mimeType: 'image/png', buffer: png });
  };
  const flag = (on) => page.evaluate(async (on) => {
    const f = await import('/js/config/features.js');
    f.features.photos = on; f.applyFeatureFlags();
  }, on);

  // ---- CHAT ----
  const ended = Object.assign(mkEvent('m1', 'a', 'Rooftop jam', '\u{1F3A7} Music'),
    { startTime: now - 5 * 36e5, expiresAt: now - 36e5, participantUids: ['a', 'b', 'me'],
      photos: [SU('events', 'a', 1)] });
  const live = mkEvent('m2', 'b', 'Still on', '☕ Chill');
  await seed({ m1: ended, m2: live });

  const chatOff = await page.evaluate(async () => {
    const { state } = window.__m;
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    state.currentChat = 'a_me'; state.currentChatType = 'direct'; state.currentChatStatus = 'unlocked';
    state.currentChatInitiatorUid = ''; state.currentChatData = { unreadByUid: '', typingUid: '' };
    state.currentChatLoaded = true; state.currentOtherUid = 'a';
    window.switchScreen('chatScreen');
    window.__docs = [];
    chat.loadMessages();
    await wait(150);
    return { btn: getComputedStyle(document.getElementById('photoBtn')).display };
  });
  ok('while photos are off, the composer has no photo button', chatOff.btn === 'none', chatOff.btn);

  await flag(true);
  await page.evaluate(() => { window.__uploads = []; document.getElementById('msgInput').value = 'look at this'; });
  await pick(() => document.getElementById('photoBtn').click());
  const chatOn = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && !Object.keys(window.__stubDocs).some((k) => k.startsWith('chats/a_me/messages/')); i++) await wait(100);
    const key = Object.keys(window.__stubDocs).find((k) => k.startsWith('chats/a_me/messages/'));
    const msg = key ? window.__stubDocs[key] : {};
    const chatDoc = window.__stubDocs['chats/a_me'] || {};
    return {
      upload: (window.__uploads[0] || {}).path || '',
      photo: msg.photo || '', caption: msg.text,
      preview: chatDoc.lastText || '',
      box: document.getElementById('msgInput').value
    };
  });
  ok('a photo in a thread uploads into chats/<your uid>/', /^chats\/me\/[A-Za-z0-9_-]{20}\.jpg$/.test(chatOn.upload), JSON.stringify(chatOn));
  ok('and is sent with what was typed as its caption', chatOn.photo.indexOf('chats%2Fme%2F') > 0 && chatOn.caption === 'look at this' && chatOn.box === '');
  ok('the inbox says it was a photo', chatOn.preview === '\u{1F4F7} look at this', chatOn.preview);

  const shown = await page.evaluate(async ({ mine, foreign }) => {
    const { state } = window.__m;
    const chat = await import('/js/services/chatService.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = Date.now();
    window.__docs = [
      { id: 'q1', data: () => ({ senderUid: 'a', text: '', photo: foreign, time: t - 3000 }) },
      { id: 'q2', data: () => ({ senderUid: 'me', text: '', photo: mine, time: t - 2000 }) }
    ];
    chat.loadMessages();
    await wait(200);
    const q2 = document.getElementById('msg-q2');
    const out = {
      stolen: !!document.querySelector('#msg-q1 .msg-photo'),
      drawn: !!(q2 && q2.querySelector('.msg-photo')),
      bare: !!(q2 && q2.querySelector('.msg-bubble.photo-only'))
    };
    q2.querySelector('.msg-photo').click();
    await wait(150);
    out.viewer = !document.getElementById('photoViewer').classList.contains('hidden');
    window.closePhotoViewer();
    await wait(150);
    // A stranger's thread: no photo, even with the button there.
    state.currentChatStatus = 'icebreaker'; state.currentChatMutual = false;
    const before = window.__uploads.length;
    await chat.sendChatPhoto();
    out.lockedNoUpload = window.__uploads.length === before;
    state.currentChatStatus = 'unlocked';
    // Taking a photo back takes the photo too.
    window.__storageDeletes = []; window.__updates = [];
    chat.openMessageActions('q2');
    await wait(80);
    document.querySelector('#msgActionList .action-row[data-act="delete"]').click();
    await wait(250);
    window.confirmYes();
    await wait(300);
    const upd = (window.__updates || []).find((u) => /messages\/q2$/.test(u.path));
    out.photoCleared = !!upd && upd.keys.includes('photo') && !!upd.patch.photo && upd.patch.photo.__op === 'delete';
    out.fileGone = window.__storageDeletes.some((p) => p.startsWith('chats/me/'));
    chat.closeChat({ silent: true });
    await wait(150);
    return out;
  }, { mine: SU('chats', 'me', 7), foreign: SU('chats', 'b', 8) });
  ok('a photo is drawn in its bubble, with no bubble round it when it has no caption', shown.drawn && shown.bare, JSON.stringify(shown));
  ok('a photo that is not the sender\'s own upload is never drawn', shown.stolen === false);
  ok('tapping it opens it whole', shown.viewer === true);
  ok('no photo goes into a thread still waiting on its first reply', shown.lockedNoUpload === true);
  ok('taking a photo back removes it from the message and from storage', shown.photoCleared && shown.fileGone);

  // ---- MEMORIES ----
  await page.evaluate(() => {
    const t = Date.now();
    window.__stubDocs['events/m1/memories/a_0'] = { uid: 'a', photo: 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/memories%2Fa%2FPhotoNumber1xxxxxxxx.jpg?alt=media&token=t-1', createdAt: t - 5000 };
    window.__stubDocs['events/m1/memories/b_0'] = { uid: 'b', photo: 'https://example.com/not-ours.jpg', createdAt: t - 4000 };
    window.__stubDocs['events/m1/social/likes'] = { uids: ['a', 'b'] };
    window.__stubDocs['events/m1/comments/c1'] = { uid: 'b', text: 'best night of the sem', createdAt: t - 3000 };
    window.__stubDocs['events/m1/comments/c2'] = { uid: 'a', text: 'we go again friday', createdAt: t - 2000 };
  });
  const mem = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.openEventPage('m1');
    await wait(500);
    const screen = document.getElementById('eventScreen');
    const likeSpan = () => screen.querySelector('.mem-like span');
    const out = {
      section: !!screen.querySelector('.mem'),
      tiles: screen.querySelectorAll('.mem-tile').length,
      add: !!screen.querySelector('.mem-add'),
      likeText: likeSpan() && likeSpan().innerText,
      comments: screen.querySelectorAll('.cmt').length,
      compose: !document.getElementById('epCompose').classList.contains('hidden')
    };
    // Like: straight away, then written.
    window.__writes = 0;
    screen.querySelector('.mem-like').click();
    await wait(80);
    out.liked = screen.querySelector('.mem-like').classList.contains('on') && likeSpan().innerText === '3';
    out.likeWrote = window.__writes > 0;
    // Comment.
    document.getElementById('epCommentInput').value = 'I was there!';
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); window.postEventComment();
    await wait(200);
    out.commented = [...screen.querySelectorAll('.cmt-text')].some((n) => n.innerText === 'I was there!');
    const saved = Object.entries(window.__stubDocs).find(([k, v]) => k.startsWith('events/m1/comments/') && v.text === 'I was there!');
    out.commentSaved = !!saved && saved[1].uid === 'me';
    out.cleared = document.getElementById('epCommentInput').value === '';
    // Report somebody's comment: gone from YOUR screen at once.
    window.__adds = []; Object.keys(window.__stubDocs).filter((k) => k.startsWith('reports/')).forEach((k) => delete window.__stubDocs[k]);
    const row = [...screen.querySelectorAll('.cmt')].find((n) => n.innerText.includes('best night'));
    const btns = row ? [...row.querySelectorAll('.cmt-acts .mem-link')] : [];
    btns.find((b) => b.innerText === 'Report').click();
    await wait(250);
    out.reportWho = document.getElementById('reportWho').innerText;
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); window.sendReport();
    await wait(400);
    if (window.confirmNo) window.confirmNo();
    await wait(250);
    const r = (() => { const d = Object.entries(window.__stubDocs).find(([k]) => k.startsWith('reports/')); return d ? { data: d[1] } : null; })();
    out.reportFiled = r ? [r.data.targetType, r.data.targetId, r.data.excerpt].join('|') : '';
    out.hiddenAfter = ![...screen.querySelectorAll('.cmt-text')].some((n) => n.innerText === 'best night of the sem');
    window.__uploads = [];
    return out;
  });
  ok('a finished event\'s page has its memories', mem.section, JSON.stringify(mem));
  ok('with only real memory photos drawn', mem.tiles === 1);
  ok('a place for yours, because you went', mem.add === true);
  ok('its likes and its comments', mem.likeText === '2' && mem.comments === 2);
  ok('and a comment box under it', mem.compose === true);
  ok('a like shows at once and is written', mem.liked && mem.likeWrote);
  ok('a comment shows at once, is saved as yours, and clears the box', mem.commented && mem.commentSaved && mem.cleared);
  ok('reporting a comment files it with a copy of what it said', mem.reportWho === 'this comment' && mem.reportFiled === 'comment|m1_c1|best night of the sem', mem.reportFiled);
  ok('and it is gone from your screen straight away', mem.hiddenAfter === true);

  await pick(() => document.querySelector('#eventScreen .mem-add').click());
  const memAdd = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && !window.__stubDocs['events/m1/memories/me_0']; i++) await wait(100);
    await wait(150);
    const d = window.__stubDocs['events/m1/memories/me_0'] || {};
    const out = {
      upload: (window.__uploads[0] || {}).path || '',
      doc: d.uid === 'me' && String(d.photo).indexOf('memories%2Fme%2F') > 0,
      tiles: document.querySelectorAll('#eventScreen .mem-tile').length
    };
    window.closeEventPage();
    await wait(250);
    // A live event has no memories and no comment box.
    window.openEventPage('m2');
    await wait(250);
    out.liveMem = !!document.querySelector('#eventScreen .mem');
    out.liveCompose = !document.getElementById('epCompose').classList.contains('hidden');
    window.closeEventPage();
    await wait(250);
    return out;
  });
  ok('adding a memory uploads into memories/<you>/ as <you>_0', /^memories\/me\//.test(memAdd.upload) && memAdd.doc, JSON.stringify(memAdd));
  ok('and it joins the grid', memAdd.tiles === 2);
  ok('a live event has no memories and no comment box yet', memAdd.liveMem === false && memAdd.liveCompose === false);

  // ---- LIKE AND COMMENT WITHOUT OPENING ANYTHING ----
  const quick = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state, ui, ev } = window.__m;
    // A fresh finished event nobody has opened, sitting in Recap.
    const t = Date.now();
    state.eventCache.m3 = Object.assign({}, state.eventCache.m1, { id: 'm3', title: 'Chai at the gate', photos: [], expiresAt: t - 30 * 60000 });
    window.__stubDocs['events/m3/social/likes'] = { uids: ['a'], comments: 4 };
    state.recapOrder = ['m3'];
    state.currentRecapFilter = 'All';
    // Back on the feed the way seed() gets there (the thread above was
    // closed silently, which leaves its screen up).
    history.pushState({ screen: 'home' }, '', location.href);
    window.switchScreen('home');
    ui.showTab('recap');
    ev.renderEvents();
    await wait(100);
    // The bar asks for its one read only once it is on screen.
    const cardEl = document.getElementById('event-m3');
    const before = cardEl && cardEl.querySelector('.soc-btn').innerText.trim();
    if (cardEl) cardEl.scrollIntoView({ block: 'center' });
    await wait(400);
    const card = document.getElementById('event-m3');
    const bar = card && card.querySelector('.soc-bar');
    const btns = bar ? [...bar.querySelectorAll('.soc-btn')] : [];
    const out = {
      before,
      bar: btns.length,
      likeText: btns[0] && btns[0].innerText.trim(),
      commentText: btns[1] && btns[1].innerText.trim()
    };
    // Like it right there.
    window.__lastBatch = null; window.__writes = 0;
    btns[0].click();
    await wait(120);
    const b2 = [...document.querySelectorAll('#event-m3 .soc-btn')];
    out.likedInPlace = b2[0].classList.contains('on') && b2[0].innerText.trim() === '2';
    out.likeWrote = window.__writes > 0;
    out.pageStayedShut = document.getElementById('eventScreen').classList.contains('hidden');
    // Comment right there: a sheet, not the page.
    b2[1].click();
    await wait(400);
    out.sheet = !document.getElementById('commentSheet').classList.contains('hidden');
    out.sheetTitle = document.getElementById('csTitle').innerText;
    document.getElementById('csInput').value = 'next time!';
    window.__lastBatch = null;
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); window.postSheetComment();
    await wait(250);
    out.inSheet = [...document.querySelectorAll('#csList .cmt-text')].some((n) => n.innerText === 'next time!');
    const ops = (window.__lastBatch || []).map((o) => o.kind + ' ' + o.path.replace(/comments\/[^/]+$/, 'comments/X'));
    out.oneBatch = ops.join(',');
    const soc = (window.__lastBatch || []).find((o) => /social\/likes$/.test(o.path));
    out.countMoves = !!soc && soc.data.comments && soc.data.comments.__op === 'inc' && soc.data.comments.v === 1
      && typeof soc.data.lastCommentId === 'string';
    window.closeComments();
    await wait(300);
    out.cardCount = [...document.querySelectorAll('#event-m3 .soc-btn')][1].innerText.trim();
    ui.showTab('events');
    await wait(150);
    return out;
  });
  ok('a Recap card has its own like and comment buttons', quick.bar === 2 && quick.likeText === '1' && quick.commentText === '4', JSON.stringify(quick));
  ok('a like works right on the card, without opening the event', quick.likedInPlace && quick.likeWrote && quick.pageStayedShut);
  ok('the comment button opens a sheet over the card, not the event', quick.sheet && quick.sheetTitle === 'Chai at the gate');
  ok('a comment posts from the sheet', quick.inSheet === true);
  ok('the comment, its count and the posting stamp go in ONE batch',
     quick.oneBatch === 'set events/m3/comments/X,set events/m3/social/likes,set users/me/private/limits' && quick.countMoves, quick.oneBatch);
  ok('and the card\'s count moves with it', quick.cardCount === '5', quick.cardCount);

  // YOUR profile, and taking something off it.
  const mine = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = window.__m;
    const t = Date.now();
    state.userCache.me.hiddenEvents = [];
    window.__events = ['m1', 'm3'].map((id) => Object.assign({}, state.eventCache[id], { hostUid: 'me' }));
    window.openProfileScreen('me');
    await wait(900);
    const list = document.getElementById('myProfileEvents');
    const out = {
      cards: list.querySelectorAll('.jr-card').length,
      bars: list.querySelectorAll('.jr-card .jr-foot .soc-btn').length,
      head: (list.querySelector('.pe-group') || {}).innerText || ''
    };
    window.__updates = [];
    const more = [...list.querySelectorAll('.jr-card')].find((c) => c.innerText.includes('Chai at the gate')).querySelector('.jr-more');
    more.click();
    await wait(250);
    window.confirmYes();
    await wait(300);
    const upd = (window.__updates || []).find((u) => u.path === 'users/me');
    out.wrote = !!upd && upd.patch.hiddenEvents && upd.patch.hiddenEvents.__op === 'union' && upd.patch.hiddenEvents.v === 'm3';
    out.cardsAfter = list.querySelectorAll('.jr-card:not(.is-hidden)').length;
    out.toggle = (list.querySelector('.pe-hidden-toggle') || {}).innerText || '';
    out.stillOnEvent = !!state.eventCache.m3 && (state.eventCache.m3.participantUids || []).includes('me');
    list.querySelector('.pe-hidden-toggle').click();
    await wait(100);
    const back = list.querySelector('.jr-card.is-hidden .jr-restore');
    out.restoreShown = !!back;
    back.click();
    await wait(300);
    out.restored = list.querySelectorAll('.jr-card:not(.is-hidden)').length === 2 && !(state.userCache.me.hiddenEvents || []).includes('m3');
    window.closeProfileScreen({ all: true });
    await wait(300);
    return out;
  });
  ok('your finished events are memory cards, each with its own like and comment', mine.cards === 2 && mine.bars === 4, JSON.stringify(mine));
  ok('headed Memories, with how many', /memories\s*2/i.test(mine.head), mine.head);
  ok('taking one off your profile is one write to your own profile', mine.wrote === true);
  ok('it leaves your profile, and nothing else — you are still on the event', mine.cardsAfter === 1 && mine.stillOnEvent);
  ok('only you see what you hid, and can put it back', /1 hidden from your profile/.test(mine.toggle) && mine.restoreShown && mine.restored);

  // ---- REPLYING AND TAGGING ----
  const tags = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = window.__m;
    state.userCache.b.username = 'diya_b'; state.userCache.b.displayName = 'Diya';
    window.__stubDocs['events/m3/comments/k1'] = { uid: 'b', text: 'who brought the speaker? @me_h', createdAt: Date.now() - 5000 };
    const mem = await import('/js/services/memoryService.js');
    mem.retryMemories('m3');
    window.openComments('m3');
    await wait(400);
    const out = {
      mention: !!document.querySelector('#csList .cmt-text .mention'),
      mentionText: (document.querySelector('#csList .cmt-text .mention') || {}).innerText
    };
    // Reply puts their handle in the box.
    const row = [...document.querySelectorAll('#csList .cmt')].find((n) => n.innerText.includes('speaker'));
    [...row.querySelectorAll('.mem-link')].find((b) => b.innerText === 'Reply').click();
    await wait(80);
    const input = document.getElementById('csInput');
    out.reply = input.value;
    // Typing @Di suggests Diya; picking her writes the handle.
    input.value = 'thanks @Di';
    input.setSelectionRange(input.value.length, input.value.length);
    window.onCommentInput('sheet');
    await wait(60);
    const picks = [...document.querySelectorAll('#csMentions .mention-pick')];
    out.suggested = picks.map((p) => p.innerText.replace(/\s+/g, ' ').trim()).join('|');
    if (picks[0]) picks[0].click();
    await wait(60);
    out.picked = input.value;
    out.rowHidden = document.getElementById('csMentions').classList.contains('hidden');
    input.value = '';
    window.closeComments();
    await wait(300);
    return out;
  });
  ok('an @handle in a comment is a tap to that profile', tags.mention && tags.mentionText === '@me_h', JSON.stringify(tags));
  ok('Reply starts your comment with their @handle', tags.reply === '@diya_b ');
  ok('typing @ suggests people from the event', tags.suggested.indexOf('Diya @diya_b') >= 0, tags.suggested);
  ok('and picking one writes the handle for you', tags.picked === 'thanks @diya_b ' && tags.rowHidden);

  // A profile's finished events are a journal of memory cards.
  const journal = await page.evaluate(async () => {
    const prof = await import('/js/services/profileService.js');
    const { state } = window.__m;
    const box = document.createElement('div');
    box.innerHTML = prof.__cardForTest(state.eventCache.m1, Date.now(), { isSelf: true });
    const other = document.createElement('div');
    other.innerHTML = prof.__cardForTest(state.eventCache.m1, Date.now(), { isSelf: false });
    // The whole print is the tap target now, not only the photo.
    const open = box.querySelector('.jr-card');
    return {
      tap: (open && open.getAttribute('onclick')) || '',
      cover: !!box.querySelector('.jr-cover img'),
      slot: !!box.querySelector('.jr-card .jr-foot[data-social="m1"]'),
      more: !!box.querySelector('.jr-more'), moreOnOthers: !!other.querySelector('.jr-more')
    };
  });
  ok('on a profile, a finished event is a memory card that opens its page', journal.tap.indexOf("openEventPage('m1')") >= 0, JSON.stringify(journal));
  ok('with its cover, and its like and comment INSIDE the card', journal.cover && journal.slot);
  ok('and, on your own profile only, a way to take it off', journal.more && !journal.moreOnOthers);

  // ---- STORIES ----
  await page.evaluate(() => { window.__uploads = []; window.__m.ev.renderEvents(); });
  await page.waitForTimeout(200);
  const rail = await page.evaluate(() => {
    const mine = document.querySelector('#liveRail .story-item.mine');
    return { mine: !!mine, label: mine && mine.querySelector('.story-label').innerText };
  });
  ok('switched on, the rail starts with your own story ring', rail.mine && rail.label === 'You', JSON.stringify(rail));

  await pick(() => document.querySelector('#liveRail .story-item.mine').click());
  await page.waitForTimeout(300);
  const composed = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { open: !document.getElementById('storyComposer').classList.contains('hidden'),
                  hours: [...document.querySelectorAll('#scHours .sc-hour')].map((b) => b.innerText).join(',') };
    window.pickStoryHours(3);
    document.getElementById('scCaption').value = 'golden hour';
    document.getElementById('scSongUrl').value = 'https://evil.example/track/1';
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); await window.postStory();
    out.badSongRefused = !Object.keys(window.__stubDocs).some((k) => k.startsWith('stories/'));
    document.getElementById('scSongUrl').value = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
    document.getElementById('scSongTitle').value = 'Kesariya — Arijit Singh';
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); await window.postStory();
    for (let i = 0; i < 30 && !Object.keys(window.__stubDocs).some((k) => k.startsWith('stories/')); i++) await wait(100);
    await wait(200);
    const found = Object.entries(window.__stubDocs).find(([k]) => k.startsWith('stories/'));
    const doc = found && found[1];
    out.doc = doc ? [doc.uid, doc.hours, doc.audience, doc.caption, doc.song && doc.song.title].join('|') : '';
    out.photoOurs = !!doc && String(doc.photo).indexOf('stories%2Fme%2F') > 0;
    out.closed = document.getElementById('storyComposer').classList.contains('hidden');
    out.ringOn = !!document.querySelector('#liveRail .story-item.mine .story-ring.photo');
    return out;
  });
  ok('Your story opens the picker, then the composer with 2–24h to choose from', composed.open && composed.hours === '2h,3h,6h,12h,24h', JSON.stringify(composed));
  ok('a song link from anywhere else is refused', composed.badSongRefused === true);
  ok('a story is posted with its hours, audience, caption and song', composed.doc === 'me|3|public|golden hour|Kesariya — Arijit Singh', composed.doc);
  ok('its photo is your own upload, and your ring lights up', composed.photoOurs && composed.closed && composed.ringOn);

  const watched = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = Date.now();
    window.__stubDocs['stories/s_other'] = {
      uid: 'b', photo: 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/stories%2Fb%2FPhotoNumber4xxxxxxxx.jpg?alt=media&token=t-4',
      caption: 'hi', hours: 6, audience: 'public', song: null, createdAt: t - 60000 };
    // One that ended an hour ago: 2h, posted 3h ago.
    window.__stubDocs['stories/s_old'] = {
      uid: 'c', photo: 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/stories%2Fc%2FPhotoNumber5xxxxxxxx.jpg?alt=media&token=t-5',
      caption: '', hours: 2, audience: 'public', song: null, createdAt: t - 3 * 3600e3 };
    const st = await import('/js/services/storyService.js');
    st.loadStories({ force: true });
    await wait(300);
    const titles = () => [...document.querySelectorAll('#liveRail .story-item')].map((n) => n.getAttribute('title') || '');
    const out = { rings: titles().length, expiredShown: titles().some((x) => x.charAt(0) === 'C') };
    window.openStories('me');
    await wait(200);
    out.viewerOpen = !document.getElementById('storyViewer').classList.contains('hidden');
    out.caption = document.getElementById('svCaption').innerText;
    const songB = document.querySelector('#svSong .sv-song-text b');
    out.song = songB && songB.innerText;
    out.ownActs = [...document.querySelectorAll('#svActs .pv-act')].map((b) => b.innerText).join(',');
    document.querySelector('#svSong .sv-song-card').click();
    await wait(100);
    const frame = document.querySelector('#svSong iframe');
    out.player = (frame && frame.getAttribute('src')) || '';
    window.storyNext();           // on to b's
    await wait(150);
    out.nextActs = [...document.querySelectorAll('#svActs .pv-act')].map((b) => b.innerText).join(',');
    window.__adds = []; Object.keys(window.__stubDocs).filter((k) => k.startsWith('reports/')).forEach((k) => delete window.__stubDocs[k]);
    window.reportStory();
    await wait(300);
    out.reportWho = document.getElementById('reportWho').innerText;
    (await import('/js/services/limitsService.js')).__resetPostGapForTest(); window.sendReport();
    await wait(400);
    if (window.confirmNo) window.confirmNo();
    await wait(300);
    out.otherRingGone = !titles().some((x) => x.charAt(0) === 'B');
    return out;
  });
  ok('a story that has run its hours is not in the rail', watched.expiredShown === false && watched.rings === 2, JSON.stringify(watched));
  ok('watching shows the caption and the song', watched.viewerOpen && watched.caption === 'golden hour' && watched.song === 'Kesariya — Arijit Singh');
  ok('your own offers Add another and Delete', watched.ownActs === 'Add another,Delete');
  ok('tapping the song plays it in Spotify\'s own player, only then', watched.player === 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
  ok('somebody else\'s offers Report', watched.nextActs === 'Report');
  ok('and a reported story leaves your rail', watched.reportWho === 'this story' && watched.otherRingGone === true);

  // ---- THE ADMIN ----
  const admin = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const adminSvc = await import('/js/services/adminService.js');
    const out = {};
    delete window.__stubDocs['admins/me'];
    await adminSvc.checkAdmin();
    out.hiddenForOthers = getComputedStyle(document.querySelector('.admin-only')).display === 'none';
    window.__stubDocs['admins/me'] = { note: 'set by hand in the console' };
    await adminSvc.checkAdmin();
    out.shownForAdmin = getComputedStyle(document.querySelector('.admin-only')).display !== 'none';
    const t = Date.now();
    Object.keys(window.__stubDocs).filter((k) => k.startsWith('reports/')).forEach((k) => delete window.__stubDocs[k]);
    window.__stubDocs['reports/r1'] = { reporterUid: 'b', targetUid: 'a', targetType: 'comment', targetId: 'm1_c2', reason: 'Harassment or bullying', note: 'not ok', excerpt: 'we go again friday', createdAt: t - 1000 };
    window.__stubDocs['reports/r2'] = { reporterUid: 'b', targetUid: 'c', targetType: 'user', targetId: '', reason: 'Spam or scam', note: '', excerpt: '', createdAt: t - 2000 };
    adminSvc.openAdminScreen();
    await wait(300);
    const list = document.getElementById('adminReports');
    out.cards = list.querySelectorAll('.ar').length;
    const ex = list.querySelector('.ar-text');
    out.excerpt = ex && ex.innerText;
    window.__updates = [];
    const card1 = [...list.querySelectorAll('.ar')].find((c) => c.innerText.includes('we go again'));
    [...card1.querySelectorAll('.ar-btn')].find((b) => b.innerText === 'Remove').click();
    await wait(250);
    window.confirmYes();
    await wait(300);
    out.commentGone = !window.__stubDocs['events/m1/comments/c2'];
    const upd = (window.__updates || []).find((u) => u.path === 'reports/r1');
    out.marked = !!upd && upd.patch.status === 'removed' && upd.patch.handledBy === 'me';
    out.openLeft = document.querySelectorAll('#adminReports .ar').length;
    window.__stubDocs['users/c'] = { uid: 'c', username: 'c', banned: false };
    [...document.querySelectorAll('#adminReports .ar-btn')].find((b) => b.innerText === 'Ban').click();
    await wait(250);
    window.confirmYes();
    await wait(300);
    out.banned = window.__stubDocs['users/c'].banned === true;
    adminSvc.closeAdminScreen();
    await wait(250);
    delete window.__stubDocs['admins/me'];
    await adminSvc.checkAdmin();
    return out;
  });
  ok('Reports to review is there for an admin and nobody else', admin.hiddenForOthers && admin.shownForAdmin, JSON.stringify(admin));
  ok('the admin sees each report with a copy of what was said', admin.cards === 2 && admin.excerpt === 'we go again friday');
  ok('Remove takes the comment down and marks the report', admin.commentGone && admin.marked);
  ok('a handled report leaves the open list', admin.openLeft === 1);
  ok('Ban sets banned on the account', admin.banned === true);

  await flag(false);
  await page.evaluate(() => window.__m.ev.renderEvents());
}

/* ------------------------------------------------------------------ */
group('a profile loads in pages, posting has limits, and nothing stretches');
{
  await seed({});
  const hist = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = window.__m;
    const now = Date.now(), D = 864e5;
    state.userCache.me.hiddenEvents = [];
    // Fifteen finished events hosted, newest first by end.
    window.__events = Array.from({ length: 15 }, (_, i) => ({
      id: 'h' + i, hostUid: 'me', title: 'Past thing ' + i, place: 'Lawn', tag: '☕ Chill', description: '',
      startTime: now - (i + 1) * D - 2 * 36e5, expiresAt: now - (i + 1) * D,
      participantUids: ['me'], hypedUids: [], pendingUids: [], unconfirmedUids: [], circleId: 'main'
    }));
    window.__reads = 0;
    window.openProfileScreen('me');
    await wait(900);
    const list = document.getElementById('myProfileEvents');
    const out = {
      first: list.querySelectorAll('.jr-card').length,
      older: !!list.querySelector('.pe-older'),
      count: document.getElementById('peHostedCount').innerText,
      newest: (list.querySelector('.jr-title') || {}).innerText
    };
    list.querySelector('.pe-older').click();
    await wait(400);
    out.after = list.querySelectorAll('.jr-card').length;
    out.olderGone = !list.querySelector('.pe-older');
    out.countAfter = document.getElementById('peHostedCount').innerText;
    out.last = [...list.querySelectorAll('.jr-title')].pop().innerText;
    window.closeProfileScreen({ all: true });
    await wait(300);
    window.__events = [];
    return out;
  });
  ok('a profile opens with its newest twelve, not its whole history', hist.first === 12 && hist.newest === 'Past thing 0', JSON.stringify(hist));
  ok('says there are more, and has a way to them', hist.older && hist.count === '12+');
  ok('Show older brings the rest, in order, and then goes', hist.after === 15 && hist.olderGone && hist.last === 'Past thing 14' && hist.countAfter === '15');

  // Posting is four seconds apart — the rules refuse faster, so the app
  // says so first rather than failing.
  const slow = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = window.__m;
    const lim = await import('/js/services/limitsService.js');
    const mem = await import('/js/services/memoryService.js');
    const now = Date.now();
    state.eventCache.q1 = { id: 'q1', hostUid: 'a', title: 'Done', place: 'Lawn', tag: '☕ Chill', description: '',
      startTime: now - 5 * 36e5, expiresAt: now - 36e5, participantUids: ['a', 'me'], hypedUids: [], pendingUids: [], unconfirmedUids: [] };
    mem.retryMemories('q1');
    await wait(200);
    window.openComments('q1');
    await wait(300);
    lim.__resetPostGapForTest();
    const input = document.getElementById('csInput');
    input.value = 'one'; window.postSheetComment(); await wait(200);
    input.value = 'two'; window.postSheetComment(); await wait(200);
    const texts = Object.entries(window.__stubDocs).filter(([k]) => k.startsWith('events/q1/comments/')).map(([, v]) => v.text);
    const out = { texts: texts.join(','), kept: input.value, stamped: !!window.__stubDocs['users/me/private/limits'] };
    window.closeComments();
    await wait(250);
    return out;
  });
  ok('a second comment within seconds is held, not sent, and your words stay', slow.texts === 'one' && slow.kept === 'two', JSON.stringify(slow));
  ok('each post is stamped in the ledger the rules check', slow.stamped === true);

  // A thousand going is full, cap or no cap.
  const cap = await page.evaluate(async () => {
    const ev = await import('/js/services/eventsService.js');
    const now = Date.now();
    const many = Array.from({ length: 1000 }, (_, i) => 'u' + i);
    const html = ev.cardActions({ id: 'big', hostUid: 'u0', participantUids: many, hypedUids: [], pendingUids: [],
      startTime: now, expiresAt: now + 36e5, maxCapacity: null }, 'big');
    return { full: /act full/.test(html), hardCap: ev.HARD_CAP };
  });
  ok('an event with no cap is still full at a thousand', cap.full && cap.hardCap === 1000, JSON.stringify(cap));

  // No stretch: every scroller in a full-screen layer refuses Android's
  // overscroll stretch, the way the page itself always has.
  const stretch = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = Date.now();
    window.__m.state.eventCache.q2 = { id: 'q2', hostUid: 'a', title: 'On', place: 'Lawn', tag: '☕ Chill', description: '',
      startTime: now - 6e5, expiresAt: now + 36e5, participantUids: ['a'], hypedUids: [], pendingUids: [], unconfirmedUids: [] };
    window.openEventPage('q2');
    await wait(300);
    const out = {
      page: getComputedStyle(document.getElementById('eventPageScroll')).overscrollBehaviorY,
      create: getComputedStyle(document.querySelector('#createScreen .screen-body')).overscrollBehaviorY
    };
    window.closeEventPage();
    await wait(250);
    return out;
  });
  ok('the event page, and every full-screen layer, does not stretch when pulled', stretch.page === 'none' && stretch.create === 'none', JSON.stringify(stretch));

  // A date picker moved the view without a keyboard: the layer follows it.
  const pinned = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules]; } catch (e) { return []; } });
    const txt = rules.map((r) => r.cssText).join('\n');
    return /html\.vv-shifted \.full-screen-view/.test(txt);
  });
  ok('a layer is pinned to what you can see when a date picker moves the view', pinned === true);
}

/* ------------------------------------------------------------------ */
group('lists of people load twenty at a time');
{
  await seed({});
  const lists = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = window.__m;
    const t = Date.now();
    const people = Array.from({ length: 45 }, (_, i) => 'p' + String(i).padStart(2, '0'));
    // Profiles exist but are NOT cached: every name on screen is a read.
    people.forEach((u, i) => {
      window.__stubDocs['users/' + u] = { uid: u, username: 'user_' + u, displayName: 'Person ' + i };
      delete state.userCache[u];
    });
    const out = {};
    const scrollToEnd = async (box) => {
      box.scrollTop = box.scrollHeight;
      const s = box.closest('.screen-body') || box;
      s.scrollTop = s.scrollHeight;
      await wait(500);
    };

    // FOLLOWING: an array already in memory; names twenty at a time.
    state.following = people.slice();
    window.__readPaths = [];
    window.openProfileList ? null : null;
    await (await import('/js/services/followService.js')).openFollowList('me', 'following');
    await wait(300);
    const body = document.getElementById('followListBody');
    out.followingFirst = body.querySelectorAll('.orbit-row').length;
    out.followingSentinel = !!body.querySelector('.list-more .sk-row');
    out.namesRead = people.filter((u) => state.userCache[u] && state.userCache[u].displayName !== 'Student').length;
    await scrollToEnd(body);
    out.followingSecond = body.querySelectorAll('.orbit-row').length;
    out.slidIn = body.querySelectorAll('.orbit-row.row-in').length;
    await scrollToEnd(body);
    out.followingAll = body.querySelectorAll('.orbit-row').length;
    out.followingDone = !body.querySelector('.list-more');
    window.closeFollowList();
    await wait(300);

    // FOLLOWERS: a query, twenty documents at a time.
    Object.keys(window.__stubDocs).filter((k) => k.startsWith('users/me/followers/')).forEach((k) => delete window.__stubDocs[k]);
    people.forEach((u, i) => { window.__stubDocs['users/me/followers/' + u] = { at: t - i * 1000 }; });
    state.userCache.me.followerCount = 45;
    window.__reads = 0;
    await (await import('/js/services/followService.js')).openFollowList('me', 'followers');
    await wait(300);
    out.followersFirst = body.querySelectorAll('.orbit-row').length;
    out.followersTitle = document.getElementById('followListTitle').innerText;
    await scrollToEnd(body);
    out.followersSecond = body.querySelectorAll('.orbit-row').length;
    await scrollToEnd(body);
    await scrollToEnd(body);
    out.followersAll = body.querySelectorAll('.orbit-row').length;
    window.closeFollowList();
    await wait(300);
    people.forEach((u) => delete window.__stubDocs['users/me/followers/' + u]);
    state.following = [];

    // ORBIT: twenty linked at a time.
    people.forEach((u) => delete state.userCache[u]);
    state.orbitUids = people.slice();
    window.openOrbitScreen();
    await wait(400);
    const orbit = document.getElementById('orbitBody');
    out.orbitFirst = orbit.querySelectorAll('.orbit-row').length;
    await scrollToEnd(orbit);
    out.orbitSecond = orbit.querySelectorAll('.orbit-row').length;
    window.closeOrbitScreen();
    await wait(300);
    state.orbitUids = [];

    // BLOCKED: from the listener's own snapshot, twenty at a time.
    state.blockedByMe = people.slice(0, 25);
    const prof = await import('/js/services/profileService.js');
    await prof.refreshBlockedList();
    const blocked = document.getElementById('blockedList');
    out.blockedFirst = blocked.querySelectorAll('.blocked-row').length;
    out.blockedSentinel = !!blocked.querySelector('.list-more');
    state.blockedByMe = [];
    return out;
  });
  ok('following shows twenty, with shimmering rows where the rest will be', lists.followingFirst === 20 && lists.followingSentinel, JSON.stringify(lists));
  ok('and reads only those twenty names', lists.namesRead === 20, String(lists.namesRead));
  ok('scrolling to the end brings the next twenty, sliding in', lists.followingSecond === 40 && lists.slidIn === 20);
  ok('and then the rest, and the shimmer goes', lists.followingAll === 45 && lists.followingDone);
  ok('followers are fetched twenty at a time as you scroll', lists.followersFirst === 20 && lists.followersSecond === 40 && lists.followersAll === 45, JSON.stringify(lists));
  ok('the followers title keeps the real total while pages load', /45/.test(lists.followersTitle), lists.followersTitle);
  ok('your orbit loads twenty at a time too', lists.orbitFirst === 20 && lists.orbitSecond === 40);
  ok('and so do the people you blocked', lists.blockedFirst === 20 && lists.blockedSentinel);
}

/* ------------------------------------------------------------------ */
group('one name in the tab, prints on a profile, and Publish stays put');
{
  const past = Object.assign(mkEvent('q1', 'me', 'Chai at the gate', '☕ Chill'),
    { startTime: now - 3 * 864e5, expiresAt: now - 3 * 864e5 + 72e5, participantUids: ['me', 'a'],
      photos: ['https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/events%2Fme%2FPhotoNumber1xxxxxxxx.jpg?alt=media&token=t-1'] });
  const bare = Object.assign(mkEvent('q2', 'me', 'Maggi run', '\u{1F355} Food'),
    { startTime: now - 5 * 864e5, expiresAt: now - 5 * 864e5 + 72e5, participantUids: ['me'] });
  const live = mkEvent('q3', 'a', 'Still going', '☕ Chill');
  await seed({ q1: past, q2: bare, q3: live });

  const tabs = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { ui } = window.__m;
    const out = {};
    ui.showTab('events'); out.feed = document.title;
    window.openCreateScreen(); await wait(50); out.create = document.title;
    window.closeCreateScreen(); await wait(300); out.back = document.title;
    window.openEventPage('q3'); await wait(100); out.page = document.title;
    window.closeEventPage(); await wait(300); out.pageBack = document.title;
    window.openSettingsScreen(); await wait(100); out.settings = document.title;
    window.closeSettingsScreen ? window.closeSettingsScreen() : history.back(); await wait(300);
    out.afterSettings = document.title;
    return out;
  });
  ok('the tab is just livesociya, whatever is open over the feed',
     Object.values(tabs).every((t) => t === 'livesociya'), JSON.stringify(tabs));

  // THE PUBLISH BAR. iOS scrolled the create sheet ITSELF (overflow:
  // hidden can still be scrolled) to show the date picker, and our own
  // scrollIntoView did the same — Publish went half off the top.
  const bar = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let intoView = 0;
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) { intoView++; return real.apply(this, a); };
    window.openCreateScreen(); await wait(350);
    const layer = document.getElementById('createScreen');
    const head = layer.querySelector('.screen-header');
    const out = { overflow: getComputedStyle(layer).overflowY };
    layer.scrollTop = 60; await wait(30);
    out.layerScroll = layer.scrollTop;
    document.getElementById('startTime').focus(); await wait(700);
    out.intoViewPicker = intoView;
    out.headTop = Math.round(head.getBoundingClientRect().top - layer.getBoundingClientRect().top);
    document.getElementById('startTime').blur();
    document.getElementById('maxCapacity').focus(); await wait(700);
    out.intoViewText = intoView;
    out.layerScrollAfter = layer.scrollTop;
    out.headTopAfter = Math.round(head.getBoundingClientRect().top - layer.getBoundingClientRect().top);
    document.getElementById('maxCapacity').blur();
    Element.prototype.scrollIntoView = real;
    window.closeCreateScreen(); await wait(300);
    return out;
  });
  ok('a layer cannot be scrolled out from under its own header', bar.layerScroll === 0 && bar.layerScrollAfter === 0, JSON.stringify(bar));
  ok('a date picker moves nothing', bar.intoViewPicker === 0 && bar.headTop === 0, JSON.stringify(bar));
  ok('a text field scrolls only its own panel, never the layer', bar.intoViewText === 0 && bar.headTopAfter === 0, JSON.stringify(bar));

  const prints = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = window.__m;
    const f = await import('/js/config/features.js'); f.features.photos = true; f.applyFeatureFlags();
    window.__events = [state.eventCache.q1, state.eventCache.q2];
    window.openProfileScreen('me'); await wait(900);
    const list = document.getElementById('myProfileEvents');
    const cards = [...list.querySelectorAll('.jr-card')];
    const withPhoto = cards.find((c) => c.innerText.includes('Chai'));
    const without = cards.find((c) => c.innerText.includes('Maggi'));
    const out = {
      n: cards.length,
      tilted: cards.every((c) => getComputedStyle(c).transform !== 'none'),
      pinned: cards.every((c) => getComputedStyle(c, '::before').content !== 'none'),
      stamp: (withPhoto.querySelector('.jr-stamp') || {}).innerText || '',
      noStamp: !without.querySelector('.jr-stamp'),
      title: document.title
    };
    window.closeProfileScreen({ all: true }); await wait(300);
    f.features.photos = false; f.applyFeatureFlags();
    return out;
  });
  const d = new Date(past.startTime);
  const want = '’' + String(d.getFullYear()).slice(-2) + ' ' + (d.getMonth() + 1) + ' ' + d.getDate();
  ok('memories hang as tilted prints, each on a pin', prints.n === 2 && prints.tilted && prints.pinned, JSON.stringify(prints));
  ok('a photo carries the date the way a film camera burnt it', prints.stamp === want && prints.noStamp, JSON.stringify(prints) + ' want ' + want);
}

/* ------------------------------------------------------------------ */
group('a phone loading older memories');
{
  // Show older, on the widths phones actually are, with the prints
  // tilted: nothing errors, nothing hangs past the column, no card is
  // drawn twice however fast the button is tapped, and the page does
  // not jump back to the top under your thumb.
  const SU = (n) => 'https://firebasestorage.googleapis.com/v0/b/livesociyaweb.firebasestorage.app/o/events%2Fme%2FPhotoNumber'
    + (n % 10) + 'xxxxxxxx.jpg?alt=media&token=t-' + n;
  for (const width of [320, 360, 390, 430]) {
    const ctx = await browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 120)); });
    await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const r = await p.evaluate(async (urls) => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const { state } = await import('/js/state/store.js');
      const f = await import('/js/config/features.js'); f.features.photos = true; f.applyFeatureFlags();
      const now = Date.now(), D = 864e5;
      window.__authSingleton.currentUser = { uid: 'me' };
      state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true; state.userAvatar = '\u{1F43C}';
      state.userCache = { me: { uid: 'me', username: 'me_h', displayName: 'Me', avatar: '\u{1F43C}', followers: [], following: [], vouchedBy: [], hiddenEvents: [] } };
      state.following = []; state.orbitUids = []; state.eventCache = {}; state.eventOrder = []; state.recapOrder = []; state.recapDone = true;
      const tags = ['☕ Chill', '\u{1F355} Food', '\u{1F389} Party', '\u{1F4DA} Study', '\u{1F3C0} Sports'];
      window.__events = Array.from({ length: 30 }, (_, i) => ({
        id: 'g' + i, hostUid: 'me', title: i % 4 === 0 ? 'A very long title for a night nobody will forget, ' + i : 'Thing ' + i,
        place: 'Lawn', tag: tags[i % 5], description: '',
        startTime: now - (i + 1) * D - 2 * 36e5, expiresAt: now - (i + 1) * D,
        participantUids: ['me'], hypedUids: [], pendingUids: [], unconfirmedUids: [], circleId: 'main',
        photos: i % 3 === 1 ? [] : [urls[i]]
      }));
      document.getElementById('loading-screen').classList.add('hidden');
      document.querySelector('.app-frame').classList.remove('hidden');
      window.switchScreen('home');
      window.openProfileScreen('me');
      await wait(900);
      const list = document.getElementById('myProfileEvents');
      let scroller = list.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const out = { first: list.querySelectorAll('.jr-card').length };
      for (let page = 0; page < 2; page++) {
        const btn = list.querySelector('.pe-older');
        if (!btn) break;
        btn.scrollIntoView({ block: 'end' });
        const before = scroller ? scroller.scrollTop : window.scrollY;
        btn.click(); btn.click();      // a double tap
        await wait(500);
        const after = scroller ? scroller.scrollTop : window.scrollY;
        out['jump' + page] = Math.round(before - after);
      }
      await wait(300);
      const cards = [...list.querySelectorAll('.jr-card')];
      const ids = cards.map((c) => c.querySelector('.jr-foot')?.dataset.social || c.innerText);
      const lr = list.getBoundingClientRect();
      const col = { left: lr.left, right: lr.right };
      out.total = cards.length;
      out.dupes = ids.length - new Set(ids).size;
      out.outside = cards.filter((c) => {
        const cr = c.getBoundingClientRect();
        return cr.left < col.left - 1 || cr.right > col.right + 1;
      }).length;
      out.pageWider = document.documentElement.scrollWidth > window.innerWidth;
      out.pinsCut = cards.filter((c) => {
        const grid = c.parentElement.getBoundingClientRect();
        return c.getBoundingClientRect().top - 8 < grid.top - 1;
      }).length;
      out.stamps = list.querySelectorAll('.jr-stamp').length;
      return out;
    }, Array.from({ length: 30 }, (_, i) => SU(i)));
    ok(`${width}px: older memories load in, all thirty, none twice`, r.first === 12 && r.total === 30 && r.dupes === 0, JSON.stringify(r));
    ok(`${width}px: no print reaches past the column, the page never scrolls sideways`, r.outside === 0 && !r.pageWider && r.pinsCut === 0, JSON.stringify(r));
    ok(`${width}px: loading more does not throw you back up the page`, (r.jump0 || 0) < 40 && (r.jump1 || 0) < 40, JSON.stringify(r));
    ok(`${width}px: and nothing errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
}

/* ------------------------------------------------------------------ */
group('many at once, a fresh profile, a whole memory, and coming back');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 120)); });
  p.on('dialog', (d) => { errs.push('NATIVE DIALOG'); d.dismiss(); });
  await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  const setup = async () => p.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true; state.userAvatar = '\u{1F43C}';
    state.userCache = { me: { uid: 'me', username: 'me_h', displayName: 'Me', avatar: '\u{1F43C}', followers: [], following: [], vouchedBy: [], hiddenEvents: [] } };
    ['a', 'b', 'c'].forEach((u) => { state.userCache[u] = { uid: u, username: u, displayName: u.toUpperCase(), avatar: '\u{1F98A}', followers: [], following: [], vouchedBy: [] }; });
    state.following = []; state.orbitUids = []; state.eventCache = {}; state.eventOrder = []; state.recapOrder = []; state.recapDone = true;
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');
  });
  await setup();

  // A burst of new events: the snapshot that brought a stranger host
  // waits on their name; the one after it must not be painted over.
  const burst = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ev = await import('/js/services/eventsService.js');
    const { state } = await import('/js/state/store.js');
    const now = Date.now();
    const mk = (id, host) => ({ id, hostUid: host, title: id, place: 'Lawn', description: '', tag: '\u{1F389} Party',
      startTime: now - 6e5, expiresAt: now + 36e5, participantUids: [host], hypedUids: [], pendingUids: [], unconfirmedUids: [], circleId: 'main' });
    window.__events = [mk('A', 'a')];
    ev.loadEvents();
    await wait(100);
    window.__stubDocs['users/zz'] = { uid: 'zz', username: 'zz', displayName: 'ZZ' };
    window.__slowReads = { 'users/zz': 400 };
    window.__events = [mk('A', 'a'), mk('B', 'zz')];
    window.__fireEvents();           // slow: needs zz's name
    window.__events = [mk('A', 'a'), mk('C', 'b')];
    window.__fireEvents();           // fast, and newer: B is gone, C is new
    await wait(700);
    window.__slowReads = {};
    const cards = [...document.querySelectorAll('#events .event')].map((c) => c.id.replace('event-', ''));
    return { order: state.eventOrder.slice(), cards };
  });
  ok('many events at once: an older snapshot finishing late cannot paint over a newer one',
    burst.order.includes('C') && !burst.order.includes('B') && burst.cards.includes('C') && !burst.cards.includes('B'), JSON.stringify(burst));

  // Two people opening the same chat in the same moment: theirs lands
  // first, ours must still go through, as a reply in their thread.
  const race = await p.evaluate(async () => {
    const chat = await import('/js/services/chatService.js');
    const theirs = { userUids: ['a', 'me'], initiatedByUid: 'a', status: 'icebreaker', icebreakerUsed: true,
      unreadByUid: 'me', unreadCount: 1, lastUpdated: Date.now(), createdAt: 1 };
    let refused = 0;
    window.__rules = (path, data, kind) => {
      if (path === 'chats/a_me' && kind === 'set' && data && 'createdAt' in data) {
        if (!window.__stubDocs['chats/a_me']) window.__stubDocs['chats/a_me'] = Object.assign({}, theirs);
        refused++;
        return { code: 'permission-denied' };
      }
      return null;
    };
    let err = '';
    try { await chat.sendDirectText('a', 'hey, same time!'); } catch (e) { err = e.code || e.message; }
    window.__rules = null;
    const msgs = Object.keys(window.__stubDocs).filter((k) => k.startsWith('chats/a_me/messages/'))
      .map((k) => window.__stubDocs[k].text);
    const doc = window.__stubDocs['chats/a_me'];
    return { err, refused, msgs, initiator: doc.initiatedByUid, status: doc.status, unreadBy: doc.unreadByUid };
  });
  ok('two people starting the same chat at once: the second message is not lost',
    !race.err && race.refused === 1 && race.msgs.includes('hey, same time!'), JSON.stringify(race));
  ok('and it lands as a reply in THEIR thread, which it unlocks',
    race.initiator === 'a' && race.status === 'unlocked' && race.unreadBy === 'a', JSON.stringify(race));

  // A new profile opens at its top, not as far down as the last one.
  const scroll = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__events = [];
    window.openProfileScreen('a');
    await wait(500);
    const body = document.querySelector('#profileScreen .profile-scroll-body');
    const pad = document.createElement('div'); pad.style.height = '3000px'; pad.id = 'tallPad';
    body.appendChild(pad);
    body.scrollTop = 900;
    const before = body.scrollTop;
    window.openProfileScreen('b');
    await wait(300);
    const afterOpen = body.scrollTop;
    body.scrollTop = 700;
    window.closeProfileScreen();       // back along the trail, to a
    await wait(300);
    const afterBack = body.scrollTop;
    document.getElementById('tallPad')?.remove();
    window.closeProfileScreen({ all: true });
    return { before, afterOpen, afterBack };
  });
  ok('a profile opened from another profile starts at its top', scroll.before > 500 && scroll.afterOpen === 0, JSON.stringify(scroll));
  ok('and so does going back to the one before', scroll.afterBack === 0, JSON.stringify(scroll));

  // A memory in Recap is one tap target; its faces no longer open profiles.
  const stub = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ev = await import('/js/services/eventsService.js');
    const { state } = await import('/js/state/store.js');
    const now = Date.now();
    state.eventCache.R1 = { id: 'R1', hostUid: 'a', title: 'Last night', place: 'Lawn', description: '', tag: '\u{1F389} Party',
      startTime: now - 3 * 36e5, expiresAt: now - 36e5, participantUids: ['a', 'b', 'c', 'me'], hypedUids: [], pendingUids: [], unconfirmedUids: [], circleId: 'main' };
    state.recapOrder = ['R1'];
    ev.renderEvents();
    window.showTab('recap');
    await wait(200);
    const card = document.getElementById('event-R1');
    const faces = card ? [...card.querySelectorAll('.av-stack .mini')] : [];
    const host = card ? card.querySelector('.byline-name') : null;
    let opened = false;
    if (card) {
      card.querySelector('.going-text')?.click();
      await wait(120);
      opened = !document.getElementById('eventScreen').classList.contains('hidden');
      window.closeEventPage();
      await wait(120);
    }
    return {
      card: !!card, tap: card ? card.getAttribute('onclick') || '' : '',
      facesTap: faces.filter((f) => f.getAttribute('onclick')).length, faces: faces.length,
      hostStops: host ? /stopPropagation/.test(host.getAttribute('onclick') || '') : false, opened
    };
  });
  ok('a Recap memory opens from anywhere on it, not just its title',
    stub.card && stub.tap.includes("openEventPage('R1')") && stub.opened, JSON.stringify(stub));
  ok('its row of faces no longer sends you to somebody\'s profile; the host\'s name still does',
    stub.faces > 0 && stub.facesTap === 0 && stub.hostStops, JSON.stringify(stub));
  await p.evaluate(() => window.showTab('events'));

  // Coming back after the browser reloaded the tab.
  const back = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = await import('/js/utils/restore.js');
    window.showTab('chats');
    r.saveRestorePoint();
    const saved = JSON.parse(sessionStorage.getItem('livesociya.restore') || 'null');
    window.showTab('events');
    document.documentElement.classList.add('restoring');
    const probe = document.createElement('div'); probe.className = 'stagger'; probe.innerHTML = '<div></div>';
    document.body.appendChild(probe);
    const frozen = getComputedStyle(probe.firstChild).animationDuration;
    document.dispatchEvent(new CustomEvent('livesociya:ready'));
    await wait(700);
    const tab = document.querySelector('.nav-item.active[data-tab]')?.dataset.tab;
    const stillRestoring = document.documentElement.classList.contains('restoring');
    const moving = getComputedStyle(probe.firstChild).animationDuration;
    probe.remove();
    // Old or damaged points are ignored.
    sessionStorage.setItem('livesociya.restore', JSON.stringify({ at: Date.now() - 2 * 36e5, tab: 'recap' }));
    const stale = r.takeRestorePoint();
    sessionStorage.setItem('livesociya.restore', '{nope');
    const junk = r.takeRestorePoint();
    return { saved: saved && saved.tab, tab, frozen, moving, stillRestoring, stale, junk };
  });
  ok('where you were is saved when the page is put away', back.saved === 'chats', JSON.stringify(back));
  ok('a reload of the tab puts you back on it', back.tab === 'chats', JSON.stringify(back));
  ok('with nothing rising in while it does, and animations back afterwards',
    back.frozen === '0s' && back.moving !== '0s' && !back.stillRestoring, JSON.stringify(back));
  ok('an old or broken restore point is ignored', back.stale === null && back.junk === null, JSON.stringify(back));
  await p.evaluate(() => window.showTab('events'));
  ok('and nothing here errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // The warm start is decided before the first paint.
  const wctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await wctx.addInitScript(() => {
    try { localStorage.setItem('livesociya.warm', '1'); } catch (e) {}
    // Every class the root is given, in order: the stub signs nobody in,
    // so the app goes cold again almost at once, and the warm classes
    // have to be caught as they are set.
    window.__rootClasses = [];
    const add = DOMTokenList.prototype.add;
    DOMTokenList.prototype.add = function (...names) {
      const r = add.apply(this, names);
      if (names.includes('warm')) window.__rootClasses.push(String(this.value));
      return r;
    };
  });
  const wp = await wctx.newPage();
  await wp.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await wp.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  const warm = await wp.evaluate(() => {
    const root = document.documentElement;
    const first = (window.__rootClasses || []).find((c) => /warm/.test(c)) || '';
    root.classList.add('warm');
    const spinnerHidden = getComputedStyle(document.querySelector('#loading-screen .spinner')).visibility;
    root.classList.remove('warm');
    return { first, manual: history.scrollRestoration, spinnerHidden, warmFlag: localStorage.getItem('livesociya.warm') };
  });
  ok('a warm start: no spinner flash, entry animations off, scroll left to us',
    /warm/.test(warm.first) && /restoring/.test(warm.first) && warm.manual === 'manual' && warm.spinnerHidden === 'hidden', JSON.stringify(warm));
  ok('and a start that turns out signed out goes cold again', warm.warmFlag === null, JSON.stringify(warm));
  await wctx.close();

  // The Privacy Policy and the Terms exist, and are reachable.
  const lctx = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const lp = await lctx.newPage();
  const legal = {};
  for (const path of ['privacy.html', 'terms.html']) {
    const res = await lp.goto(APP_URL.replace('index.html', path));
    legal[path] = {
      status: res.status(),
      h1: await lp.evaluate(() => document.querySelector('h1')?.textContent || ''),
      wide: await lp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      contact: await lp.evaluate(() => !!document.querySelector('a[href^="mailto:"]'))
    };
  }
  await lctx.close();
  ok('privacy.html and terms.html load, and fit a 360px phone',
    Object.values(legal).every((l) => l.status === 200 && l.h1 && !l.wide && l.contact), JSON.stringify(legal));
  const links = await page.evaluate(() => ({
    settings: [...document.querySelectorAll('#settingsScreen .legal-links a')].map((a) => a.getAttribute('href')),
    login: [...document.querySelectorAll('#login .login-legal a')].map((a) => a.getAttribute('href'))
  }));
  ok('Settings and the sign-in screen link to both',
    links.settings.includes('/privacy.html') && links.settings.includes('/terms.html')
    && links.login.includes('/privacy.html') && links.login.includes('/terms.html'), JSON.stringify(links));
}

/* ------------------------------------------------------------------ */
group('pages that know when they end, and the chat, looked over');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 120)); });
  p.on('dialog', (d) => { errs.push('NATIVE DIALOG'); d.dismiss(); });
  await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.evaluate(async () => {
    const { state } = await import('/js/state/store.js');
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true; state.userAvatar = '\u{1F43C}';
    state.userCache = { me: { uid: 'me', username: 'me_h', displayName: 'Me', avatar: '\u{1F43C}', followers: [], following: [], vouchedBy: [], hiddenEvents: [] } };
    ['a', 'b', 'c', 'd'].forEach((u) => { state.userCache[u] = { uid: u, username: u, displayName: u.toUpperCase(), avatar: '\u{1F98A}', followers: [], following: [], vouchedBy: [] }; });
    state.following = []; state.orbitUids = []; state.eventCache = {}; state.eventOrder = []; state.recapOrder = []; state.recapDone = true;
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');
  });

  // Joined: 3 joins hidden among 20 of their own events.
  const joined = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = Date.now(), D = 864e5;
    const mk = (id, host, i) => ({ id, hostUid: host, title: id, place: 'Lawn', tag: '\u{1F389} Party', description: '',
      startTime: now - (i + 1) * D - 36e5, expiresAt: now - (i + 1) * D,
      participantUids: host === 'me' ? ['me'] : [host, 'me'], hypedUids: [], pendingUids: [], unconfirmedUids: [], circleId: 'main' });
    window.__events = [];
    for (let i = 0; i < 20; i++) window.__events.push(mk('h' + i, 'me', i));
    [2, 9, 17].forEach((i, n) => window.__events.push(mk('j' + n, 'a', i)));
    window.openProfileScreen('me');
    await wait(800);
    window.setProfileEventsTab('joined');
    await wait(100);
    const out = {
      count: document.getElementById('peJoinedCount')?.innerText,
      older: !!document.querySelector('#myProfileEvents .pe-older'),
      cards: document.querySelectorAll('#myProfileEvents .jr-card').length
    };
    window.setProfileEventsTab('hosted');
    await wait(100);
    out.hostedCount = document.getElementById('peHostedCount')?.innerText;
    // Exactly twelve hosted: no "+", no button.
    window.__events = window.__events.slice(0, 12);
    window.closeProfileScreen({ all: true });
    window.openProfileScreen('me');
    await wait(800);
    out.twelve = document.getElementById('peHostedCount')?.innerText;
    out.twelveOlder = !!document.querySelector('#myProfileEvents .pe-older');
    window.closeProfileScreen({ all: true });
    window.__events = [];
    return out;
  });
  ok('Joined says 3, not "3+", when their own events fill the page', joined.count === '3' && !joined.older && joined.cards === 3, JSON.stringify(joined));
  ok('Hosted still pages when there really is more', joined.hostedCount === '12+', JSON.stringify(joined));
  ok('and exactly a page is a page: no "+", no Show older', joined.twelve === '12' && !joined.twelveOlder, JSON.stringify(joined));

  // The inbox: exactly twenty chats is no "Show older chats"; 21 is.
  const inbox = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const chat = await import('/js/services/chatService.js');
    const { state } = await import('/js/state/store.js');
    const now = Date.now();
    const seedChats = (n) => {
      Object.keys(window.__stubDocs).filter((k) => k.startsWith('chats/')).forEach((k) => delete window.__stubDocs[k]);
      for (let i = 0; i < n; i++) {
        const u = 'u' + String(i).padStart(2, '0');
        state.userCache[u] = { uid: u, username: u, displayName: u, avatar: '\u{1F98A}' };
        window.__stubDocs['chats/me_' + u] = { userUids: ['me', u], status: 'unlocked', lastUpdated: now - i * 1000, unreadByUid: '', initiatedByUid: 'me', lastText: 'hi', lastMsgId: 'm' + i, lastSenderUid: u };
      }
    };
    window.showTab('chats');
    seedChats(20);
    chat.loadChatList();
    await wait(300);
    const at20 = !!document.getElementById('inboxMore');
    seedChats(21);
    chat.loadChatList();
    await wait(300);
    const at21 = !!document.getElementById('inboxMore');
    const rows21 = document.querySelectorAll('#chatList .chat-item').length;
    return { at20, at21, rows21 };
  });
  ok('the inbox offers older chats only when there is one', !inbox.at20 && inbox.at21 && inbox.rows21 === 20, JSON.stringify(inbox));

  // The chat itself.
  const c = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const chat = await import('/js/services/chatService.js');
    const { state } = await import('/js/state/store.js');
    const now = Date.now();
    const out = {};
    Object.keys(window.__stubDocs).filter((k) => k.startsWith('chats/')).forEach((k) => delete window.__stubDocs[k]);
    try { localStorage.removeItem('livesociya.drafts'); localStorage.removeItem('livesociya.muted'); } catch (e) {}
    window.__stubDocs['chats/a_me'] = { userUids: ['a', 'me'], status: 'unlocked', lastUpdated: now - 5e4, unreadByUid: '', initiatedByUid: 'a', lastMsgId: 'x0', lastText: 'yo', lastSenderUid: 'a' };
    window.__stubDocs['chats/b_me'] = { userUids: ['b', 'me'], status: 'unlocked', lastUpdated: now - 6e4, unreadByUid: '', initiatedByUid: 'b', lastMsgId: 'y0', lastText: 'hey', lastSenderUid: 'b' };
    for (let i = 0; i < 40; i++) {
      window.__stubDocs['chats/a_me/messages/x' + String(i).padStart(2, '0')] = { senderUid: i % 2 ? 'a' : 'me', text: 'line ' + i + ' ' + 'word '.repeat(12), time: now - (40 - i) * 60000 };
    }
    window.showTab('chats');
    chat.loadChatList();
    await wait(300);

    // A draft stays with its chat, and never follows you to another.
    chat.openChat('a_me', 'a');
    await wait(400);
    const input = document.getElementById('msgInput');
    input.value = 'half a thought for A';
    chat.openChat('b_me', 'b');
    await wait(300);
    out.boxEmptyInB = input.value === '';
    chat.openChat('a_me', 'a');
    await wait(300);
    out.draftBackInA = input.value === 'half a thought for A';
    chat.closeChat({ silent: true });
    window.switchScreen('home'); window.showTab('chats');
    await wait(100);
    out.inboxSaysDraft = [...document.querySelectorAll('#chatList .chat-item')].some((r) => /Draft:/.test(r.innerText) && /half a thought/.test(r.innerText));

    // Sending clears the draft.
    chat.openChat('a_me', 'a');
    await wait(400);
    await chat.sendMessage();
    await wait(100);
    out.draftGoneAfterSend = chat.draftFor('a_me') === '' && input.value === '';

    // Enter while an Indian-language keyboard is still composing sends nothing.
    input.value = 'namaste';
    const w0 = window.__writes;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    await wait(50);
    out.imeNoSend = window.__writes === w0 && input.value === 'namaste';
    input.value = '';

    // Read up the thread; a message arrives: you stay put and get a pill.
    const box = document.getElementById('messages');
    await wait(100);
    box.scrollTop = 0;
    await wait(250);
    const before = box.scrollTop;
    window.__stubDocs['chats/a_me/messages/x99'] = { senderUid: 'a', text: 'are you coming?', time: Date.now() };
    window.__fireColl('chats/a_me/messages');
    await wait(300);
    const pill = document.getElementById('newBelow');
    out.stayedPut = Math.abs(box.scrollTop - before) < 5;
    out.pill = !!pill && !pill.classList.contains('hidden') && /1 new message/.test(pill.innerText);
    // They start typing: you are still not dragged down.
    window.__stubDocs['chats/a_me'].typingUid = 'a';
    window.__fireDoc('chats/a_me');
    await wait(150);
    out.typingNoYank = Math.abs(box.scrollTop - before) < 5;
    window.__stubDocs['chats/a_me'].typingUid = '';
    window.__fireDoc('chats/a_me');
    // Your own send brings you down, and the pill goes.
    input.value = 'yes!';
    await chat.sendMessage();
    window.__fireColl('chats/a_me/messages');   // Firestore echoes a local write at once
    await wait(300);
    out.ownSendChases = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    out.pillGone = pill.classList.contains('hidden');

    // Leaving an event chat for a DM lets go of the event's pin.
    state.eventCache.ev1 = { id: 'ev1', hostUid: 'a', title: 'Jam', place: 'Lawn', tag: '\u{1F3B5} Music', startTime: now - 6e5, expiresAt: now + 36e5, participantUids: ['a', 'me'], hypedUids: [] };
    window.__stubDocs['events/ev1/pinned/current'] = { messageId: 'p1', senderUid: 'a', text: 'Bring water', by: 'a' };
    chat.openEventChat('ev1');
    await wait(300);
    out.pinInEvent = !document.getElementById('pinnedBar').classList.contains('hidden');
    chat.openChat('b_me', 'b');
    await wait(200);
    window.__fireDoc('events/ev1/pinned/current');
    await wait(100);
    out.noPinInDm = document.getElementById('pinnedBar').classList.contains('hidden');
    chat.closeChat({ silent: true });

    return { out };
  });
  ok('a draft stays with its own chat, never in another one', c.out.boxEmptyInB && c.out.draftBackInA, JSON.stringify(c.out));
  ok('the inbox says Draft, and sending clears it', c.out.inboxSaysDraft && c.out.draftGoneAfterSend, JSON.stringify(c.out));
  ok('Enter on a keyboard still composing a word sends nothing', c.out.imeNoSend, JSON.stringify(c.out));
  ok('reading back up: a new message does not move you, it tells you', c.out.stayedPut && c.out.pill, JSON.stringify(c.out));
  ok('and them typing does not drag you down either', c.out.typingNoYank, JSON.stringify(c.out));
  ok('your own message always comes into view, and the pill goes', c.out.ownSendChases && c.out.pillGone, JSON.stringify(c.out));
  ok('an event\'s pin never follows you into a private chat', c.out.pinInEvent && c.out.noPinInDm, JSON.stringify(c.out));

  // Pop-ups: only a new message, never a typing change; and never muted.
  const pop = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const chat = await import('/js/services/chatService.js');
    const { state } = await import('/js/state/store.js');
    // showNotification paints a toast with the sender's name; count those.
    const seen = () => [...(document.getElementById('toastBox')?.children || [])].filter((x) => /see you at 6|New message from B/.test(x.textContent || '')).length;
    const d = window.__stubDocs['chats/b_me'];
    Object.assign(d, { unreadByUid: '', lastMsgId: 'y0' });
    // The first snapshot names every chat as added, the way Firestore's does.
    window.__nextChanges = [{ type: 'added', doc: { id: 'b_me', data: () => d } }];
    chat.loadChatList();
    await wait(250);
    // Patch the snapshot so docChanges reports what changed.
    const fireModified = async () => {
      window.__nextChanges = [{ type: 'modified', doc: { id: 'b_me', data: () => d } }];
      window.__fireColl('chats');
      await wait(150);
    };
    Object.assign(d, { lastMsgId: 'y1', lastText: 'see you at 6', lastSenderUid: 'b', unreadByUid: 'me', unreadCount: 1, lastUpdated: Date.now() });
    await fireModified();
    const afterNew = seen();
    await wait(4600);
    d.typingUid = 'b';
    await fireModified();
    const afterTyping = seen();
    // Muted: a new message makes no pop-up.
    localStorage.setItem('livesociya.muted', JSON.stringify({ b_me: Date.now() }));
    Object.assign(d, { lastMsgId: 'y2', lastText: 'see you at 6 sharp', typingUid: '' });
    await wait(4600);
    await fireModified();
    const afterMuted = seen();
    localStorage.removeItem('livesociya.muted');
    return { afterNew, afterTyping, afterMuted };
  });
  ok('a pop-up for a new message, with what they said', pop.afterNew >= 1, JSON.stringify(pop));
  ok('but not again because they started typing', pop.afterTyping === 0, JSON.stringify(pop));
  ok('and never from a muted chat', pop.afterMuted === 0, JSON.stringify(pop));
  ok('and nothing in the chat errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('messages over several lines, and a box that stops at four');
for (const view of [{ w: 320, h: 640, touch: true }, { w: 390, h: 800, touch: true }, { w: 1280, h: 800, touch: false }]) {
  const ctx = await browser.newContext({ viewport: { width: view.w, height: view.h }, hasTouch: view.touch, isMobile: view.touch });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 120)); });
  await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);
  const r = await p.evaluate(async (touch) => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const chat = await import('/js/services/chatService.js');
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.privacyChosen = true;
    state.userCache = { me: { uid: 'me', username: 'me_h', displayName: 'Me', avatar: '\u{1F43C}', following: [] },
                        a: { uid: 'a', username: 'a', displayName: 'A', avatar: '\u{1F98A}', following: [] } };
    state.following = []; state.orbitUids = [];
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');
    const now = Date.now();
    window.__stubDocs['chats/a_me'] = { userUids: ['a', 'me'], status: 'unlocked', lastUpdated: now, unreadByUid: '', initiatedByUid: 'a' };
    for (let i = 0; i < 12; i++) window.__stubDocs['chats/a_me/messages/m' + String(i).padStart(2, '0')] = { senderUid: i % 2 ? 'a' : 'me', text: 'hello ' + i, time: now - (20 - i) * 60000 };
    chat.openChat('a_me', 'a');
    await wait(500);
    const out = {};
    const ta = document.getElementById('msgInput');
    const type = (v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); };
    out.isTextarea = ta.tagName === 'TEXTAREA';
    type('one line');
    const h1 = ta.offsetHeight;
    type('one\ntwo\nthree');
    const h3 = ta.offsetHeight;
    type('1\n2\n3\n4\n5\n6\n7\n8\n9');
    const h9 = ta.offsetHeight;
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    out.grows = h3 > h1 + lh * 1.5;
    out.capsAtFour = Math.abs(h9 - (h1 + lh * 3)) <= 3 && ta.classList.contains('capped') && ta.scrollHeight > ta.clientHeight + 10;
    out.notCappedBelow = (type('a\nb'), !ta.classList.contains('capped'));
    // Nothing leaves the screen with the box at its tallest.
    type('1\n2\n3\n4\n5\n6\n7\n8\n9');
    await wait(50);
    const send = document.getElementById('sendBtn').getBoundingClientRect();
    const field = document.querySelector('.composer-field').getBoundingClientRect();
    const box = document.getElementById('messages').getBoundingClientRect();
    out.onScreen = send.bottom <= innerHeight + 1 && field.bottom <= innerHeight + 1 && send.right <= innerWidth + 1 && field.left >= -1;
    out.threadStillThere = box.height > 120;
    out.pageNotWider = document.documentElement.scrollWidth <= innerWidth;
    // Enter: sends with a keyboard, new line on a phone; Shift+Enter never sends.
    type('first\nsecond');
    const w0 = window.__writes;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await wait(60);
    out.shiftEnterKeeps = window.__writes === w0 && ta.value === 'first\nsecond';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(200);
    out.enter = window.__writes > w0 ? 'sent' : 'kept';
    if (out.enter === 'kept') await chat.sendMessage();
    await wait(100);
    out.shrinksAfterSend = ta.value === '' && Math.abs(ta.offsetHeight - h1) <= 2;
    // What went out, and how it reads.
    type('one\ntwo  \n\n\n\n\nthree <b>x</b>\nhttps://youtu.be/dQw4w9WgXcQ');
    await chat.sendMessage();
    await wait(80);
    const sent = Object.keys(window.__stubDocs).filter((k) => k.startsWith('chats/a_me/messages/gen')).map((k) => window.__stubDocs[k]).sort((a, b) => a.time - b.time);
    const last = sent[sent.length - 1] || {};
    out.cleaned = last.text === 'one\ntwo\n\nthree <b>x</b>\nhttps://youtu.be/dQw4w9WgXcQ';
    out.previewFlat = !/\n/.test(window.__stubDocs['chats/a_me'].lastText || '\n');
    window.__fireColl('chats/a_me/messages');
    await wait(300);
    const bubbles = [...document.querySelectorAll('#messages .msg-sent .msg-text')];
    const b = bubbles[bubbles.length - 1];
    out.breaks = b ? b.querySelectorAll(':scope > br').length : -1;
    out.escaped = b ? !b.querySelector('b') && /<b>x<\/b>/.test(b.textContent) : false;
    out.embed = b ? !!b.querySelector('.media-embed.yt iframe') : false;
    out.firstLine = b ? b.textContent.trim().startsWith('one') : false;
    // Editing a message over several lines opens the box at its size.
    const mine = state.liveMessages.filter((m) => m.senderUid === 'me').pop();
    if (mine) { mine.time = Date.now(); mine.sentAt = { toMillis: () => Date.now() }; }
    chat.startEditMessage(mine && mine.id);
    await wait(80);
    out.editGrows = ta.offsetHeight > h1 + lh;
    chat.cancelEdit();
    await wait(30);
    out.editCancelShrinks = Math.abs(ta.offsetHeight - h1) <= 2;
    // Drafts keep their lines.
    type('a draft\nover two lines');
    chat.closeChat({ silent: true });
    chat.openChat('a_me', 'a');
    await wait(300);
    out.draftLines = ta.value === 'a draft\nover two lines' && ta.offsetHeight > h1 + lh * 0.5;
    type('');
    chat.closeChat({ silent: true });
    return out;
  }, view.touch);
  const tag = `${view.w}px${view.touch ? ' (touch)' : ''}`;
  ok(`${tag}: the box grows with each line, and stops at four`, r.isTextarea && r.grows && r.capsAtFour && r.notCappedBelow, JSON.stringify(r));
  ok(`${tag}: at its tallest nothing leaves the screen and the thread keeps its room`, r.onScreen && r.threadStillThere && r.pageNotWider, JSON.stringify(r));
  ok(`${tag}: Shift+Enter is a new line; Enter ${view.touch ? 'is a new line too on a phone' : 'sends'}`,
    r.shiftEnterKeeps && r.enter === (view.touch ? 'kept' : 'sent'), JSON.stringify(r));
  ok(`${tag}: sending empties the box back to one line`, r.shrinksAfterSend, JSON.stringify(r));
  ok(`${tag}: a message keeps its lines, loses the extra blank ones, and the inbox gets one line`, r.cleaned && r.previewFlat && r.breaks === 4 && r.firstLine, JSON.stringify(r));
  ok(`${tag}: it is still escaped, and a link on its own line still embeds`, r.escaped && r.embed, JSON.stringify(r));
  ok(`${tag}: editing and drafts keep their lines too`, r.editGrows && r.editCancelShrinks && r.draftLines, JSON.stringify(r));
  ok(`${tag}: and nothing errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('the rail counts what is on now, the same as the pill');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.addInitScript({ path: fileURLToPath(new URL('./stub.js', import.meta.url)) });
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);
  const r = await p.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const { state } = await import('/js/state/store.js');
    const ev = await import('/js/services/eventsService.js');
    window.__authSingleton.currentUser = { uid: 'me' };
    state.uid = 'me'; state.blockedUids = []; state.userCache = { me: { uid: 'me', username: 'me', displayName: 'Me' }, a: { uid: 'a', username: 'a', displayName: 'A' } };
    state.following = []; state.orbitUids = [];
    document.getElementById('loading-screen').classList.add('hidden');
    document.querySelector('.app-frame').classList.remove('hidden');
    window.switchScreen('home');
    const now = Date.now(), H = 36e5;
    const mk = (id, s, e) => ({ id, hostUid: 'a', title: id, place: 'x', tag: '☕ Chill', startTime: s, expiresAt: e, participantUids: ['a'], hypedUids: [], pendingUids: [], unconfirmedUids: [], circleId: 'main' });
    window.__events = [mk('on1', now - 6e5, now + H), mk('soon1', now + H, now + 2 * H), mk('soon2', now + 5 * H, now + 6 * H)];
    ev.loadEvents();
    await wait(1600);
    const out = { live: document.getElementById('railLiveCount')?.dataset.value || document.getElementById('railLiveCount')?.innerText };
    const card = () => ({ title: document.getElementById('railPeopleTitle')?.textContent, text: document.getElementById('railPeople')?.innerText || '' });
    // Nobody you know is out: what starts next.
    out.next = card();
    // Someone you follow is at the one that has started.
    state.following = ['a'];
    ev.renderEvents();
    await wait(100);
    out.people = card();
    out.tap = document.querySelector('#railPeople .rail-person')?.getAttribute('onclick') || '';
    // Nothing on at all.
    window.__events = []; state.following = [];
    window.__fireEvents();
    await wait(400);
    out.quiet = card();
    return out;
  });
  ok('"events happening right now" counts only what has started', String(r.live) === '1', JSON.stringify(r));
  ok('the rail\'s last card: who you know is out, and where', r.people.title === 'Your people, out now' && /A/.test(r.people.text) && /at on1/.test(r.people.text) && r.tap.includes("openEventPage('on1')"), JSON.stringify(r));
  ok('nobody out: what starts next; nothing on: a way to start something',
    r.next.title === 'Up next' && /soon1/.test(r.next.text) && r.quiet.title === 'Quiet right now' && /Start something/.test(r.quiet.text), JSON.stringify(r));
  await ctx.close();
}

/* ------------------------------------------------------------------ */
group('overall');
ok('no errors, no native dialogs, all the way through', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
