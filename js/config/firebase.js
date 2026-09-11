// ==========================================
// FIREBASE CONFIGURATION & INITIALIZATION
// ==========================================
//
// SECURITY NOTE — READ THIS BEFORE TRYING TO "HIDE" THIS FILE.
//
// A Firebase Web apiKey is NOT a secret. It is a public project
// identifier, exactly like a URL. It ships inside every client bundle
// of every Firebase web app on the internet, and anyone can read it
// from DevTools in two seconds. Moving it to an .env file, a build
// variable, or a separate repo changes nothing — the value still ends
// up in the JavaScript the browser downloads.
//
// What ACTUALLY protects your data:
//   1. firestore.rules      -> who can read/write which document (see ../firestore.rules)
//   2. Firebase App Check   -> blocks requests from outside your real app
//   3. Authorized domains   -> Auth console > Settings > Authorized domains
//   4. Sign-in restriction  -> limit Google sign-in to your college domain
//
// This file is separate from app logic for ORGANIZATION, which is a
// good reason on its own. Just don't mistake it for a security control.
// ==========================================

export function isLocalhost() {
  return ["localhost", "127.0.0.1", "[::1]", ""].includes(window.location.hostname);
}

export const firebaseConfig = {
  apiKey: "AIzaSyBvcJJ2wz2yteRUYdasRUe8oaTt_Vp9kGQ",
  // In production this is window.location.hostname on purpose:
  // vercel.json rewrites /__/auth/* to the Firebase-hosted handler, so
  // the Google redirect finishes on your own domain instead of
  // *.firebaseapp.com. That rewrite does NOT exist on your laptop, so
  // local development has to use the real Firebase auth domain or
  // sign-in dead-ends. Every domain you serve from must also be listed
  // under Firebase Console > Authentication > Settings > Authorized
  // domains ("localhost" is there by default).
  authDomain: isLocalhost() ? "livesociyaweb.firebaseapp.com" : window.location.hostname,
  projectId: "livesociyaweb",
  storageBucket: "livesociyaweb.firebasestorage.app",
  messagingSenderId: "676740518716",
  appId: "1:676740518716:web:c552e59b56a93f5a35c439"
};

try {
  firebase.initializeApp(firebaseConfig);
} catch (e) {
  console.error("Firebase failed to initialize:", e);
}

export const auth = firebase.auth();
export const db = firebase.firestore();

// ---------------------------------------------------------------------
// OFFLINE CACHE
//
// Firestore keeps documents in IndexedDB and re-attaches listeners with
// a resume token, so a repeat visit is served from disk and only
// CHANGED documents come down the wire. Two effects, both good:
//
//   - a billed read per document becomes a billed read per document
//     that actually changed since you last looked
//   - the feed paints from disk before the network answers, so the app
//     opens instantly on bad campus wifi instead of showing skeletons
//
// synchronizeTabs keeps it working when someone has the app open twice.
// It can legitimately fail — a browser that doesn't support IndexedDB,
// or Safari private mode — and the app is fully functional without it,
// so a failure is a warning, never an error.
//
// Must run before any other Firestore call; nothing else touches the
// database until auth resolves, which is later.
// ---------------------------------------------------------------------
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  const reason = err && err.code === "failed-precondition"
    ? "another tab already owns the cache"
    : err && err.code === "unimplemented"
      ? "this browser doesn't support it"
      : err && err.message;
  console.warn("Offline cache off (" + reason + ") — the app still works, just does more network reads.");
});

// Shorthands for Firestore sentinels, so services don't reach for the
// global `firebase` object everywhere.
export const FieldValue = firebase.firestore.FieldValue;
export const FieldPath = firebase.firestore.FieldPath;

// Keep the session alive across tabs/reloads on shared campus machines
// only as long as the browser session lasts is NOT what we want here —
// LOCAL keeps students logged in on their own phones.
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// Clean up any stale service workers from earlier versions of the app.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) registration.unregister();
  }).catch(() => {});
}
