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
import { clearReceipt } from './receiptService.js';
import { switchScreen, setLoading, toast } from '../utils/ui.js';
import { clearOverlays, openOverlay } from '../utils/overlays.js';
import { renderAvatar } from '../utils/formatters.js';
import { normalizeUsername, hydrateProfileCache, rememberUser, clearProfileCache } from './userService.js';
import { loadEvents, renderEvents } from './eventsService.js';
import { loadBlocks } from './blockService.js';
import { loadOrbit } from './orbitService.js';
import { loadMyProfile } from './followService.js';
import { refreshSocialUI } from '../utils/ui.js';
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
      clearReceipt();
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
        toast("Your livesociya account has been suspended.");
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
  state.following = Array.isArray(userData.following) ? userData.following : [];
  state.followRequests = Array.isArray(userData.followRequests) ? userData.followRequests : [];
  state.isPrivate = userData.private === true;
  state.privacyChosen = typeof userData.private === "boolean";

  // Names and avatars saved on a previous visit go back into the cache
  // before anything renders, so the first paint costs zero reads.
  hydrateProfileCache();

  // Own profile is always in the cache, keyed by uid like everyone else.
  state.userCache[state.uid] = {
    uid: state.uid,
    username: state.username,
    displayName: state.userDisplayName,
    avatar: state.userAvatar
  };
  rememberUser(state.uid, state.userCache[state.uid]);

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

  // Accounts made before sign-up asked are asked once, after the feed
  // has had a moment to appear. Dismissing it just asks again next time.
  if (!state.privacyChosen) {
    setTimeout(() => { if (state.uid && !state.privacyChosen) openOverlay("accountTypeSheet"); }, 1200);
  }

  // Blocks first: everything else filters against this list, and a
  // block must take effect the moment it changes, not on next load.
  loadBlocks(() => {
    renderEvents();
    loadChatList();
  });

  // Orbit state is on screen in four places at once — the feed's trust
  // chips, search results, whichever profile is open, and the Orbit
  // screen itself. They all repaint together, or they disagree.
  loadOrbit(() => refreshSocialUI());

  // Somebody asking to follow you writes it into YOUR profile, so your
  // own document has to be watched or the request never arrives.
  loadMyProfile(() => refreshSocialUI());

  loadChatList();
  loadEvents();
  setLoading(false);
}

// ==========================================
// HANDLE CLAIMING
// ==========================================

// Typing "yashdeep" fired eight document reads, one per keystroke, with
// nothing between the keyboard and Firestore. Wait for them to stop.
let handleCheck = 0;
/* ---------------------------------------------------------------------
   Public or private, chosen at sign-up
   ---------------------------------------------------------------------
   Every account used to start public with the choice buried in
   Settings, so most people never knew there was one. It is asked on
   the same screen as the handle now, and Join stays off until both are
   answered. It goes into the same write that claims the handle.
   ------------------------------------------------------------------- */

let chosenType = "";
let handleIsFree = false;

function syncClaimButton() {
  const btn = document.getElementById("claimBtn");
  if (btn) btn.disabled = !(handleIsFree && chosenType);
}

export function pickAccountType(el, type) {
  if (type !== "public" && type !== "private") return;
  chosenType = type;
  document.querySelectorAll("#claimTypePicker .type-card").forEach((card) => {
    const on = card.dataset.type === type;
    card.classList.toggle("selected", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  });
  syncClaimButton();
}

export function checkUsernameAvailability() {
  clearTimeout(handleCheck);
  const input = document.getElementById("newUsername");
  if (input) input.value = normalizeUsername(input.value);
  handleIsFree = false;
  syncClaimButton();
  handleCheck = setTimeout(runHandleCheck, 350);
}

async function runHandleCheck() {
  const input = document.getElementById("newUsername");
  const status = document.getElementById("usernameStatus");
  const btn = document.getElementById("claimBtn");
  if (!input || !status || !btn) return;

  const val = normalizeUsername(input.value);
  input.value = val;

  // The button's look comes from `disabled` and the base stylesheet.
  // It used to be painted by hand, and the "you can have it" colour was
  // --wash — a pale lilac behind white text, which read as MORE
  // disabled than the disabled state. Nothing here sets a colour now.
  const say = (text, tone) => {
    status.innerText = text;
    status.className = "handle-status " + (tone || "");
    handleIsFree = false;
    syncClaimButton();
  };

  if (val.length === 0) return say("");
  if (val.length < 3) return say("A few more characters", "waiting");

  say("Checking\u2026", "waiting");

  try {
    const doc = await db.collection("usernames").doc(val).get();
    // A slower check for an older keystroke must not overwrite a newer one.
    if (normalizeUsername(input.value) !== val) return;

    if (doc.exists) return say("@" + val + " is taken", "taken");

    say("@" + val + " is yours", "free");
    handleIsFree = true;
    syncClaimButton();
    if (!chosenType) {
      status.innerText = "@" + val + " is yours \u2014 now pick who can follow you";
    }
  } catch (e) {
    say("Couldn't check just now", "waiting");
  }
}

export async function claimUsername() {
  const input = document.getElementById("newUsername");
  const handle = normalizeUsername(input?.value);
  const btn = document.getElementById("claimBtn");

  if (handle.length < 3) return;
  if (!auth.currentUser) return;
  if (!chosenType) {
    // setLoading(true) was already called by the click handler.
    setLoading(false);
    return;
  }

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
      { username: handle, private: chosenType === "private", updatedAt: Date.now() },
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
      btn.innerHTML = "Join Campus";
      handleIsFree = false;
      syncClaimButton();
      checkUsernameAvailability();
    }
  }
}

export function logout() {
  clearOverlays();
  setLoading(true);
  switchScreen(null);
  resetState();
  clearReceipt();
  clearProfileCache();

  auth.signOut()
    .then(() => {
      // Everything goes except how the screen looks — that belongs to
      // the device, not the account that just signed out.
      let theme = null;
      try { theme = localStorage.getItem("livesociya.theme"); } catch (e) {}
      localStorage.clear();
      sessionStorage.clear();
      try { if (theme) localStorage.setItem("livesociya.theme", theme); } catch (e) {}
      window.location.href = window.location.origin + "?refresh=" + Date.now();
    })
    .catch(() => {
      setLoading(false);
      toast("Error logging out.");
    });
}
