import { auth, db } from '../config/firebase.js';
import { state } from '../state/store.js';
import { switchScreen } from '../utils/ui.js';
import { renderAvatar } from '../utils/formatters.js';
import { loadEvents } from './eventsService.js';
import { loadChatList } from './chatService.js';

export function checkRedirectLock() {
  const isRedirecting = localStorage.getItem("isRedirecting");
  if (isRedirecting) {
    document.getElementById("loading-screen")?.classList.remove("hidden");
    setTimeout(() => {
      if (!auth.currentUser) {
        localStorage.removeItem("isRedirecting");
        document.getElementById("loading-screen")?.classList.add("hidden");
        switchScreen("login");
      }
    }, 8000);
  }
}

export function loginWithGoogle() {
  const loader = document.getElementById("loading-screen");
  if (loader) loader.classList.remove("hidden");
  localStorage.setItem("isRedirecting", "true");
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithRedirect(provider);
}

export function initAuthListener() {
  auth.getRedirectResult().then((result) => {
    localStorage.removeItem("isRedirecting");
    if (!result?.user && !auth.currentUser) {
      switchScreen("login");
      document.getElementById("topAvatar")?.classList.add("hidden");
      document.getElementById("loading-screen")?.classList.add("hidden");
    }
  }).catch((error) => {
    localStorage.removeItem("isRedirecting");
    console.error("Auth Error:", error);
    switchScreen("login");
    document.getElementById("loading-screen")?.classList.add("hidden");
  });

  auth.onAuthStateChanged(async (userAuth) => {
    document.querySelector(".topbar")?.classList.remove("hidden");

    if (userAuth) {
      localStorage.removeItem("isRedirecting");
      try {
        state.userEmail = userAuth.email || userAuth.uid;
        const userRef = db.collection("users").doc(state.userEmail);
        let doc = await userRef.get();

        if (doc.exists && doc.data().banned === true) {
          alert("SECURITY ALERT: Suspended.");
          auth.signOut();
          return;
        }

        if (!doc.exists) {
          let defaultName = userAuth.displayName || (userAuth.email ? userAuth.email.split('@')[0] : "Student");
          await userRef.set({
            name: defaultName,
            googlePfp: userAuth.photoURL || "",
            avatar: userAuth.photoURL || "👤",
            banned: false,
            joinedAt: Date.now(),
            uid: userAuth.uid
          });
          doc = await userRef.get();
        }

        if (!doc.data().username) {
          document.getElementById("topAvatar")?.classList.add("hidden");
          switchScreen("usernameScreen");
          document.getElementById("loading-screen")?.classList.add("hidden");
          return;
        }

        const username = doc.data().username;
        const profileRef = db.collection("users").doc(username);
        let profileDoc = await profileRef.get();

        let finalData = profileDoc.exists ? profileDoc.data() : doc.data();
        finalData.username = username;
        finalData.googlePfp = doc.data().googlePfp || userAuth.photoURL;

        initializeUserApp(finalData);
      } catch (error) {
        console.error("Database Error:", error);
        switchScreen("login");
        document.getElementById("loading-screen")?.classList.add("hidden");
      }
    } else {
      if (!localStorage.getItem("isRedirecting")) {
        switchScreen("login");
        document.getElementById("topAvatar")?.classList.add("hidden");
        document.getElementById("loading-screen")?.classList.add("hidden");
      }
    }
  });
}

export function initializeUserApp(userData) {
  state.user = userData?.username || "Student";
  state.realName = userData?.displayName || userData?.name || "Student";
  state.userAvatar = userData?.avatar || "👤";
  state.googlePfp = userData?.googlePfp || "";

  const topAvatarEl = document.getElementById("topAvatar");
  if (topAvatarEl) {
    topAvatarEl.innerHTML = renderAvatar(state.userAvatar);
    topAvatarEl.classList.remove("hidden");
  }

  db.collection("users").doc(state.user).set({
    displayName: state.realName,
    avatar: state.userAvatar,
    uid: auth.currentUser.uid
  }, { merge: true });

  history.pushState({ screen: 'home' }, '', window.location.pathname);
  switchScreen("home");
  loadChatList();
  loadEvents();
  document.getElementById("loading-screen")?.classList.add("hidden");
}

export async function checkUsernameAvailability() {
  const input = document.getElementById("newUsername");
  const status = document.getElementById("usernameStatus");
  const btn = document.getElementById("claimBtn");
  if (!input || !status || !btn) return;

  let val = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  input.value = val;

  if (val.length === 0) {
    status.innerText = "";
    btn.style.background = "#cbd5e1";
    btn.disabled = true;
    return;
  }
  if (val.length < 3) {
    status.innerText = "Must be at least 3 characters";
    status.style.color = "var(--text-muted)";
    btn.style.background = "#cbd5e1";
    btn.disabled = true;
    return;
  }
  const usernameDoc = await db.collection("usernames").doc(val).get();
  if (usernameDoc.exists) {
    status.innerText = "Taken 😔";
    status.style.color = "var(--danger)";
    btn.style.background = "#cbd5e1";
    btn.disabled = true;
  } else {
    status.innerText = "Available! 🎉";
    status.style.color = "var(--success)";
    btn.style.background = "var(--primary)";
    btn.disabled = false;
  }
}

export async function claimUsername() {
  const chosenName = document.getElementById("newUsername")?.value.trim();
  if (!chosenName) return;

  const btn = document.getElementById("claimBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Claiming...`;
  }

  try {
    await db.collection("usernames").doc(chosenName).set({ email: state.userEmail });
    await db.collection("users").doc(state.userEmail).set({
      username: chosenName,
      uid: auth.currentUser.uid
    }, { merge: true });

    const updatedDoc = await db.collection("users").doc(state.userEmail).get();
    if (document.getElementById("home").classList.contains("hidden")) {
      initializeUserApp(updatedDoc.data());
    }
  } catch (error) {
    if (error.code === 'permission-denied' || error.message.includes('already exists')) {
      console.log("Ignore: Double-tap trigger.");
    } else {
      console.error("Critical Error:", error);
      alert("Error claiming username. Check your connection.");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = "Claim";
      }
    }
  }
}

export function logout() {
  const loader = document.getElementById("loading-screen");
  if (loader) loader.classList.remove("hidden");
  switchScreen(null);
  auth.signOut().then(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = window.location.origin + "?refresh=" + new Date().getTime();
  }).catch(() => {
    alert("Error logging out.");
  });
}
