// ==========================================
// AUTH & IDENTITY
// ==========================================
//
// The Firebase Auth UID is the account. It is created by Google
// sign-in, it never changes, and it is the only thing security rules
// can verify without a database read.
//
// Documents:
//   users/{uid}                  public profile (handle, name, avatar)
//   users/{uid}/private/contact  email — owner-readable only
//   usernames/{handle}           { uid } — the handle reservation
// ==========================================

import { auth, db, isLocalhost } from '../config/firebase.js';
import { state, resetState } from '../state/store.js';
import { switchScreen, setLoading } from '../utils/ui.js';
import { renderAvatar } from '../utils/formatters.js';
import { normalizeUsername } from './userService.js';
import { loadEvents } from './eventsService.js';
import { loadChatList } from './chatService.js';

const REDIRECT_KEY = "isRedirecting";

export function checkRedirectLock() {
  if (!localStorage.getItem(REDIRECT_KEY)) return;
  setLoading(true);
  setTimeout(() => {
    if (!auth.currentUser) {
      localStorage.removeItem(REDIRECT_KEY);
      setLoading(false);
      switchScreen("login");
    }
  }, 8000);
}

export function loginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  // Optional campus lock: add "hd" to the parameters above with your
  // college domain so the Google account chooser only offers
  // institutional accounts, e.g.
  //   provider.setCustomParameters({ prompt: "select_account", hd: "yourcollege.edu" });
  // Pair it with campusMember() in firestore.rules for real enforcement.

  setLoading(true);

  const onFailure = (error) => {
    localStorage.removeItem(REDIRECT_KEY);
    console.error("Sign-in failed:", error.code || error.message);
    setLoading(false);
    switchScreen("login");
    if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
      showLoginError(describeAuthError(error));
    }
  };

  // WHY TWO PATHS:
  //
  // signInWithRedirect sends the browser to <authDomain>/__/auth/handler
  // and relies on storage on THAT origin to remember the attempt. In
  // production authDomain is your own domain (vercel.json rewrites
  // /__/auth/* through to Firebase), so the handler is same-origin and
  // this works.
  //
  // On localhost there is no such rewrite, so authDomain has to be
  // livesociyaweb.firebaseapp.com — a different origin. Chrome and
  // Safari now partition third-party storage, so the handler cannot
  // read back the state it wrote, and the flow dies on Firebase's
  // "Requested action is invalid" page.
  //
  // A popup keeps the opener alive and hands the credential straight
  // back, so it is immune to that. Firebase recommends exactly this
  // split for local development.
  if (isLocalhost()) {
    auth.signInWithPopup(provider).catch(onFailure);
    return;
  }

  localStorage.setItem(REDIRECT_KEY, "true");
  auth.signInWithRedirect(provider).catch(onFailure);
}

export function describeAuthError(error) {
  const code = String(error?.code || error?.message || "");
  if (code.includes("requests-from-referer") || code.includes("api-key-not-valid")) {
    return "This address isn't allowed to use the app's API key. Add it under Google Cloud Console > Credentials > Website restrictions.";
  }
  if (code.includes("unauthorized-domain")) {
    return "This domain isn't in Firebase > Authentication > Authorized domains.";
  }
  if (code.includes("invalid-action") || code.includes("argument-error")) {
    return "The sign-in redirect couldn't complete. On localhost the app uses a popup instead — allow popups for this site and try again.";
  }
  if (code.includes("popup-blocked")) {
    return "Your browser blocked the sign-in popup. Allow popups for this site and try again.";
  }
  if (code.includes("network-request-failed")) {
    return "Network error reaching Firebase. Check your connection.";
  }
  return "Sign-in failed. Open the browser console for the exact error.";
}

function showLoginError(message) {
  const card = document.querySelector("#login .card");
  if (!card) return;
  let box = document.getElementById("loginError");
  if (!box) {
    box = document.createElement("p");
    box.id = "loginError";
    box.style.cssText = "margin-top:16px; font-size:13px; line-height:1.5; color: var(--danger); font-weight:600;";
    card.appendChild(box);
  }
  box.innerText = message;
}

function showLoggedOut() {
  switchScreen("login");
  document.getElementById("topAvatar")?.classList.add("hidden");
  setLoading(false);
}

export function initAuthListener() {
  // Firebase never resolves onAuthStateChanged if the identity API call
  // itself is rejected (blocked referrer, dead network, offline campus
  // wifi). Without this the app sits on the loading spinner forever.
  let authResolved = false;
  setTimeout(() => {
    if (authResolved) return;
    console.error(
      "Firebase Auth never responded. Common causes:\n" +
      " - This origin is not in the API key's website restrictions\n" +
      "   (Google Cloud Console > APIs & Services > Credentials)\n" +
      " - This domain is not in Firebase > Authentication > Authorized domains\n" +
      " - No network connection"
    );
    showLoggedOut();
    showLoginError("Couldn't reach the sign-in service. Check your connection and try again.");
  }, 10000);

  const markResolved = () => { authResolved = true; };

  auth.getRedirectResult()
    .then((result) => {
      localStorage.removeItem(REDIRECT_KEY);
      if (!result?.user && !auth.currentUser) {
        markResolved();
        showLoggedOut();
      }
    })
    .catch((error) => {
      markResolved();
      localStorage.removeItem(REDIRECT_KEY);
      console.error("Auth error:", error.code || error.message);
      showLoggedOut();
      showLoginError(describeAuthError(error));
    });

  auth.onAuthStateChanged(async (userAuth) => {
    markResolved();
    document.querySelector(".topbar")?.classList.remove("hidden");

    if (!userAuth) {
      resetState();
      if (!localStorage.getItem(REDIRECT_KEY)) showLoggedOut();
      return;
    }

    localStorage.removeItem(REDIRECT_KEY);

    try {
      state.uid = userAuth.uid;
      state.userEmail = userAuth.email || "";

      const userRef = db.collection("users").doc(state.uid);
      let doc = await userRef.get();

      // ---- Bootstrap a brand new account ----
      if (!doc.exists) {
        const fallbackName =
          userAuth.displayName ||
          (userAuth.email ? userAuth.email.split("@")[0] : "Student");

        await userRef.set({
          uid: state.uid,
          displayName: fallbackName.slice(0, 20),
          googlePfp: userAuth.photoURL || "",
          avatar: userAuth.photoURL || "\u{1F464}",
          banned: false,
          joinedAt: Date.now()
        });

        // Email is deliberately NOT in the public profile doc. It lives
        // in a subcollection that only the owner can read.
        await userRef.collection("private").doc("contact").set({
          email: state.userEmail,
          updatedAt: Date.now()
        }).catch(() => {});

        doc = await userRef.get();
      }

      const data = doc.data() || {};

      if (data.banned === true) {
        alert("Your livesociya account has been suspended.");
        await auth.signOut();
        return;
      }

      // Keep the Google photo fresh without touching anything else.
      if (userAuth.photoURL && data.googlePfp !== userAuth.photoURL) {
        userRef.set({ googlePfp: userAuth.photoURL }, { merge: true }).catch(() => {});
        data.googlePfp = userAuth.photoURL;
      }

      // ---- Handle not claimed yet -> onboarding ----
      if (!data.username) {
        document.getElementById("topAvatar")?.classList.add("hidden");
        switchScreen("usernameScreen");
        setLoading(false);
        return;
      }

      initializeUserApp(data);
    } catch (error) {
      console.error("Startup error:", error.code || error.message);
      showLoggedOut();
    }
  });
}

export function initializeUserApp(userData) {
  state.username = userData.username || "";
  state.userDisplayName = userData.displayName || state.username || "Student";
  state.userAvatar = userData.avatar || "\u{1F464}";
  state.googlePfp = userData.googlePfp || "";

  // Own profile is always in the cache, keyed by uid like everyone else.
  state.userCache[state.uid] = {
    uid: state.uid,
    username: state.username,
    displayName: state.userDisplayName,
    avatar: state.userAvatar
  };

  const topAvatarEl = document.getElementById("topAvatar");
  if (topAvatarEl) {
    topAvatarEl.innerHTML = renderAvatar(state.userAvatar);
    topAvatarEl.classList.remove("hidden");
  }

  const sideAvatarEl = document.getElementById("sideAvatar");
  if (sideAvatarEl) sideAvatarEl.innerHTML = renderAvatar(state.userAvatar);
  const sideNameEl = document.getElementById("sideName");
  if (sideNameEl) sideNameEl.innerText = state.userDisplayName;

  history.pushState({ screen: "home" }, "", window.location.pathname);
  switchScreen("home");
  loadChatList();
  loadEvents();
  setLoading(false);
}

// ==========================================
// HANDLE CLAIMING
// ==========================================

export async function checkUsernameAvailability() {
  const input = document.getElementById("newUsername");
  const status = document.getElementById("usernameStatus");
  const btn = document.getElementById("claimBtn");
  if (!input || !status || !btn) return;

  const val = normalizeUsername(input.value);
  input.value = val;

  const block = (text, color) => {
    status.innerText = text;
    status.style.color = color;
    btn.style.background = "var(--ash)";
    btn.style.cursor = "not-allowed";
    btn.disabled = true;
  };

  if (val.length === 0) return block("", "var(--text-muted)");
  if (val.length < 3) return block("Must be at least 3 characters", "var(--text-muted)");

  try {
    const doc = await db.collection("usernames").doc(val).get();
    if (doc.exists) return block("Taken \u{1F614}", "var(--danger)");

    status.innerText = "Available! \u{1F389}";
    status.style.color = "var(--mint)";
    btn.style.background = "var(--lavender)";
    btn.style.cursor = "pointer";
    btn.disabled = false;
  } catch (e) {
    block("Could not check right now", "var(--text-muted)");
  }
}

export async function claimUsername() {
  const input = document.getElementById("newUsername");
  const handle = normalizeUsername(input?.value);
  const btn = document.getElementById("claimBtn");

  if (handle.length < 3) return;
  if (!auth.currentUser) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Claiming...`;
  }

  try {
    const uid = auth.currentUser.uid;
    const handleRef = db.collection("usernames").doc(handle);

    // Step 1 — reserve the handle. The rules only permit CREATE here,
    // so a set() on an existing document is rejected. That is what
    // makes handles unique without any server code: whoever's create
    // lands first owns it, everyone else gets permission-denied.
    const existing = await handleRef.get();
    if (existing.exists) {
      if (existing.data().uid !== uid) throw { code: "handle-taken" };
      // Already ours — a previous attempt reserved it but died before
      // step 2. Fall through and finish the job.
    } else {
      await handleRef.set({ uid, createdAt: Date.now() });
    }

    // Step 2 — stamp it on the profile. The rules re-read
    // usernames/{handle} and refuse this write unless it points at us,
    // so nobody can display a handle they never reserved.
    await db.collection("users").doc(uid).set(
      { username: handle, updatedAt: Date.now() },
      { merge: true }
    );

    const updated = await db.collection("users").doc(uid).get();
    initializeUserApp(updated.data() || {});
  } catch (error) {
    console.error("Claim failed:", error.code || error.message);
    setLoading(false);

    const status = document.getElementById("usernameStatus");
    if (status) {
      status.innerText =
        (error.code === "permission-denied" || error.code === "handle-taken")
          ? "That handle was just taken. Try another."
          : "Could not claim right now. Check your connection.";
      status.style.color = "var(--obsidian)";
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "Join Campus";
    }
  }
}

export function logout() {
  setLoading(true);
  switchScreen(null);
  resetState();

  auth.signOut()
    .then(() => {
      localStorage.clear();
      sessionStorage.clear();
      window.location.href = window.location.origin + "?refresh=" + Date.now();
    })
    .catch(() => {
      setLoading(false);
      alert("Error logging out.");
    });
}
