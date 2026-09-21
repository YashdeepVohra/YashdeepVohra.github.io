// Minimal Firebase compat stand-in so the module graph can boot in a
// sandbox with no network. Enough surface for init + listeners.
window.__stubDocs = {};
window.__writes = 0;
window.__reads = 0;
window.__docs = [];
const noop = () => {};
// serverTimestamp() resolves at WRITE time, into something shaped like
// a real Firestore Timestamp — the app reads stamps through msOf(), so
// a bare number here would not exercise that path at all.
const stamp = (ms = Date.now()) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds: (ms % 1000) * 1e6,
  toMillis: () => ms,
});
// A batch checks its rules ONCE, up front, then applies. Without this
// flag the apply ran every op through window.__rules a second time —
// and a model that records state as it goes (an ask stamping the clock,
// say) then refuses the very write it had just allowed.
let applying = false;
const rules = (path, data, kind) =>
  (!applying && window.__rules) ? window.__rules(path, data, kind) : null;
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
  set: (data, opts) => {
    // The stand-in for firestore.rules is consulted on creates and
    // deletes too now, not just updates — the follow graph is documents
    // being made and unmade, so a model that only saw field patches
    // could not refuse anything that matters.
    const no = rules(path, data, 'set');
    if (no) return Promise.reject(no);
    window.__writes++;
    // Plain values land for real, so a saved document can be checked.
    // This used to be restricted to two-segment users/{uid} paths, which
    // meant nothing under a SUBCOLLECTION was ever stored — and the
    // follow graph lives in users/{uid}/followers/{uid} now.
    if (data && typeof data === 'object' && path) {
      const clean = Object.fromEntries(
        Object.entries(data)
          .map(([k, v]) => [k, v && v.__op === 'now' ? stamp() : v])
          .filter(([, v]) => !(v && v.__op))
      );
      window.__stubDocs[path] = (opts && opts.merge) ? Object.assign(window.__stubDocs[path] || {}, clean) : clean;
    }
    return Promise.resolve();
  },
  update: (patch) => {
    // Optional stand-in for firestore.rules: return an error to refuse.
    const refused = rules(path, patch, 'update');
    if (refused) return Promise.reject(refused);
    window.__writes++;
    window.__updates = window.__updates || [];
    window.__updates.push({ path, keys: Object.keys(patch || {}), patch, at: Date.now() });
    const cur = window.__stubDocs[path];
    if (cur && patch) Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (v && v.__op === 'union') cur[k] = (cur[k] || []).concat([v.v]).filter((x, i, a) => a.indexOf(x) === i);
      else if (v && v.__op === 'remove') cur[k] = (cur[k] || []).filter((x) => x !== v.v);
      else if (v && v.__op === 'inc') cur[k] = (typeof cur[k] === 'number' ? cur[k] : 0) + v.v;
      else if (v && v.__op === 'now') cur[k] = stamp();
      else cur[k] = v;
    });
    return Promise.resolve();
  },
  delete: () => {
    const no = rules(path, null, 'delete');
    if (no) return Promise.reject(no);
    window.__writes++;
    if (path) delete window.__stubDocs[path];
    return Promise.resolve();
  },
  /* A document listener reads the fixture, and can be fired again —
     window.__fireDoc(path). It used to answer "does not exist" always,
     which meant nothing that WATCHES a single document could be tested
     at all: being approved while you sit on somebody's profile is one
     document arriving under them, and that is the whole event. */
  onSnapshot: (cb) => {
    const fire = () => {
      const fixture = window.__stubDocs[path];
      cb({ exists: !!fixture, data: () => fixture || {} });
    };
    setTimeout(fire, 0);
    (window.__docCbs[path] = window.__docCbs[path] || []).push(fire);
    return () => {
      window.__docCbs[path] = (window.__docCbs[path] || []).filter((f) => f !== fire);
    };
  },
  // A subcollection keeps its parent's path. It used to drop it, so
  // `users/me/private/receipt` arrived here as `/receipt` and a
  // fixture keyed on the real path could never be found — which is
  // exactly the kind of bug a stub is supposed to help catch, not
  // create.
  collection: (n) => collRef(n, path),
});
// Fire a generic collection's listeners again, so a test can deliver a
// SECOND snapshot — a new message arriving on a thread already open.
// Load window.__docs with what the query should now return first.
window.__collCbs = {};
window.__docCbs = {};
window.__fireDoc = (path) => {
  (window.__docCbs[path] || []).slice().forEach((f) => f());
};
window.__fireColl = (base) => {
  (window.__collCbs[base] || []).slice().forEach((f) => f());
};

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

// Events queries really filter, order, page and limit — the recap and
// the profile both depend on the query shape, and a stub that returned
// every event for every query hid exactly those bugs.
const eventsColl = () => {
  const spec = { wheres: [], order: null, lim: 0, after: null };
  const run = () => {
    let rows = window.__events.slice().filter((d) => spec.wheres.every(([f, op, v]) => {
      const x = d[f];
      switch (op) {
        case '==': return x === v;
        case '<': return x < v;
        case '<=': return x <= v;
        case '>': return x > v;
        case '>=': return x >= v;
        case 'array-contains': return Array.isArray(x) && x.includes(v);
        default: return true;
      }
    }));
    if (spec.order) {
      const [f, dir] = spec.order;
      rows.sort((a, b) => (dir === 'desc' ? -1 : 1) * ((a[f] || 0) - (b[f] || 0)));
    }
    if (spec.after) {
      const i = rows.findIndex((d) => d.id === spec.after.id);
      if (i !== -1) rows = rows.slice(i + 1);
    }
    if (spec.lim) rows = rows.slice(0, spec.lim);
    return rows.map((d) => ({ id: d.id, data: () => d }));
  };
  const q = {
    where: (f, op, v) => { spec.wheres.push([f, op, v]); return q; },
    orderBy: (f, dir = 'asc') => { spec.order = [f, dir]; return q; },
    limit: (n) => { spec.lim = n; return q; }, limitToLast: () => q,
    startAt: () => q, endAt: () => q, startAfter: (d) => { spec.after = d; return q; }, endBefore: () => q,
    get: () => Promise.resolve(snap(run())),
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

const collRef = (name, parent) => {
  const base = (parent ? parent + '/' : '') + (name || '');
  if (name === 'orbit') return orbitColl();
  if (name === 'events') return eventsColl();
  if (name === 'blocks' && window.__fakeBlocks) {
    const docs = window.__fakeBlocks.map(d => ({ id: d.id, data: () => d }));
    const q2 = { where: () => q2, orderBy: () => q2, limitToLast: () => q2, limit: () => q2,
      endBefore: () => q2, startAfter: () => q2, startAt: () => q2, endAt: () => q2,
      get: () => Promise.resolve(snap(docs)),
      onSnapshot: (cb) => { setTimeout(() => cb(snap(docs)), 0); return noop; },
      doc: (id) => docRef(base + '/' + id), add: () => Promise.resolve({ id: 'x' }) };
    return q2;
  }
  /* The generic collection.
     `window.__docs` is the explicit queue a test can load to answer the
     next query, and it still wins. When it is empty this falls back to
     whatever is actually sitting in __stubDocs directly under this
     path — which is what makes a SUBCOLLECTION behave like one, and
     the follow graph is subcollections now. */
  const spec = { order: null, lim: 0 };
  const fromStore = () => {
    const prefix = base + '/';
    return Object.keys(window.__stubDocs)
      .filter((k) => k.startsWith(prefix) && k.slice(prefix.length).indexOf('/') === -1)
      .map((k) => ({ id: k.slice(prefix.length), __d: window.__stubDocs[k] }));
  };
  const run = () => {
    if (window.__docs.length) return window.__docs.splice(0, window.__docs.length);
    let rows = fromStore();
    if (spec.order) {
      const [f, dir] = spec.order;
      rows.sort((a, b) => (dir === 'desc' ? -1 : 1) * (((a.__d || {})[f] || 0) - ((b.__d || {})[f] || 0)));
    }
    if (spec.lim) rows = rows.slice(0, spec.lim);
    return rows.map((r) => ({ id: r.id, data: () => r.__d }));
  };
  const q = {
    where: () => q, limitToLast: () => q,
    orderBy: (f, dir = 'asc') => { spec.order = [f, dir]; return q; },
    limit: (n) => { spec.lim = n; return q; },
    endBefore: () => q, startAfter: () => q, startAt: () => q, endAt: () => q,
    get: () => Promise.resolve(snap(run())),
    onSnapshot: (cb) => {
      const fire = () => cb(snap(run()));
      setTimeout(fire, 0);
      (window.__collCbs[base] = window.__collCbs[base] || []).push(fire);
      return () => {
        window.__collCbs[base] = (window.__collCbs[base] || []).filter((f) => f !== fire);
      };
    },
    doc: (id) => docRef(base + '/' + id), add: () => Promise.resolve({ id: 'x' }),
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
          // All or nothing, like the real thing.
          const refused = window.__rules
            && ops.map((o) => window.__rules(o.path, o.data, o.kind)).find(Boolean);
          if (refused) return Promise.reject(refused);
          window.__batches = window.__batches || [];
          window.__batches.push(ops.map(o => o.kind + ' ' + o.path));
          // Apply for real, so a batched write is observable like any
          // other — but without re-running the rules, which have just
          // passed on exactly these ops.
          applying = true;
          try {
            ops.forEach((o) => { if (o.ref && typeof o.ref[o.kind] === 'function') o.ref[o.kind](o.data); });
          } finally {
            applying = false;
          }
          window.__lastBatch = ops;
          return Promise.resolve();
        }
      };
    } }),
    { Timestamp: { fromMillis: (ms) => stamp(ms), now: () => stamp() },
      FieldPath: { documentId: () => '__name__' }, FieldValue: { arrayUnion: (v) => ({ __op: 'union', v }), arrayRemove: (v) => ({ __op: 'remove', v }), increment: (v) => ({ __op: 'inc', v }), serverTimestamp: () => ({ __op: 'now' }), delete: () => ({ __op: 'delete' }) } }),
};
