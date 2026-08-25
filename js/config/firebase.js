// ==========================================
// FIREBASE CONFIGURATION & INITIALIZATION
// ==========================================
export const firebaseConfig = {
  apiKey: "AIzaSyBvcJJ2wz2yteRUYdasRUe8oaTt_Vp9kGQ",
  authDomain: window.location.hostname,
  projectId: "livesociyaweb",
  storageBucket: "livesociyaweb.firebasestorage.app",
  messagingSenderId: "676740518716",
  appId: "1:676740518716:web:c552e59b56a93f5a35c439"
};

try {
  firebase.initializeApp(firebaseConfig);
} catch (e) {
  console.error("Firebase not initialized!", e);
}

export const auth = firebase.auth();
export const db = firebase.firestore();

// Emergency Fix: Unregister rogue service workers
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (let registration of registrations) {
      registration.unregister();
    }
  });
}
