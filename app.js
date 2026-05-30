// ==========================================
// 🔐 THE APPLE-PROOF POPUP AUTHENTICATION
// ==========================================

function switchScreen(screenId) {
  document.getElementById("login")?.classList.add("hidden");
  document.getElementById("home")?.classList.add("hidden");
  document.getElementById("usernameModal")?.classList.add("hidden");
  document.getElementById("profileScreen")?.classList.add("hidden");
  document.getElementById("chatScreen")?.classList.add("hidden");
  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");
}

// 1. Instantly check if we are already logged in
document.getElementById("loading-screen")?.classList.remove("hidden");

// 2. THE POPUP TRIGGER (This bypasses Apple's redirect blocker completely!)
async function loginWithGoogle() {
  const loader = document.getElementById("loading-screen");
  if (loader) loader.classList.remove("hidden");

  try {
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    const provider = new firebase.auth.GoogleAuthProvider();
    
    // 🔥 THE MAGIC BULLET: signInWithPopup
    await auth.signInWithPopup(provider); 
    
    // Once the popup closes, onAuthStateChanged automatically takes over below!
  } catch (error) {
    if (loader) loader.classList.add("hidden");
    // If they close the popup manually, just ignore it. Otherwise, show the error.
    if (error.code !== 'auth/popup-closed-by-user') {
      alert("Login Error: " + error.message);
    }
  }
}

// 3. The Ultimate Gatekeeper (Massively simplified because there are no redirects!)
auth.onAuthStateChanged(async (userAuth) => {
  document.querySelector(".topbar")?.classList.remove("hidden"); 

  if (userAuth) {
    // 🚨 YOU ARE LOGGED IN! 🚨 
    document.getElementById("loading-screen")?.classList.remove("hidden");
    
    try {
      userEmail = userAuth.email || userAuth.uid; 
      const userRef = db.collection("users").doc(userEmail);
      let doc = await userRef.get();
      
      if (doc.exists && doc.data().banned === true) {
        alert("SECURITY ALERT: Your account has been suspended.");
        auth.signOut(); 
        return;
      }
      
      if (!doc.exists) {
        let defaultName = userAuth.displayName || (userAuth.email ? userAuth.email.split('@')[0] : "Student");
        await userRef.set({ name: defaultName, googlePfp: userAuth.photoURL || "", avatar: userAuth.photoURL || "👤", banned: false, joinedAt: Date.now() });
        doc = await userRef.get();
      }

      if (!doc.data().username) {
        document.getElementById("topAvatar")?.classList.add("hidden");
        switchScreen("usernameModal"); 
        document.getElementById("loading-screen")?.classList.add("hidden");
        return; 
      }

      initializeUserApp(doc.data());

    } catch (error) {
      console.error("Database Error:", error); 
      switchScreen("login"); 
      document.getElementById("loading-screen")?.classList.add("hidden");
    }
  } else {
    // NO USER DETECTED.
    // Because we aren't using redirects anymore, if there is no user, we can instantly show the login screen! No waiting!
    switchScreen("login");
    document.getElementById("topAvatar")?.classList.add("hidden");
    document.getElementById("loading-screen")?.classList.add("hidden");
  }
});
