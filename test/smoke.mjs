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
  const cs = card && getComputedStyle(card, '::before');
  return {
    ids,
    chip: card?.querySelector('.status-chip')?.innerText.trim(),
    liveRing: !!card?.querySelector('.av-ring.live'),
    border: cs && [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
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
ok('a recap card says Ended, not Live', /^Ended/.test(recap.chip || '') && !recap.liveRing, recap.chip);
ok('the recap outline goes all the way round',
   recap.border && recap.border.every((w) => parseFloat(w) >= 1), JSON.stringify(recap.border));
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
group('overall');
ok('no errors, no native dialogs, all the way through', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
