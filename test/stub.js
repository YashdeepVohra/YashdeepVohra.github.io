// Minimal Firebase compat stand-in so the module graph can boot in a
// sandbox with no network. Enough surface for init + listeners.
window.__stubDocs = {};
window.__writes = 0;
window.__reads = 0;
window.__docs = [];
const noop = () => {};
const snap = (docs = []) => ({
  _c: (window.__reads += docs.length),
  forEach: (f) => docs.forEach(f),
  docChanges: () => [],
  docs, size: docs.length, empty: docs.length === 0,
});
const docRef = (path) => ({
  __path: path || '?',
  id: (path || 'x').split('/').pop() || 'genid',
  get: () => {
    window.__reads++;
    window.__readPaths = window.__readPaths || [];
    window.__readPaths.push(path || '?');
    const fixture = window.__stubDocs[path];
    return Promise.resolve({ exists: !!fixture, data: () => fixture || {} });
  },
  set: () => { window.__writes++; return Promise.resolve(); },
  update: (patch) => {
    window.__writes++;
    const cur = window.__stubDocs[path];
    if (cur && patch) Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (v && v.__op === 'union') cur[k] = (cur[k] || []).concat([v.v]).filter((x, i, a) => a.indexOf(x) === i);
      else if (v && v.__op === 'remove') cur[k] = (cur[k] || []).filter((x) => x !== v.v);
      else cur[k] = v;
    });
    return Promise.resolve();
  },
  delete: () => { window.__writes++; return Promise.resolve(); },
  onSnapshot: (cb) => { setTimeout(() => cb({ exists: false, data: () => ({}) }), 0); return noop; },
  collection: () => collRef(),
});
window.__orbit = [];
window.__orbitCbs = [];
const orbitDocs = () => window.__orbit.map((d) => ({ id: d.id, data: () => d }));
window.__fireOrbit = () => { window.__orbitCbs.forEach((cb) => cb(snap(orbitDocs()))); };

const orbitColl = () => {
  const q = {
    where: () => q, orderBy: () => q, limit: () => q, limitToLast: () => q,
    startAt: () => q, endAt: () => q, startAfter: () => q, endBefore: () => q,
    get: () => Promise.resolve(snap(orbitDocs())),
    onSnapshot: (cb) => {
      window.__orbitCbs.push(cb);
      setTimeout(() => cb(snap(orbitDocs())), 0);
      return () => { window.__orbitCbs = window.__orbitCbs.filter((c) => c !== cb); };
    },
    doc: (id) => ({
      get: () => {
        window.__reads++;
        const f = window.__orbit.find((d) => d.id === id);
        return Promise.resolve({ exists: !!f, data: () => f || {} });
      },
      set: (data) => {
        window.__writes++;
        window.__orbit = window.__orbit.filter((d) => d.id !== id);
        window.__orbit.push(Object.assign({ id }, data));
        window.__fireOrbit();
        return Promise.resolve();
      },
      update: (patch) => {
        window.__writes++;
        const f = window.__orbit.find((d) => d.id === id);
        if (!f) return Promise.reject({ code: 'not-found' });
        Object.assign(f, patch);
        window.__fireOrbit();
        return Promise.resolve();
      },
      delete: () => {
        window.__writes++;
        window.__orbit = window.__orbit.filter((d) => d.id !== id);
        window.__fireOrbit();
        return Promise.resolve();
      },
    }),
  };
  return q;
};

window.__events = [];
window.__eventCbs = [];
const eventDocs = () => window.__events.map((d) => ({ id: d.id, data: () => d }));
window.__fireEvents = () => { window.__eventCbs.forEach((cb) => cb(snap(eventDocs()))); };

const eventsColl = () => {
  const q = {
    where: () => q, orderBy: () => q, limit: () => q, limitToLast: () => q,
    startAt: () => q, endAt: () => q, startAfter: () => q, endBefore: () => q,
    get: () => Promise.resolve(snap(eventDocs())),
    onSnapshot: (cb) => {
      window.__eventCbs.push(cb);
      setTimeout(() => cb(snap(eventDocs())), 0);
      return () => { window.__eventCbs = window.__eventCbs.filter((c) => c !== cb); };
    },
    doc: (id) => docRef('events/' + (id || 'gen' + Math.random().toString(36).slice(2, 8))),
    add: (data) => {
      const id = 'gen' + Math.random().toString(36).slice(2, 8);
      window.__events.push(Object.assign({ id }, data));
      window.__writes++;
      window.__fireEvents();
      return Promise.resolve({ id });
    }
  };
  return q;
};

const collRef = (name) => {
  if (name === 'orbit') return orbitColl();
  if (name === 'events') return eventsColl();
  if (name === 'blocks' && window.__fakeBlocks) {
    const docs = window.__fakeBlocks.map(d => ({ id: d.id, data: () => d }));
    const q2 = { where: () => q2, orderBy: () => q2, limitToLast: () => q2, limit: () => q2,
      endBefore: () => q2, startAfter: () => q2, startAt: () => q2, endAt: () => q2,
      get: () => Promise.resolve(snap(docs)),
      onSnapshot: (cb) => { setTimeout(() => cb(snap(docs)), 0); return noop; },
      doc: (id) => docRef((name || '') + '/' + id), add: () => Promise.resolve({ id: 'x' }) };
    return q2;
  }
  const q = {
    where: () => q, orderBy: () => q, limitToLast: () => q, limit: () => q,
    endBefore: () => q, startAfter: () => q, startAt: () => q, endAt: () => q,
    get: () => Promise.resolve(snap(window.__docs.splice(0, window.__docs.length))),
    onSnapshot: (cb) => { setTimeout(() => cb(snap(window.__docs.splice(0, window.__docs.length))), 0); return noop; },
    doc: (id) => docRef((name || '') + '/' + id), add: () => Promise.resolve({ id: 'x' }),
  };
  return q;
};
window.firebase = {
  initializeApp: noop,
  auth: Object.assign(() => (window.__authSingleton = window.__authSingleton || {
    setPersistence: () => Promise.resolve(),
    getRedirectResult: () => Promise.resolve({ user: null }),
    onAuthStateChanged: (cb) => { setTimeout(() => cb(null), 10); return noop; },
    signInWithRedirect: () => Promise.resolve(),
    signInWithPopup: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    currentUser: null,
  }), { GoogleAuthProvider: function () { this.setCustomParameters = noop; }, Auth: { Persistence: { LOCAL: 'local' } } }),
  firestore: Object.assign(() => ({ enablePersistence: () => Promise.resolve(), collection: (n) => collRef(n), doc: (p) => docRef(p), batch: () => {
      const ops = [];
      const rec = (kind) => (ref, data) => { ops.push({ kind, ref, path: (ref && ref.__path) || '?', data }); return undefined; };
      return {
        set: rec('set'), update: rec('update'), delete: rec('delete'),
        commit: () => {
          window.__batches = window.__batches || [];
          window.__batches.push(ops.map(o => o.kind + ' ' + o.path));
          // Apply for real, so a batched write is observable like any other.
          ops.forEach((o) => { if (o.ref && typeof o.ref[o.kind] === 'function') o.ref[o.kind](o.data); });
          window.__lastBatch = ops;
          return Promise.resolve();
        }
      };
    } }),
    { FieldPath: { documentId: () => '__name__' }, FieldValue: { arrayUnion: (v) => ({ __op: 'union', v }), arrayRemove: (v) => ({ __op: 'remove', v }), serverTimestamp: () => ({ __op: 'now' }) } }),
};
