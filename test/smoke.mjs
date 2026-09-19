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
  requiresApproval: false, maxCapacity: null
});

/* ------------------------------------------------------------------ */
group('day one');
await seed({});
const empty = await page.evaluate(() => ({
  heading: document.querySelector('#events .empty-state.first-run h4')?.innerText,
  starters: document.querySelectorAll('#events .starter').length,
  bolt: !!document.querySelector('.fr-spark svg'),
  scroll: document.body.scrollWidth <= document.documentElement.clientWidth
}));
ok('empty feed asks for something', !!empty.heading, empty.heading);
ok('three starters plus start-from-scratch', empty.starters === 4, String(empty.starters));
ok('brand mark is drawn, not an icon font', empty.bolt);
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
  const rows = () => [...document.querySelectorAll('#myProfileEvents .pe-row')];
  const hosted = { n: rows().length, stat: text('statEventsHosted'), tab: text('peHostedCount'),
                   first: rows()[0]?.classList.contains('live') };
  prof.setProfileEventsTab('joined');
  const joined = { n: rows().length, stat: text('statEventsJoined'), tab: text('peJoinedCount'),
                   titles: rows().map((r) => r.querySelector('.pe-title').innerText) };
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

// A small model of the users rules that matter here, so the client is
// tested against refusals and not just against a database that says yes.
await page.evaluate(() => {
  window.__rules = (path, patch) => {
    const m = /^users\/(.+)$/.exec(path);
    if (!m || !patch) return null;
    const target = m[1];
    const doc = window.__stubDocs[path] || {};
    const me = window.__authSingleton.currentUser?.uid;
    const deny = { code: 'permission-denied' };
    const f = patch.followers, r = patch.followRequests;
    if (target !== me && f && f.__op === 'union' && doc.private === true) return deny;
    if (target !== me && r && r.__op === 'union') {
      if (doc.private !== true) return deny;
      if ((doc.followers || []).includes(me)) return deny;
      const last = (window.__updates || []).filter((u) => u.patch?.followRequests?.__op === 'union').pop();
      if (last && Date.now() - last.at < 3000) return deny;
    }
    return null;
  };
});

const priv = await page.evaluate(async () => {
  const { state, follow, prof } = window.__m;
  const users = await import('/js/services/userService.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const docs = window.__stubDocs;
  const person = (u, extra = {}) => Object.assign({ uid: u, username: u, displayName: u.toUpperCase(), avatar: '\u{1F98A}',
    banned: false, followers: [], following: [], followRequests: [] }, extra);
  docs['users/me'] = person('me');
  docs['users/p1'] = person('p1', { private: true });
  docs['users/p2'] = person('p2', { private: true });
  docs['users/pub'] = person('pub');
  state.following = []; state.followRequests = [];
  window.__updates = [];
  const out = {};

  // 1. A stale copy says "open"; the account went private since.
  state.userCache.p1 = { uid: 'p1', username: 'p1', displayName: 'P1', avatar: '', private: false };
  await follow.toggleFollow('p1');
  out.wentPrivateBecameAsk = docs['users/p1'].followRequests.includes('me')
    && !docs['users/p1'].followers.includes('me') && !state.following.includes('p1');

  // 2. Straight away, ask a second private account. Both must stand.
  const t0 = Date.now();
  await follow.toggleFollow('p2');
  out.secondAsk = docs['users/p2'].followRequests.includes('me');
  out.firstStillThere = docs['users/p1'].followRequests.includes('me');
  out.waitedItsTurn = Date.now() - t0 >= 2500;

  // 3. Reload: cache comes back from localStorage only.
  users.rememberUser('p1', docs['users/p1']);
  state.userCache = { me: state.userCache.me };
  users.hydrateProfileCache();
  out.afterReloadStillAsked = follow.hasAskedToFollow('p1') && follow.isPrivateAccount('p1');

  // 4. Tapping "Requested" asks before withdrawing; No keeps it.
  const p = follow.toggleFollow('p1'); await wait(150);
  out.withdrawAsks = !document.getElementById('confirmSheet').classList.contains('hidden');
  window.confirmNo(); await p;
  out.noKeepsRequest = docs['users/p1'].followRequests.includes('me');

  // 5. p2 approves me. My app notices the next time it reads p2.
  docs['users/p2'].followRequests = []; docs['users/p2'].followers = ['me'];
  await users.fetchUser('p2', { force: true }); await wait(50);
  out.approvalHealed = state.following.includes('p2') && docs['users/me'].following.includes('p2');

  // 6. Unfollowing a private account asks first.
  const q = follow.toggleFollow('p2'); await wait(150);
  out.unfollowPrivateAsks = !document.getElementById('confirmSheet').classList.contains('hidden');
  window.confirmYes(); await q;
  out.unfollowed = !state.following.includes('p2') && !docs['users/p2'].followers.includes('me');

  // 7. A public account: one tap, one atomic batch, a double tap is ignored.
  window.__batches = [];
  const a1 = follow.toggleFollow('pub'); const a2 = follow.toggleFollow('pub');
  await a1; await a2;
  out.publicFollow = state.following.includes('pub') && docs['users/pub'].followers.includes('me');
  out.oneBatch = window.__batches.filter((b) => b.join().includes('users/pub')).length === 1;

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
ok('a private account\'s followers are locked to non-followers', priv.listLocked);

const owner = await page.evaluate(async () => {
  const { state, follow } = window.__m;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const docs = window.__stubDocs;
  docs['users/me'] = { uid: 'me', banned: false, private: true, followRequests: ['a', 'b'], following: [] };
  state.userCache.me = Object.assign(state.userCache.me || {}, { followers: [] });
  state.isPrivate = true; state.privacyChosen = true; state.followRequests = ['a', 'b'];
  const out = {};

  // Going public lets the people waiting in.
  const p = follow.setPrivateAccount(false); await wait(150);
  out.asked = !document.getElementById('confirmSheet').classList.contains('hidden');
  window.confirmYes(); await p;
  out.letIn = docs['users/me'].private === false
    && (docs['users/me'].followers || []).join() === 'a,b'
    && docs['users/me'].followRequests.length === 0;

  // Removing a follower.
  state.userCache.me.followers = ['a', 'b'];
  const r = follow.removeFollower('a'); await wait(150);
  window.confirmYes(); await r;
  out.removed = docs['users/me'].followers.join() === 'b';
  return out;
});
ok('going public asks, then lets everyone waiting in', owner.asked && owner.letIn, JSON.stringify(owner));
ok('you can remove a follower', owner.removed);

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
  const person = (u, extra = {}) => Object.assign({ uid: u, username: u, displayName: u.toUpperCase(), avatar: '\u{1F98A}',
    banned: false, followers: [], following: [], followRequests: [], vouchedBy: [] }, extra);
  docs['users/lock'] = person('lock', { private: true, followers: ['x', 'y'], following: ['z'], vouchedBy: ['x'] });
  docs['users/open'] = person('open', { followers: ['x'] });
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
  state.following = ['lock'];
  prof.refreshProfileSocial('lock'); await wait(300);
  out.unlocked = { panel: shown('#profileLocked'), events: shown('.pe-section'), vouches: shown('#statVouchesBox'),
    rows: document.querySelectorAll('#myProfileEvents .pe-row').length,
    orbitBtn: [...document.querySelectorAll('#profileOrbit .orbit-btn')].some((b) => /orbit/i.test(b.innerText)) };
  prof.closeProfileScreen({ all: true }); await wait(200);

  // A public account you don't follow: everything visible, no orbit yet.
  state.following = [];
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
  ok("somebody else's offers only reply and copy", r.theirsNow === 'reply,copy', r.theirsNow);
  ok('past 15 minutes the edit is gone but delete is not', r.mineLate === 'reply,copy,delete', r.mineLate);
  ok('a tombstone offers nothing at all', r.tombstone === 0);
  ok('the window closes exactly at 15 minutes', r.atEdge === true && r.pastEdge === false);
  ok('taking a message back has no clock on it', r.retractLate === true);
  ok('a message already taken back cannot be taken back again', r.retractGone === false);
  ok('the sheet says how long is left', r.label === '12 min left', r.label);
  ok('"edited" shows on an edit, never on a tombstone', r.edited === true && r.editedGone === false);

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
    out.sendBecameTick = !!document.querySelector('#inputWrapper button i.bx-check');

    input.value = 'typo here';
    await window.sendMessage();
    await wait(120);
    const edit = (window.__updates || []).slice(-1)[0] || {};
    out.editKeys = (edit.keys || []).sort().join(',');
    out.editText = edit.patch?.text;
    out.editStamped = typeof edit.patch?.editedAt === 'number';
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
  ok("the sheet offers neither on somebody else's", dom.theirRows === 'reply,copy', dom.theirRows);
  ok('the sheet refuses to open on a tombstone', dom.sheetOnTombstone === false);
  ok('editing loads the message into the box', dom.loadedIntoBox === 'typo heer', dom.loadedIntoBox);
  ok('the composer says it is editing', dom.noteIsEditing === true && dom.sendBecameTick === true,
     JSON.stringify({ n: dom.noteIsEditing, s: dom.sendBecameTick }));
  ok('saving writes only text and editedAt', dom.editKeys === 'editedAt,text', dom.editKeys);
  ok('saving writes the new text, stamped', dom.editText === 'typo here' && dom.editStamped,
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
      // The href has to stay a real link, so the message still means
      // something pasted anywhere else.
      href: card && card.getAttribute('href'),
      otherLinkStillALink: !!box.querySelector('a[href="https://example.com/not-ours"]')
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
  ok('the card is still a real link underneath',
     /livesociya\.com\/\?e=AbC123_-x$/.test(embed.href || ''), embed.href);
  ok('someone else\u2019s link is left alone', embed.otherLinkStillALink);
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
     && /^\d+m$/i.test(tick.statsAfter[1] || ''),
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
    const input = document.querySelector('#chatScreen .chat-footer input');
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
group('overall');
ok('no errors, no native dialogs, all the way through', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
