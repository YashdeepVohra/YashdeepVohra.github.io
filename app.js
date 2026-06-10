// ==========================================
// PASTE YOUR FIREBASE CONFIG KEYS HERE!
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBvcJJ2wz2yteRUYdasRUe8oaTt_Vp9kGQ",
  authDomain: window.location.hostname, 
  projectId: "livesociyaweb",
  storageBucket: "livesociyaweb.firebasestorage.app",
  messagingSenderId: "676740518716",
  appId: "1:676740518716:web:c552e59b56a93f5a35c439"
};

try { firebase.initializeApp(firebaseConfig); } catch (e) { console.error("Firebase not initialized!"); }

const auth = firebase.auth();
const db = firebase.firestore();

// 🚨 EMERGENCY FIX: KILL THE ROGUE SERVICE WORKER
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(registrations) {
    for(let registration of registrations) { registration.unregister(); }
  });
}

// 🛡️ SECURITY: XSS SANITIZATION UTILITY
function escapeHTML(str) {
    if (!str) return '';
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 🔥 PRODUCTION IDENTITY MATRIX
let currentUserUid = null;     
let currentUsername = "";      
let userAvatar = "👤";         
let googlePfp = "";           
let realName = "";            

let currentChat = null;        
let currentOtherUser = "";     
let currentChatType = "direct"; 

let messagesUnsubscribe = null;
let chatDocUnsubscribe = null;
let eventsUnsubscribe = null;
let profileEventsUnsubscribe = null;
let chatListUnsubscribe = null; 
let scrollTimeout = null;

let lastMessageTime = 0;
let lastEventTime = 0;
let lastHypeTime = 0;
let lastJoinTime = 0;

let eventIdToManage = null;
let currentSelectedTag = '☕ Chill';
let currentLiveFilter = 'All', currentRecapFilter = 'All';
let currentEventData = null;
let currentProfileView = "";
let userCache = {};            
let replyingToMessage = null;
let typingTimer = null;
let myMessageCount = 0;
let currentChatStatus = "unlocked";
let currentChatInitiator = "";
let currentChatData = null;

function renderAvatar(avatarCode) {
  if (!avatarCode) return "👤";
  if (typeof avatarCode === 'string' && avatarCode.startsWith("http")) {
    const cleanUrl = avatarCode.replace(/"/g, "&quot;");
    return `<img src="${cleanUrl}" referrerpolicy="no-referrer" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">`;
  }
  return avatarCode;
}

// ==========================================
// 🎵 SMART LINK PREVIEWS (Host Validated)
// ==========================================
function formatMessage(text, isMediaOnly = false) {
    let safeText = escapeHTML(text);
    const urlRegex = /(https?:\/\/[^\s]+)/g;

    return safeText.replace(urlRegex, function(urlStr) {
        let cleanUrl = urlStr.replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        let parsedUrl;
        
        try {
            parsedUrl = new URL(cleanUrl);
        } catch (e) {
            return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color: inherit; font-weight: 700; text-decoration: underline; word-break: break-all;">${cleanUrl}</a>`;
        }

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return cleanUrl;
        }

        const hostname = parsedUrl.hostname.toLowerCase();
        const allowedYTHosts = ["youtube.com", "www.youtube.com", "youtu.be"];
        const allowedSpotifyHosts = ["googleusercontent.com", "www.googleusercontent.com"];

        // --- 🔴 YOUTUBE PREVIEW ---
        if (allowedYTHosts.includes(hostname)) {
            let videoId = "";
            if (hostname === "youtu.be") {
                videoId = parsedUrl.pathname.split("/")[1]?.split("?")[0] || "";
            } else {
                videoId = parsedUrl.searchParams.get("v") || "";
            }
            
            const musicRegex = /^[a-zA-Z0-9_-]{11}$/;
            if (videoId && musicRegex.test(videoId)) {
                const margin = isMediaOnly ? "0" : "8px";
                return `${isMediaOnly ? "" : "<br>"}
                        <div style="margin-top: ${margin}; width: 100%; max-width: 280px; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); background: #18181b; position: relative; min-height: 160px;">
                            <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ff0000; font-size: 36px; z-index: 1;">
                                <i class='bx bxl-youtube bx-flashing'></i>
                            </div>
                            <iframe width="100%" height="160" src="https://www.youtube.com/embed/${videoId}" frameborder="0" style="display: block; position: relative; z-index: 2;" allowfullscreen></iframe>
                        </div>`;
            }
        }
        
        // --- 🟢 SPOTIFY PREVIEW ---
        if (allowedSpotifyHosts.includes(hostname)) {
            const margin = isMediaOnly ? "0" : "8px";
            return `${isMediaOnly ? "" : "<br>"}
                    <div style="margin-top: ${margin}; width: 100%; max-width: 280px; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); background: #121212; position: relative; min-height: 152px;">
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #1ed760; font-size: 32px; z-index: 1;">
                            <i class='bx bxl-spotify bx-flashing'></i>
                        </div>
                        <iframe src="${cleanUrl}" width="100%" height="152" frameborder="0" style="display: block; position: relative; z-index: 2;" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
                    </div>`;
        }

        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color: inherit; font-weight: 700; text-decoration: underline; word-break: break-all;">${cleanUrl}</a>`;
    });
}

// ==========================================
// 🔔 IN-APP NOTIFICATION SYSTEM
// ==========================================
function showNotification(senderUid, chatId) {
  if (currentChat === chatId) return;

  let toastBox = document.getElementById("toastBox");
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.id = "toastBox";
    toastBox.style.cssText = "position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999; width: 90%; max-width: 400px; display: flex; flex-direction: column; align-items: center; pointer-events: none;";
    document.body.appendChild(toastBox);
  }

  toastBox.innerHTML = "";
  const displayName = escapeHTML(userCache[senderUid]?.displayName || "Student");

  const toast = document.createElement("div");
  toast.style.cssText = "background: var(--primary); color: white; padding: 14px 20px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); font-size: 14px; font-weight: 600; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
  toast.innerHTML = `<i class='bx bxs-message-rounded-dots' style="font-size: 20px;"></i> New message from ${displayName}`;

  toast.onclick = () => {
    const fallbackName = escapeHTML(userCache[senderUid]?.username || "user");
    openChat(chatId, senderUid, fallbackName);
    toast.style.transform = "translateY(-150%)"; 
    setTimeout(() => toast.remove(), 400);
  };

  toastBox.appendChild(toast);
  void toast.offsetWidth;
  toast.style.transform = "translateY(0)";
  
  setTimeout(() => {
    toast.style.transform = "translateY(-150%)";
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

function formatTime(ms) {
  const messageDate = new Date(ms); const today = new Date(); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const timeString = messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (messageDate.toDateString() === today.toDateString()) return `Today at ${timeString}`;
  if (messageDate.toDateString() === yesterday.toDateString()) return `Yesterday at ${timeString}`;
  return `${messageDate.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeString}`;
}

function toggleTime(element) {
  const currentlyShowing = document.querySelector('.msg-wrapper.show-time');
  if (currentlyShowing && currentlyShowing !== element) currentlyShowing.classList.remove('show-time');
  element.classList.toggle('show-time');
}

let lastTapTime = 0;
function handleMessageTap(event, element, senderUid, encodedText, time) {
    const replyBox = event.target.closest('.msg-replied-to');
    if (replyBox) {
        const targetTime = replyBox.getAttribute('data-target-time');
        if (targetTime) scrollToMessage(targetTime);
        return; 
    }

    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTapTime;
    lastTapTime = currentTime;
    
    if (tapLength < 300 && tapLength > 0) {
        event.preventDefault(); 
        initiateReply(senderUid, decodeURIComponent(encodedText), time);
        if (navigator.vibrate) navigator.vibrate(50); 
    } else {
        toggleTime(element);
    }
}

function switchScreen(screenId) {
  document.getElementById("login")?.classList.add("hidden");
  document.getElementById("home")?.classList.add("hidden");
  document.getElementById("usernameScreen")?.classList.add("hidden");
  document.getElementById("profileScreen")?.classList.add("hidden");
  document.getElementById("chatScreen")?.classList.add("hidden");
  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");

  const bottomNav = document.querySelector(".bottom-nav");
  if (bottomNav) {
      if (screenId === "login" || screenId === "usernameScreen" || !screenId) {
          bottomNav.classList.add("hidden");
      } else {
          bottomNav.classList.remove("hidden");
      }
  }
}

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

function loginWithGoogle() {
  const loader = document.getElementById("loading-screen");
  if (loader) loader.classList.remove("hidden");
  localStorage.setItem("isRedirecting", "true");
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithRedirect(provider);
}

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
    currentUserUid = userAuth.uid;
    
    try {
      const userRef = db.collection("users").doc(currentUserUid);
      let doc = await userRef.get();
      
      if (doc.exists && doc.data().banned === true) { alert("SECURITY ALERT: Suspended."); auth.signOut(); return; }
      
      if (!doc.exists) {
        document.getElementById("topAvatar")?.classList.add("hidden");
        switchScreen("usernameScreen"); 
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
    if (!localStorage.getItem("isRedirecting")) {
      switchScreen("login");
      document.getElementById("topAvatar")?.classList.add("hidden");
      document.getElementById("loading-screen")?.classList.add("hidden"); 
    }
  }
});

function initializeUserApp(userData) {
  currentUsername = userData.username; 
  realName = userData.displayName || userData.username;
  userAvatar = userData.avatar || "👤"; 
  googlePfp = userData.googlePfp || "";
  
  const topAvatarEl = document.getElementById("topAvatar");
  if(topAvatarEl) { topAvatarEl.innerHTML = renderAvatar(userAvatar); topAvatarEl.classList.remove("hidden"); }
  
  history.pushState({ screen: 'home' }, '', window.location.pathname);
  switchScreen("home"); 
  loadChatList(); 
  loadEvents();
  document.getElementById("loading-screen")?.classList.add("hidden");
}

async function checkUsernameAvailability() {
  const input = document.getElementById("newUsername"); const status = document.getElementById("usernameStatus"); const btn = document.getElementById("claimBtn");
  if(!input || !status || !btn) return;
  
  let val = input.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); input.value = val; 
  if (val.length === 0) { status.innerText = ""; btn.style.background = "#cbd5e1"; btn.disabled = true; return; }
  
  if (val.length > 20) { status.innerText = "Too long (Max 20)"; status.style.color = "var(--danger)"; btn.style.background = "#cbd5e1"; btn.disabled = true; return; }
  if (val.length < 3) { status.innerText = "Must be at least 3 characters"; status.style.color = "var(--text-muted)"; btn.style.background = "#cbd5e1"; btn.disabled = true; return; }
  
  const usernameDoc = await db.collection("usernames").doc(val).get();
  if (usernameDoc.exists) { status.innerText = "Taken 😔"; status.style.color = "var(--danger)"; btn.style.background = "#cbd5e1"; btn.disabled = true; } 
  else { status.innerText = "Available! 🎉"; status.style.color = "var(--success)"; btn.style.background = "var(--primary)"; btn.disabled = false; btn.style.cursor = "pointer"; }
}

// 🔥 TRANSACTIONS RUN LOCK: Defeats the unique handle overwrite window
async function claimUsername() {
  const chosenName = document.getElementById("newUsername")?.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''); 
  if (!chosenName || chosenName.length < 3 || chosenName.length > 20) return alert("Invalid Username bounds (3-20 chars).");
  
  const btn = document.getElementById("claimBtn");
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Claiming...`; }

  const usernameRef = db.collection("usernames").doc(chosenName);
  const userRef = db.collection("users").doc(currentUserUid);

  try {
    const defaultName = auth.currentUser.displayName || "Student";
    const defaultPfp = auth.currentUser.photoURL || "👤";

    const userData = { 
        username: chosenName,
        displayName: defaultName,
        avatar: defaultPfp,
        googlePfp: defaultPfp,
        joinedAt: Date.now(),
        updatedAt: Date.now(), 
        uid: currentUserUid,   
        banned: false
    };

    await db.runTransaction(async (transaction) => {
        const usernameDoc = await transaction.get(usernameRef);
        if (usernameDoc.exists) {
            throw new Error("TAKEN");
        }
        transaction.set(usernameRef, { uid: currentUserUid });
        transaction.set(userRef, userData);
    });

    initializeUserApp(userData);
    
  } catch (error) { 
      if (error.message === "TAKEN") {
          alert("Username is already taken! Try another one.");
      } else {
          alert("Registration failed. Please check your internet connection.");
      }
      if (btn) { btn.disabled = false; btn.innerHTML = "Claim"; }
  }
}

function logout() { 
  const loader = document.getElementById("loading-screen"); if (loader) loader.classList.remove("hidden");
  switchScreen(null);
  auth.signOut().then(() => {
    localStorage.clear(); sessionStorage.clear();
    window.location.href = window.location.origin + "?refresh=" + new Date().getTime();
  }).catch((err) => { alert("Error logging out."); }); 
}

function openProfileModal() { document.getElementById("profileModal")?.classList.remove("hidden"); }
function closeProfileModal() { document.getElementById("profileModal")?.classList.add("hidden"); }

function selectAvatar(element, type) {
  let newAvatar = (type === 'google') ? googlePfp : type;
  db.collection("users").doc(currentUserUid).set({ 
      avatar: newAvatar,
      googlePfp: googlePfp,
      updatedAt: Date.now(),
      uid: currentUserUid
  }, { merge: true });
  userAvatar = newAvatar;
  const topAvatar = document.getElementById("topAvatar"); const profAvatar = document.getElementById("profileLargeAvatar");
  if(topAvatar) topAvatar.innerHTML = renderAvatar(userAvatar);
  if(profAvatar) profAvatar.innerHTML = renderAvatar(userAvatar);
  closeProfileModal();
}

function selectTag(element, tag) { document.querySelectorAll('#tagSelector .tag').forEach(t => t.classList.remove('active')); element.classList.add('active'); currentSelectedTag = element.innerText; }
function setLiveFilter(element, tag) { currentLiveFilter = tag; document.querySelectorAll('#liveFilters .filter-pill').forEach(pill => pill.classList.remove('active')); element.classList.add('active'); loadEvents(); }
function setRecapFilter(element, tag) { currentRecapFilter = tag; document.querySelectorAll('#recapFilters .filter-pill').forEach(pill => pill.classList.remove('active')); element.classList.add('active'); loadEvents(); }
function toggleEventDesc(eventId) { const eventCard = document.getElementById(`event-${eventId}`); if(!eventCard) return; eventCard.classList.toggle('expanded'); const btn = eventCard.querySelector('.read-more-btn'); if(btn) btn.innerText = eventCard.classList.contains('expanded') ? "Hide details" : "Read details..."; }
function openCreateScreen() { 
    document.getElementById("createScreen")?.classList.remove("hidden"); 
    const now = new Date(); const inTwoHours = new Date(now.getTime() + (2 * 60 * 60 * 1000)); 
    const formatForInput = (date) => (new Date(date - (date.getTimezoneOffset() * 60000))).toISOString().slice(0, 16); 
    const startEl = document.getElementById("startTime"); const endEl = document.getElementById("endTime"); 
    if(startEl) startEl.value = formatForInput(now); if(endEl) endEl.value = formatForInput(inTwoHours); 
}
function closeCreateScreen() { document.getElementById("createScreen")?.classList.add("hidden"); }

function addEvent() {
  const now = Date.now();
  if (now - lastEventTime < 3000) return alert("Please wait a moment before publishing another event.");
  lastEventTime = now;

  const btn = event.target.closest('button');
  const title = document.getElementById("title")?.value.trim(); 
  const place = document.getElementById("place")?.value.trim(); 
  const description = document.getElementById("description")?.value.trim(); 
  const startTimeStr = document.getElementById("startTime")?.value; 
  const endTimeStr = document.getElementById("endTime")?.value;
  const capacityRaw = document.getElementById("maxCapacity")?.value;
  const maxCapacity = capacityRaw ? parseInt(capacityRaw) : null;

  if (!title || !place || !startTimeStr || !endTimeStr) return alert("Please fill out all event details.");
  if (title.length > 100 || place.length > 100 || (description && description.length > 1000)) return alert("Input length thresholds exceeded.");
  if (maxCapacity !== null && (maxCapacity < 2 || maxCapacity > 500)) return alert("Capacity bounds must run between 2 and 500.");

  if (btn) { btn.disabled = true; btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Publishing...`; }

  const startTimestamp = new Date(startTimeStr).getTime(); 
  const endTimestamp = new Date(endTimeStr).getTime();
  
  if (endTimestamp <= startTimestamp) {
      alert("Your event end time must be AFTER the start time.");
      if (btn) { btn.disabled = false; btn.innerHTML = `Publish to Campus <i class='bx bx-send'></i>`; }
      return;
  }
  
  db.collection("events").add({ 
      title, place, description, 
      tag: currentSelectedTag, 
      hostUsername: currentUsername,
      hostAvatar: userAvatar, 
      startTime: startTimestamp, 
      expiresAt: endTimestamp, 
      participants: [currentUserUid],
      hostUid: currentUserUid,        
      hypedBy: [],                    
      typingUsers: [],                
      maxCapacity: maxCapacity 
  }).then(() => {
      if(document.getElementById("title")) document.getElementById("title").value = ""; 
      if(document.getElementById("place")) document.getElementById("place").value = ""; 
      if(document.getElementById("description")) document.getElementById("description").value = ""; 
      if(document.getElementById("maxCapacity")) document.getElementById("maxCapacity").value = ""; 
      closeCreateScreen();
      if (btn) { btn.disabled = false; btn.innerHTML = `Publish to Campus <i class='bx bx-send'></i>`; }
  }).catch((error) => {
      alert("Failed to publish. Try again.");
      if (btn) { btn.disabled = false; btn.innerHTML = `Publish to Campus <i class='bx bx-send'></i>`; }
  });
}

// ==========================================
// 📅 CAMPUS EVENTS DISCOVERY CORE (XSS Safe)
// ==========================================
function loadEvents() {
  if (eventsUnsubscribe) eventsUnsubscribe(); 
  
  eventsUnsubscribe = db.collection("events").orderBy("startTime", "desc").onSnapshot(async (snapshot) => {
    const liveList = document.getElementById("events"); const recapList = document.getElementById("recapEvents");
    if(!liveList || !recapList) return;
    
    let eventsArray = [];
    let uniqueUids = new Set();
    
    snapshot.forEach(doc => {
        const e = doc.data();
        eventsArray.push({ id: doc.id, ...e });
        uniqueUids.add(e.hostUid); 
        if (e.participants) e.participants.forEach(p => uniqueUids.add(p)); 
    });

    for (let uid of uniqueUids) {
        if (!userCache[uid]) {
            const doc = await db.collection("users").doc(uid).get();
            userCache[uid] = doc.exists ? { uid: uid, ...doc.data() } : { displayName: "Student", avatar: "👤" };
        }
    }

    liveList.innerHTML = ""; recapList.innerHTML = "";
    let activeCount = 0; let recapCount = 0; const currentTime = Date.now(); const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);
    
    eventsArray.forEach(data => {
      const e = data; const id = data.id; const attendeesCount = e.participants ? e.participants.length : 1;
      
      const hostDisplayName = escapeHTML(userCache[e.hostUid]?.displayName || e.hostUsername || "Student");
      const hostLiveAvatar = userCache[e.hostUid]?.avatar || e.hostAvatar || "👤";
      
      const cleanTitle = escapeHTML(e.title);
      const cleanPlace = escapeHTML(e.place);
      const cleanDesc = escapeHTML(e.description);
      const chatClickTitle = cleanTitle.replace(/'/g, "\\'");

      let attendeeNames = "";
      if (e.participants && e.participants.length > 0) {
          const visibleParticipants = e.participants.slice(0, 3);
          attendeeNames = visibleParticipants.map(uid => {
              const pDisplayName = escapeHTML(userCache[uid]?.displayName || "Student");
              return `<span onclick="event.stopPropagation(); openProfileScreen('${uid}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${pDisplayName}</span>`;
          }).join(", ");
          
          if (e.participants.length > 3) {
              const extraCount = e.participants.length - 3;
              attendeeNames += ` <span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">+${extraCount} more</span>`;
          }
      } else {
          attendeeNames = `<span onclick="event.stopPropagation(); openProfileScreen('${e.hostUid}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${hostDisplayName}</span>`;
      }

      const hypeCount = e.hypedBy ? e.hypedBy.length : 0;
      const hasHyped = e.hypedBy && e.hypedBy.includes(currentUserUid); 
      const hypeClass = hasHyped ? "hype-btn active" : "hype-btn";
      const hypeIcon = hasHyped ? "bxs-hot" : "bx-hot";
      const hypeHTML = `<button class="${hypeClass}" onclick="toggleHype('${id}', ${hasHyped})"><i class='bx ${hypeIcon}'></i> ${hypeCount > 0 ? hypeCount : 'Hype'}</button>`;
      
      const isFull = e.maxCapacity && attendeesCount >= e.maxCapacity;
      let capacityHTML = "";
      
      if (e.maxCapacity) {
          const percent = Math.min((attendeesCount / e.maxCapacity) * 100, 100);
          const barColor = isFull ? "var(--danger)" : "var(--primary)";
          capacityHTML = `
            <div style="margin-top: 12px; margin-bottom: 4px;">
              <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">
                <span><i class='bx bx-user'></i> Capacity</span>
                <span style="color: ${isFull ? 'var(--danger)' : 'inherit'}">${attendeesCount} / ${e.maxCapacity} ${isFull ? '(Full)' : ''}</span>
              </div>
              <div style="width: 100%; background: #e2e8f0; border-radius: 4px; height: 6px; overflow: hidden;">
                <div style="width: ${percent}%; background: ${barColor}; height: 100%; border-radius: 4px; transition: width 0.3s;"></div>
              </div>
            </div>`;
      }

      const displayTag = e.tag ? `<div class="event-tag-badge" style="margin-bottom: 0;">${escapeHTML(e.tag)}</div>` : '';
      const displayDesc = e.description ? `<button class="read-more-btn" onclick="toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${cleanDesc}</div>` : '';
      let statusBadge = (currentTime < e.startTime) ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>` : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;
      const avatarHTML = `<div style="display:inline-block; width:24px; height:24px; border-radius:50%; vertical-align:middle; overflow:hidden; border:1px solid var(--border); margin-right:4px;">${renderAvatar(hostLiveAvatar)}</div>`;
      
      const matchesLive = (typeof currentLiveFilter !== 'undefined' ? (currentLiveFilter === 'All' || e.tag === currentLiveFilter) : true);
      const matchesRecap = (typeof currentRecapFilter !== 'undefined' ? (currentRecapFilter === 'All' || e.tag === currentRecapFilter) : true);
      
      if (e.expiresAt > currentTime) {
        if (matchesLive) {
          activeCount++; const hasJoined = e.participants && e.participants.includes(currentUserUid);
          liveList.innerHTML += `
            <div class="event card" id="event-${id}">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; gap: 8px; align-items: center;">${displayTag} ${statusBadge}</div>
                ${hypeHTML}
              </div>
              <div class="event-title">${cleanTitle}</div>
              <div class="event-meta" style="display:flex; align-items:center;">
                ${avatarHTML} <span>${cleanPlace} • hosted by ${hostDisplayName}</span>
              </div>
              ${displayDesc}
              <div class="attendees">
                <i class='bx bx-group'></i> Going (${attendeesCount}): ${attendeeNames}
              </div>
              ${capacityHTML} ${e.hostUid === currentUserUid 
                ? `<div style="display:flex; gap:8px; margin-top:16px;">
                     <button class="join" style="margin-top:0; flex:2;" onclick="openEventChat('${id}', '${chatClickTitle}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
                     <button class="delete-btn" style="margin-top:0; flex:1;" onclick="openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage</button>
                   </div>` 
                : (hasJoined 
                   ? `<div style="display:flex; gap:8px; margin-top:16px;">
                        <button class="join" style="margin-top:0; flex:3;" onclick="openEventChat('${id}', '${chatClickTitle}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
                        <button class="leave-btn" style="margin-top:0; flex:1;" onclick="leaveEvent('${id}')"><i class='bx bx-exit'></i></button>
                      </div>` 
                   : (isFull 
                      ? `<button class="join" style="background: #cbd5e1; color: #64748b; cursor: not-allowed;" disabled>Event Full 🛑</button>`
                      : `<button class="join" onclick="joinEvent('${id}')">Join Hangout</button>`
                     )
                  )
              }
            </div>`;
        }
      } else if (e.expiresAt > oneDayAgo) {
        if (matchesRecap) {
          recapCount++;
          recapList.innerHTML += `
            <div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; gap: 8px; align-items: center;">${displayTag}</div>
                ${hypeHTML}
              </div>
              <div class="event-title" style="color: #4b5563;">${cleanTitle}</div>
              <div class="event-meta" style="display:flex; align-items:center;">${avatarHTML} <span>${cleanPlace} • hosted by ${hostDisplayName}</span></div>
              <div class="attendees" style="background:#f3f4f6; color: var(--text-muted);"><i class='bx bx-check-double'></i> Attended (${attendeesCount}): ${attendeeNames}</div>
            </div>`;
        }
      }
    });
    if (activeCount === 0) liveList.innerHTML = `<div class="empty-state"><i class='bx bx-ghost'></i><p>Nothing matching that filter right now.</p></div>`;
    if (recapCount === 0) recapList.innerHTML = `<div class="empty-state"><i class='bx bx-history'></i><p>No recent history for this filter.</p></div>`;
  });
}

function joinEvent(id) { 
    const now = Date.now(); if (now - lastJoinTime < 500) return; lastJoinTime = now;
    db.collection("events").doc(id).update({ participants: firebase.firestore.FieldValue.arrayUnion(currentUserUid) }); 
}
function leaveEvent(id) { 
    const now = Date.now(); if (now - lastJoinTime < 500) return; lastJoinTime = now;
    db.collection("events").doc(id).update({ participants: firebase.firestore.FieldValue.arrayRemove(currentUserUid) }); 
}
function openDeleteModal(id) { eventIdToManage = id; document.getElementById("deleteModal")?.classList.remove("hidden"); }
function closeDeleteModal() { eventIdToManage = null; document.getElementById("deleteModal")?.classList.add("hidden"); }

function confirmMoveToRecap() { 
    if (!eventIdToManage) return; 
    const eventCard = document.getElementById(`event-${eventIdToManage}`);
    if (eventCard) {
        eventCard.style.transition = "all 0.3s ease";
        eventCard.style.opacity = "0";
        eventCard.style.transform = "scale(0.9)";
        setTimeout(() => eventCard.classList.add("hidden"), 300);
    }
    closeDeleteModal();
    db.collection("events").doc(eventIdToManage).update({ expiresAt: Date.now() - 1 }); 
}

function confirmDeletePermanently() { 
    if (!eventIdToManage) return; 
    const eventId = eventIdToManage;
    const eventCard = document.getElementById(`event-${eventId}`);
    if (eventCard) {
        eventCard.style.transition = "all 0.3s ease";
        eventCard.style.opacity = "0";
        eventCard.style.transform = "scale(0.9)";
        setTimeout(() => eventCard.remove(), 300);
    }
    closeDeleteModal();
    db.collection("events").doc(eventId).delete().catch((error) => {
        loadEvents(); 
    });
}

async function checkCrossedPaths(user1, user2) {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); 
  const snap = await db.collection("events").where("participants", "array-contains", user1).get();
  for (let doc of snap.docs) { const e = doc.data(); if (e.participants.includes(user2) && e.expiresAt > oneDayAgo) return true; } return false;
}

async function startChat(clickedUsername = null) {
  let rawOther = clickedUsername || document.getElementById("chatUser")?.value.trim();
  if (!rawOther) return alert("Please enter a username.");
  const otherUsername = rawOther.toLowerCase().replace(/[^a-z0-9_]/g, ''); 
  if (otherUsername === currentUsername) return alert("You can't start a chat with yourself!");
  
  try {
    const lockboxDoc = await db.collection("usernames").doc(otherUsername).get();
    if (!lockboxDoc.exists) return alert(`User "@${otherUsername}" does not exist on campus.`);
    
    const otherUid = lockboxDoc.data().uid;
    const chatId = [currentUserUid, otherUid].sort().join("_");
    if(!clickedUsername && document.getElementById("chatUser")) document.getElementById("chatUser").value = ""; 
    
    openChat(chatId, otherUid, otherUsername);
  } catch (error) { alert("Error finding user."); }
}

function openChat(chatId, otherUid, otherUsername) {
  currentChat = chatId; 
  currentOtherUser = otherUid;
  currentChatType = "direct"; 
  
  const hAvatar = document.getElementById("chatHeaderAvatar"); 
  const hTitle = document.getElementById("chatWithTitle");
  if(hAvatar) hAvatar.innerHTML = renderAvatar("👤"); 
  if(hTitle) hTitle.innerText = otherUsername;

  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";
  
  db.collection("users").doc(otherUid).get().then(doc => {
      if (doc.exists) {
          const d = doc.data();
          userCache[otherUid] = { uid: otherUid, ...d };
          if(hAvatar) hAvatar.innerHTML = renderAvatar(d.avatar || "👤");
          if(hTitle) hTitle.innerText = d.displayName || d.username;
          
          hAvatar.style.cursor = "pointer";
          hAvatar.onclick = () => openProfileScreen(otherUid);
          hTitle.style.cursor = "pointer";
          hTitle.onclick = () => openProfileScreen(otherUid);
      }
  });
  
  document.querySelector(".topbar")?.classList.add("hidden"); 
  switchScreen("chatScreen");
  history.pushState({ modalOpen: true }, '', window.location.href);
  
  if(chatDocUnsubscribe) chatDocUnsubscribe();
  chatDocUnsubscribe = db.collection("chats").doc(chatId).onSnapshot(doc => {
     if(doc.exists) { 
         currentChatData = doc.data(); 
         currentChatStatus = currentChatData.status || "unlocked"; 
         currentChatInitiator = currentChatData.initiatedBy || ""; 
         
         if (currentChatData.unreadBy === currentUserUid) {
             db.collection("chats").doc(chatId).set({ unreadBy: "" }, { merge: true });
             currentChatData.unreadBy = ""; 
         }
         updateReadReceipts();
         updateTypingIndicator();
         updateChatFooterUI(); 
     }
  });
  loadMessages();
}

function closeChat() {
  if (currentChat) {
      if (currentChatType === "event") {
          db.collection("events").doc(currentChat).update({ typingUsers: firebase.firestore.FieldValue.arrayRemove(currentUserUid) }).catch(()=>{});
      } else {
          db.collection("chats").doc(currentChat).set({ typing: "" }, { merge: true });
      }
  }
  currentChat = null; currentChatData = null; currentOtherUser = ""; 
  if (messagesUnsubscribe) messagesUnsubscribe(); if (chatDocUnsubscribe) chatDocUnsubscribe();
  document.querySelector(".topbar")?.classList.remove("hidden"); switchScreen("home");
}

async function sendMessage() {
  const input = document.getElementById("msgInput"); if(!input) return; 
  const text = input.value.trim(); 
  if (!text || !currentChat) return;
  
  if (text.length > 1000) return alert("Message threshold exceeded (Max 1000 characters).");

  const now = Date.now();
  if (now - lastMessageTime < 400) return;
  lastMessageTime = now;

  // 🔥 SCHEMATIC CHANGE: Structural map key points cleanly to UID reference variables now
  const replyData = replyingToMessage ? { uid: replyingToMessage.sender, text: replyingToMessage.text, time: replyingToMessage.time } : null;
  replyingToMessage = null; 

  const chatRefPath = currentChatType === "event" 
      ? db.collection("events").doc(currentChat) 
      : db.collection("chats").doc(currentChat);

  await chatRefPath.collection("messages").add({ 
      chatId: currentChat, 
      sender: currentUserUid, 
      text: text, 
      time: Date.now(), 
      replyTo: replyData,
      uid: currentUserUid 
  });

  if (currentChatType === "event") {
      await db.collection("events").doc(currentChat).update({ 
          typingUsers: firebase.firestore.FieldValue.arrayRemove(currentUserUid) 
      }).catch(()=>{}); 
  } else {
      const otherUid = currentOtherUser; 
      const chatRef = db.collection("chats").doc(currentChat); 
      const chatDoc = await chatRef.get(); 
      let newStatus = currentChatStatus;
      
      if (!chatDoc.exists || !chatDoc.data().status) {
          const crossedPaths = await checkCrossedPaths(currentUserUid, otherUid); 
          newStatus = crossedPaths ? "unlocked" : "icebreaker";
      } else {
          if (currentChatStatus === "icebreaker" && currentChatInitiator === otherUid) newStatus = "unlocked"; 
      }
      
      await chatRef.set({ 
          members: [currentUserUid, otherUid], 
          unreadBy: otherUid, 
          lastUpdated: Date.now(), 
          status: newStatus, 
          typing: "" 
      }, { merge: true });
  }
  input.value = "";
  updateChatFooterUI(); 
}

function handleTyping() {
  if (!currentChat) return;

  if (currentChatType === "event") {
      db.collection("events").doc(currentChat).update({
          typingUsers: firebase.firestore.FieldValue.arrayUnion(currentUserUid)
      });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
          if (currentChat) db.collection("events").doc(currentChat).update({ typingUsers: firebase.firestore.FieldValue.arrayRemove(currentUserUid) }).catch(()=>{});
      }, 1500);
  } else {
      db.collection("chats").doc(currentChat).set({ typing: currentUserUid }, { merge: true });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
          if (currentChat) db.collection("chats").doc(currentChat).set({ typing: "" }, { merge: true });
      }, 1500);
  }
}

function initiateReply(senderUid, text, time) {
  replyingToMessage = { sender: senderUid, text, time };
  updateChatFooterUI();
  setTimeout(() => {
      const input = document.getElementById("msgInput");
      if(input) { input.focus(); input.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  }, 50);
}

function cancelReply() { replyingToMessage = null; updateChatFooterUI(); const input = document.getElementById("msgInput"); if(input) input.focus(); }

function scrollToMessage(time) {
    const targetMsg = document.getElementById(`msg-${time}`);
    if (!targetMsg) return;
    const bubble = targetMsg.querySelector(".msg-bubble");
    if (!bubble) return;
    targetMsg.scrollIntoView({ behavior: "smooth", block: "center" });
    const isSent = bubble.classList.contains("msg-sent");
    const flashClass = isSent ? "flash-sent" : "flash-received";
    bubble.classList.remove("flash-sent", "flash-received");
    void bubble.offsetWidth; 
    bubble.classList.add(flashClass);
    setTimeout(() => { bubble.classList.remove(flashClass); }, 1600);
}

function updateReadReceipts() {
  const receipt = document.getElementById("readReceipt");
  if (receipt && currentChatData) {
      if (currentChatData.unreadBy === "") receipt.innerHTML = `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>`;
      else receipt.innerHTML = `Sent <i class='bx bx-check'></i>`;
  }
}

function updateTypingIndicator() {
  const bubble = document.getElementById("typingBubble"); 
  const nameEl = document.getElementById("typingName");
  const box = document.getElementById("messages");
  if (!bubble || !box) return;

  if (currentChatType === "event" && currentEventData) {
      const typists = (currentEventData.typingUsers || []).filter(u => u !== currentUserUid);
      if (typists.length > 0) {
          if (nameEl) {
              const displayName = escapeHTML(userCache[typists[0]]?.displayName || "Student");
              nameEl.innerText = typists.length === 1 ? `${displayName} is typing` : `${typists.length} people typing`;
          }
          bubble.classList.remove("hidden"); box.scrollTop = box.scrollHeight;
      } else { bubble.classList.add("hidden"); }
  } else if (currentChatType === "direct" && currentChatData) {
      if (currentChatData.typing === currentOtherUser) { 
          if (nameEl) nameEl.innerText = ""; 
          bubble.classList.remove("hidden"); box.scrollTop = box.scrollHeight; 
      } else { bubble.classList.add("hidden"); }
  }
}

function handleChatScroll() {
  const box = document.getElementById("messages");
  let floatingDate = document.getElementById("floatingDate");
  if (!floatingDate) {
      floatingDate = document.createElement("div"); floatingDate.id = "floatingDate"; floatingDate.className = "floating-date";
      document.getElementById("chatScreen").appendChild(floatingDate);
  }
  const dateWrappers = box.getElementsByClassName("date-separator");
  let activeDateText = "";
  const boxRect = box.getBoundingClientRect();
  for (let el of dateWrappers) {
      const rect = el.getBoundingClientRect();
      if (rect.top <= boxRect.top + 60) activeDateText = el.innerText;
  }
  if (activeDateText) {
      floatingDate.innerText = activeDateText; floatingDate.classList.add("visible");
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => { floatingDate.classList.remove("visible"); }, 1200);
  }
}

function loadMessages() {
  if (messagesUnsubscribe) messagesUnsubscribe(); 
  const box = document.getElementById("messages"); if(!box) return;
  if (!box.dataset.hasScrollListener) { box.addEventListener("scroll", handleChatScroll); box.dataset.hasScrollListener = "true"; }
  
  const collectionPath = currentChatType === "event" 
      ? db.collection("events").doc(currentChat).collection("messages")
      : db.collection("chats").doc(currentChat).collection("messages");

  messagesUnsubscribe = collectionPath.orderBy("time").onSnapshot(async (snapshot) => {
      let lastDateString = ""; myMessageCount = 0; let theirMessageCount = 0;
      let msgs = []; snapshot.forEach(doc => msgs.push(doc.data())); msgs.sort((a, b) => a.time - b.time); 
      
      const uniqueSenders = [...new Set(msgs.map(m => m.sender))];
      for (let s of uniqueSenders) {
          if (!userCache[s]) {
              const doc = await db.collection("users").doc(s).get();
              userCache[s] = doc.exists ? { uid: s, ...doc.data() } : { displayName: "Student", avatar: "👤" };
          }
      }

      let newHTML = "";
      msgs.forEach((m, i) => {
        const isMe = m.sender === currentUserUid; if(isMe) myMessageCount++; else theirMessageCount++;
        const msgDate = new Date(m.time).toLocaleDateString();
        
        if (msgDate !== lastDateString) { 
            let displayDate = ""; const today = new Date().toLocaleDateString(); const yesterdayObj = new Date(); yesterdayObj.setDate(yesterdayObj.getDate() - 1); const yesterday = yesterdayObj.toLocaleDateString(); 
            if (msgDate === today) displayDate = "Today"; else if (msgDate === yesterday) displayDate = "Yesterday"; else displayDate = new Date(m.time).toLocaleDateString([], { month: 'short', day: 'numeric' }); 
            newHTML += `<div class="date-wrapper"><div class="date-separator">${displayDate}</div></div>`; lastDateString = msgDate; 
        }

        const prev = msgs[i - 1]; const next = msgs[i + 1];
        const isSamePrev = prev && prev.sender === m.sender; const isSameNext = next && next.sender === m.sender;
        let shape = "single"; if (isSamePrev && isSameNext) shape = "middle"; else if (!isSamePrev && isSameNext) shape = "first"; else if (isSamePrev && !isSameNext) shape = "last";

        const encodedText = encodeURIComponent(m.text); 
        const rawText = m.text.trim();
        const isMediaOnly = /^https?:\/\/[^\s]+$/.test(rawText) && (rawText.includes("youtube.com") || rawText.includes("youtu.be") || rawText.includes("googleusercontent.com"));
        const bubbleClass = isMediaOnly ? 'msg-bubble media-only' : 'msg-bubble';

        let replyBlock = "";
        if (m.replyTo) {
            // 🔥 SCHEMATIC CHANGE MATCHED: Evaluates reply target elements securely using lookups by UIDs instead of handles
            const replyTargetUid = m.replyTo.uid || m.replyTo.sender;
            const replyName = replyTargetUid === currentUserUid ? "You" : (escapeHTML(userCache[replyTargetUid]?.displayName) || "Student");
            const timeData = m.replyTo.time ? `data-target-time="${m.replyTo.time}"` : "";
            replyBlock = `<div class="msg-replied-to" ${timeData}><b>${replyName}:</b> ${escapeHTML(m.replyTo.text)}</div>`;
        }

        const swipeIconHTML = isMe 
            ? `<div class="swipe-reply-icon right"><i class='bx bx-reply' style="transform: scaleX(-1);"></i></div>` 
            : `<div class="swipe-reply-icon left"><i class='bx bx-reply'></i></div>`;

        let nameTagHTML = "";
        if (currentChatType === "event" && !isMe && !isSamePrev) {
            const senderDisplayName = escapeHTML(userCache[m.sender]?.displayName || "Student");
            nameTagHTML = `<div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-left: 14px; margin-bottom: 2px; cursor: pointer; display: inline-block;" onclick="event.stopPropagation(); openProfileScreen('${m.sender}')">${senderDisplayName}</div>`;
        }
            
        newHTML += `<div id="msg-${m.time}" class="msg-wrapper" data-sender="${m.sender}" data-time="${m.time}" data-text="${encodedText}" style="align-items: ${isMe ? 'flex-end' : 'flex-start'};" onclick="handleMessageTap(event, this, '${m.sender}', '${encodedText}', ${m.time})">
                      ${swipeIconHTML}
                      ${nameTagHTML}
                      <div class="${bubbleClass} ${isMe ? 'msg-sent' : 'msg-received'} ${shape}">
                         ${replyBlock}
                         ${formatMessage(m.text, isMediaOnly)}
                      </div>
                      <div class="msg-time" style="text-align: ${isMe ? 'right' : 'left'}">
                         ${formatTime(m.time)}
                      </div>
                    </div>`;
        
        if (i === msgs.length - 1 && isMe && currentChatType === "direct") {
            let statusHtml = (currentChatData && currentChatData.unreadBy === "") ? `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>` : `Sent <i class='bx bx-check'></i>`;
            newHTML += `<div class="msg-status" id="readReceipt">${statusHtml}</div>`; 
        }
      });
      
      newHTML += `<div id="typingBubble" class="typing-indicator hidden" style="align-items: center; margin-top: 8px;">
                    <span id="typingName" style="font-size: 12px; font-weight: 700; color: var(--primary); margin-right: 8px;"></span>
                    <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
                  </div>`;
      
      box.innerHTML = newHTML;
      if (currentChatStatus === "icebreaker" && theirMessageCount > 0 && currentChatInitiator === currentUserUid) { db.collection("chats").doc(currentChat).update({ status: "unlocked" }); }
      box.scrollTop = box.scrollHeight; 
      updateChatFooterUI(); updateReadReceipts(); updateTypingIndicator();
    });
}

function loadChatList() {
  if (chatListUnsubscribe) chatListUnsubscribe();

  chatListUnsubscribe = db.collection("chats").where("members", "array-contains", currentUserUid).onSnapshot(async (snapshot) => {
      const list = document.getElementById("chatList"); if(!list) return;
      let hasGlobalUnread = false; let chatsArray = [];
      
      snapshot.docChanges().forEach(change => { 
        if (change.type === "modified") { 
          const chatData = change.doc.data(); 
          if (chatData.unreadBy === currentUserUid && currentChat !== change.doc.id) { 
            const otherUid = chatData.members.find(u => u !== currentUserUid);
            showNotification(otherUid, change.doc.id); 
          } 
        } 
      });
      
      snapshot.forEach(doc => { chatsArray.push({ id: doc.id, ...doc.data() }); }); 
      chatsArray.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
      
      const uniqueOtherUids = [...new Set(chatsArray.map(chat => 
          chat.members ? chat.members.find(u => u !== currentUserUid) : null
      ))].filter(Boolean);
      
      for (let otherUid of uniqueOtherUids) {
          if (!userCache[otherUid]) {
              const doc = await db.collection("users").doc(otherUid).get();
              userCache[otherUid] = doc.exists ? { uid: otherUid, ...doc.data() } : { displayName: "Student", avatar: "👤" };
          }
      }

      list.innerHTML = "";
      if (chatsArray.length === 0) {
          list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;
          return;
      }
      
      chatsArray.forEach(chat => {
        let otherUid = chat.members.find(u => u !== currentUserUid);
        if (chat.unreadBy === currentUserUid && currentChat === chat.id) { db.collection("chats").doc(chat.id).set({ unreadBy: "" }, { merge: true }); chat.unreadBy = ""; }
        
        const isUnread = chat.unreadBy === currentUserUid; 
        if (isUnread) hasGlobalUnread = true;
        
        const cachedUser = userCache[otherUid] || {};
        const displayName = escapeHTML(cachedUser.displayName || cachedUser.username || "Student");
        const avatarCode = cachedUser.avatar || "👤";
        
        const unreadStyles = isUnread ? 'background: #e0e7ff; border-left: 4px solid var(--primary);' : '';
        const nameStyles = isUnread ? 'font-weight: 800;' : '';
        const dotHTML = isUnread ? `<div class="unread-pulse-dot"></div>` : '';
        
        list.innerHTML += `
          <div class="chat-item" onclick="openChat('${chat.id}', '${otherUid}', '${escapeHTML(cachedUser.username) || 'user'}')" style="${unreadStyles}">
            <div class="chat-avatar" style="background: transparent; border: 1px solid var(--border); padding: 0; overflow: hidden;">
                ${renderAvatar(avatarCode)}
            </div>
            <div class="chat-name" style="${nameStyles}; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayName}</div>
            ${dotHTML}
          </div>`;
      });
      
      const badge = document.getElementById("chatBadge"); 
      if (hasGlobalUnread) {
        if (badge) badge.classList.remove("hidden");
        document.title = "(1) New Message - livesociya"; 
      } else {
        if (badge) badge.classList.add("hidden");
        document.title = "livesociya";
      }
    });
}

function showTab(tab) {
  document.getElementById("eventsTab")?.classList.add("hidden"); document.getElementById("recapTab")?.classList.add("hidden"); document.getElementById("chatsTab")?.classList.add("hidden");
  document.querySelectorAll(".nav-item").forEach(t => t.classList.remove("active")); const navItems = document.querySelectorAll(".nav-item");
  if (tab === 'events') { document.getElementById("eventsTab")?.classList.remove("hidden"); if(navItems[0]) navItems[0].classList.add("active"); } 
  else if (tab === 'recap') { document.getElementById("recapTab")?.classList.remove("hidden"); if(navItems[1]) navItems[1].classList.add("active"); } 
  else { document.getElementById("chatsTab")?.classList.remove("hidden"); if(navItems[2]) navItems[2].classList.add("active"); }
}

function openProfileScreen(targetUid = null) {
    document.getElementById("home").classList.add("hidden");
    document.getElementById("profileScreen").classList.remove("hidden");
    history.pushState({ screen: 'profile' }, '', window.location.href);
    
    currentProfileView = targetUid || currentUserUid; 
    loadProfileUI(currentProfileView); 
}

// 🔥 GC ACTIVE LISTENER UNLINK: Sweeps background streams upon close execution loops
function closeProfileScreen() {
    document.getElementById("profileScreen").classList.add("hidden");
    document.getElementById("home").classList.remove("hidden");
    if (profileEventsUnsubscribe) {
        profileEventsUnsubscribe();
        profileEventsUnsubscribe = null;
    }
    currentProfileView = ""; 
}

async function loadProfileUI(targetUid) {
  if (!targetUid) return; 

  const avatarEl = document.getElementById("profileAvatarDisplay");
  const nameDisplay = document.getElementById("profileDisplayNameDisplay");
  const usernameDisplay = document.getElementById("profileUsernameDisplay");
  const settingsGear = document.getElementById("profileSettingsBtn");
  const editInput = document.getElementById("editDisplayNameInput"); 
  
  if (avatarEl) avatarEl.innerHTML = renderAvatar("👤");
  if (nameDisplay) nameDisplay.innerText = "Loading...";
  if (usernameDisplay) usernameDisplay.innerText = "Loading..."; 
  
  const statJoined = document.getElementById("statEventsJoined");
  const statHosted = document.getElementById("statEventsHosted");
  const eventsList = document.getElementById("myProfileEvents");
  
  if (statJoined) statJoined.innerText = "-";
  if (statHosted) statHosted.innerText = "-";
  if (eventsList) eventsList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size: 13px;"><i class='bx bx-loader-alt bx-spin'></i> Loading...</div>`;
  
  let cachedUser = userCache[targetUid];
  if (cachedUser) {
      if (avatarEl && cachedUser.avatar) avatarEl.innerHTML = renderAvatar(cachedUser.avatar);
      if (nameDisplay && cachedUser.displayName) nameDisplay.innerText = escapeHTML(cachedUser.displayName);
      if (usernameDisplay && cachedUser.username) usernameDisplay.innerText = "@" + escapeHTML(cachedUser.username);
  }
  
  if (targetUid === currentUserUid) { settingsGear.classList.remove("hidden"); } 
  else { settingsGear.classList.add("hidden"); }
  
  try {
      const userDoc = await db.collection("users").doc(targetUid).get();
      if (userDoc.exists) {
          const data = userDoc.data();
          userCache[targetUid] = { uid: targetUid, ...data }; 
          
          if (avatarEl) avatarEl.innerHTML = renderAvatar(data.avatar || "👤");
          if (nameDisplay) nameDisplay.innerText = escapeHTML(data.displayName || data.username);
          if (usernameDisplay) usernameDisplay.innerText = "@" + escapeHTML(data.username);

          if (targetUid === currentUserUid && editInput) {
              realName = data.displayName || data.username;
              editInput.value = realName;
          }
      } else {
          if (nameDisplay) nameDisplay.innerText = "Unknown User"; 
          if (usernameDisplay) usernameDisplay.innerText = "Not Found";
      }
      
      db.collection("events").where("hostUid", "==", targetUid).get().then(snap => {
          if(statHosted) statHosted.innerText = snap.size || 0;
      });
      db.collection("events").where("participants", "array-contains", targetUid).get().then(snap => {
          if(statJoined) statJoined.innerText = snap.size || 0;
      });

      loadUserEvents(targetUid);
  } catch(e) { console.error("Profile load error:", e); }
}

// ==========================================
// 📅 PROFILE HISTORICAL LOAD (XSS Safe)
// ==========================================
function loadUserEvents(targetUid) {
    const list = document.getElementById("myProfileEvents");
    if (!list) return;
    if (profileEventsUnsubscribe) profileEventsUnsubscribe();
    
    profileEventsUnsubscribe = db.collection("events").where("hostUid", "==", targetUid).onSnapshot(snapshot => {
          list.innerHTML = "";
          let eventsArray = [];
          snapshot.forEach(doc => eventsArray.push({ id: doc.id, ...doc.data() }));
          eventsArray.sort((a, b) => b.startTime - a.startTime);
          
          if (eventsArray.length === 0) {
              list.innerHTML = `<div class="empty-state" style="padding: 20px;"><i class='bx bx-ghost'></i><p>No hosted events yet.</p></div>`;
              return;
          }

          eventsArray.forEach(e => {
              const cleanTitle = escapeHTML(e.title);
              const cleanPlace = escapeHTML(e.place);

              list.innerHTML += `
                <div class="card" style="padding: 16px; margin-bottom: 12px; box-shadow: none; border: 1px solid var(--border);">
                  <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">${cleanTitle}</div>
                  <div style="font-size: 12px; color: var(--text-muted);"><i class='bx bx-map'></i> ${cleanPlace}</div>
                </div>`;
          });
      }, error => { console.error("Error loading events:", error); });
}

async function saveProfileData() {
    const nameInput = document.getElementById("editDisplayNameInput");
    const btn = document.getElementById("saveProfileBtn");
    const newName = nameInput.value.trim();
    if (!newName) return alert("Display Name cannot be empty!");
    if (newName.length > 50) return alert("Display name too long (Max 50).");

    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
    btn.disabled = true;

    try {
        const updateData = { 
            displayName: newName, 
            avatar: pendingSettingsAvatar, 
            googlePfp: googlePfp,
            updatedAt: Date.now(),
            uid: currentUserUid
        };

        await db.collection("users").doc(currentUserUid).set(updateData, { merge: true });
        realName = newName; userAvatar = pendingSettingsAvatar; 
        
        const displayEl = document.getElementById("profileDisplayNameDisplay");
        if (displayEl) displayEl.innerText = escapeHTML(newName);

        const avatarDisplay = document.getElementById("profileAvatarDisplay");
        if (avatarDisplay) {
            avatarDisplay.innerHTML = pendingSettingsAvatar.startsWith('http') 
                ? `<img src="${pendingSettingsAvatar}" alt="avatar" style="width:100%; height:100%; object-fit:cover;">` 
                : pendingSettingsAvatar;
        }
        
        btn.style.background = "var(--success)"; btn.innerHTML = `<i class='bx bx-check'></i> Saved!`;
        setTimeout(() => {
            btn.style.background = "var(--primary-gradient)"; btn.innerHTML = originalText; btn.disabled = false;
            closeSettingsScreen(); 
        }, 800);
    } catch (e) {
        alert("Failed to save profile. Please check your connection.");
        btn.innerHTML = originalText; btn.disabled = false;
    }
}

let pendingSettingsAvatar = null;
function openSettingsScreen() { 
    document.getElementById("settingsScreen")?.classList.remove("hidden");
    const nameInput = document.getElementById("editDisplayNameInput");
    if(nameInput) nameInput.value = document.getElementById("profileDisplayNameDisplay").innerText;
    pendingSettingsAvatar = userAvatar; 
    document.querySelectorAll('#settingsAvatarGrid .avatar-option').forEach(el => {
        el.classList.remove('selected'); if (el.innerText === userAvatar) el.classList.add('selected');
    });
}

function selectSettingsAvatar(element, avatarChoice) {
    document.querySelectorAll('#settingsAvatarGrid .avatar-option').forEach(el => el.classList.remove('selected'));
    if (avatarChoice === 'google') {
        pendingSettingsAvatar = auth.currentUser.photoURL;
        const originalText = element.innerHTML; element.innerHTML = "<i class='bx bx-check'></i> Selected!";
        setTimeout(() => element.innerHTML = originalText, 1500);
    } else {
        pendingSettingsAvatar = avatarChoice; element.classList.add('selected');
    }
}
function closeSettingsScreen() { document.getElementById("settingsScreen")?.classList.add("hidden"); }

window.addEventListener('popstate', (event) => {
    if (currentChat) { closeChat(); } 
    else if (currentProfileView && currentProfileView !== "") { closeProfileScreen(); } 
    else if (auth.currentUser) { history.pushState(null, '', window.location.href); }
});

function toggleHype(id, isHyped) {
    const now = Date.now(); if (now - lastHypeTime < 300) return; lastHypeTime = now;
    const eventRef = db.collection("events").doc(id);
    if (isHyped) {
        eventRef.update({ hypedBy: firebase.firestore.FieldValue.arrayRemove(currentUserUid) });
    } else {
        eventRef.update({ hypedBy: firebase.firestore.FieldValue.arrayUnion(currentUserUid) });
        if (navigator.vibrate) navigator.vibrate(50); 
    }
}

// ==========================================
// 🖱️ + 📲 HYBRID SWIPE TO REPLY ENGINE
// ==========================================
let startX = 0, startY = 0, currentSwipeItem = null, isSwiping = false, swipeDirection = 0;

function handleDragStart(e) {
    const wrapper = e.target.closest(".msg-wrapper"); if (!wrapper) return;
    const touch = e.type.includes("mouse") ? e : e.touches[0];
    startX = touch.clientX; startY = touch.clientY;
    currentSwipeItem = wrapper; isSwiping = false; wrapper.style.transition = "none"; 
    const isSent = wrapper.querySelector(".msg-sent") !== null;
    swipeDirection = isSent ? -1 : 1; 
}

function handleDragMove(e) {
    if (!currentSwipeItem) return;
    const touch = e.type.includes("mouse") ? e : e.touches[0];
    const deltaX = touch.clientX - startX; const deltaY = touch.clientY - startY;
    if (!isSwiping && Math.abs(deltaY) > Math.abs(deltaX)) { currentSwipeItem = null; return; }
    if ((swipeDirection === 1 && deltaX > 10) || (swipeDirection === -1 && deltaX < -10)) {
        isSwiping = true; if(e.cancelable) e.preventDefault(); 
    }
    if (isSwiping) {
        let movePx = 0;
        if (swipeDirection === 1 && deltaX > 0) movePx = Math.min(deltaX * 0.4, 65);
        else if (swipeDirection === -1 && deltaX < 0) movePx = Math.max(deltaX * 0.4, -65);
        currentSwipeItem.style.transform = `translateX(${movePx}px)`;
        if (Math.abs(movePx) >= 50) currentSwipeItem.classList.add("ready-to-reply");
        else currentSwipeItem.classList.remove("ready-to-reply");
    }
}

function handleDragEnd(e) {
    if (!currentSwipeItem) return;
    if (currentSwipeItem.classList.contains("ready-to-reply")) {
        const senderUid = currentSwipeItem.getAttribute("data-sender");
        const text = decodeURIComponent(currentSwipeItem.getAttribute("data-text"));
        const time = parseInt(currentSwipeItem.getAttribute("data-time"));
        initiateReply(senderUid, text, time);
        if (navigator.vibrate) navigator.vibrate(50); 
    }
    currentSwipeItem.style.transition = "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
    currentSwipeItem.style.transform = "translateX(0px)"; currentSwipeItem.classList.remove("ready-to-reply");
    currentSwipeItem = null; isSwiping = false;
}

document.addEventListener("mousedown", handleDragStart);
document.addEventListener("mousemove", handleDragMove);
document.addEventListener("mouseup", handleDragEnd);
document.addEventListener("touchstart", handleDragStart, { passive: false });
document.addEventListener("touchmove", handleDragMove, { passive: false });
document.addEventListener("touchend", handleDragEnd);

document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("login-btn"); if (loginBtn) { loginBtn.addEventListener("click", () => loginWithGoogle()); }
  const claimBtn = document.getElementById("claimBtn"); if (claimBtn) { claimBtn.addEventListener("click", async () => { const loadingScreen = document.getElementById("loading-screen"); if (loadingScreen) loadingScreen.classList.remove("hidden"); await claimUsername(); }); }
});
