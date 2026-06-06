// ==========================================
// PASTE YOUR FIREBASE CONFIG KEYS HERE!
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBvcJJ2wz2yteRUYdasRUe8oaTt_Vp9kGQ",
  authDomain: window.location.hostname, // Enterprise Fix
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

let currentChat = null, user = "", userEmail = "", userAvatar = "👤";
let currentChatType = "direct";
let messagesUnsubscribe = null, eventIdToManage = null;
let currentSelectedTag = '☕ Chill', googlePfp = "", realName = "";
let currentLiveFilter = 'All', currentRecapFilter = 'All';
let currentEventData = null;
let userDisplayName = ""; // Holds the user's custom name in memory
let currentProfileView = "";
let userCache = {}; // 🧠 The Smart Cache Dictionary

function renderAvatar(avatarCode) {
  if (!avatarCode) return "👤";
  
  // 🔥 THE FIX: Added referrerpolicy="no-referrer" so Google doesn't block the image!
  if (typeof avatarCode === 'string' && avatarCode.startsWith("http")) {
    return `<img src="${avatarCode}" referrerpolicy="no-referrer" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">`;
  }
  
  return avatarCode;
}

// ==========================================
// 🎵 SMART LINK PREVIEWS (Spotify, YouTube, Links)
// ==========================================
function formatMessage(text, isMediaOnly = false) {
    // 1. Sanitize text to block hackers
    let safeText = text.replace(/</g, "<").replace(/>/g, ">");
    const urlRegex = /(https?:\/\/[^\s]+)/g;

    return safeText.replace(urlRegex, function(url) {
        
        // --- 🔴 YOUTUBE PREVIEW (With Skeleton Loader) ---
        if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
            let videoId = "";
            if (url.includes("youtube.com/watch")) videoId = new URL(url).searchParams.get("v");
            else videoId = url.split("youtu.be/")[1]?.split("?")[0];
            
            if (videoId) {
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
        
        // --- 🟢 SPOTIFY PREVIEW (With Skeleton Loader) ---
        if (url.includes("open.spotify.com/track") || url.includes("open.spotify.com/playlist") || url.includes("open.spotify.com/album")) {
            // Converts standard Spotify link directly to an embed link!
            const embedUrl = url.split("?")[0].replace("open.spotify.com", "open.spotify.com/embed");
            const margin = isMediaOnly ? "0" : "8px";
            return `${isMediaOnly ? "" : "<br>"}
                    <div style="margin-top: ${margin}; width: 100%; max-width: 280px; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); background: #121212; position: relative; min-height: 152px;">
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #1ed760; font-size: 32px; z-index: 1;">
                            <i class='bx bxl-spotify bx-flashing'></i>
                        </div>
                        <iframe src="${embedUrl}" width="100%" height="152" frameborder="0" style="display: block; position: relative; z-index: 2;" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
                    </div>`;
        }

        // --- 🔵 NORMAL LINK PREVIEW ---
        return `<a href="${url}" target="_blank" style="color: inherit; font-weight: 700; text-decoration: underline; word-break: break-all;">${url}</a>`;
    });
}

// ==========================================
// 🔔 IN-APP NOTIFICATION SYSTEM (CLEAN MOBILE)
// ==========================================
function showNotification(senderUsername, chatId) {
  if (currentChat === chatId) return;

  let toastBox = document.getElementById("toastBox");
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.id = "toastBox";
    toastBox.style.cssText = "position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999; width: 90%; max-width: 400px; display: flex; flex-direction: column; align-items: center; pointer-events: none;";
    document.body.appendChild(toastBox);
  }

  toastBox.innerHTML = "";
  
  // 🔥 THE FIX: Removed @ and use the display name if available!
  const displayName = userCache[senderUsername]?.displayName || senderUsername;

  const toast = document.createElement("div");
  toast.style.cssText = "background: var(--primary); color: white; padding: 14px 20px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); font-size: 14px; font-weight: 600; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
  toast.innerHTML = `<i class='bx bxs-message-rounded-dots' style="font-size: 20px;"></i> New message from ${displayName}`;

  toast.onclick = () => {
    openChat(chatId, senderUsername);
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

function handleMessageTap(event, element, sender, encodedText, time) {
    // 1. THE FIX: Check if their finger specifically landed on the grey context box
    const replyBox = event.target.closest('.msg-replied-to');
    
    if (replyBox) {
        // They tapped the grey box! 
        const targetTime = replyBox.getAttribute('data-target-time');
        
        // If the message has a GPS coordinate, scroll to it!
        if (targetTime) scrollToMessage(targetTime);
        
        // 🛑 EXIT IMMEDIATELY! Do not open the timestamp. Do not double-tap.
        return; 
    }

    // 2. If they touched the normal blue/grey bubble, run the standard rules
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTapTime;
    lastTapTime = currentTime;
    
    if (tapLength < 300 && tapLength > 0) {
        // 🔥 DOUBLE TAP: Trigger Reply
        event.preventDefault(); 
        initiateReply(sender, decodeURIComponent(encodedText), time);
        if (navigator.vibrate) navigator.vibrate(50); 
    } else {
        // 👆 SINGLE TAP: Reveal Timestamp
        toggleTime(element);
    }
}

// ==========================================
// 🔐 ENTERPRISE FIRST-PARTY AUTHENTICATION
// ==========================================

function switchScreen(screenId) {
  document.getElementById("login")?.classList.add("hidden");
  document.getElementById("home")?.classList.add("hidden");
  document.getElementById("usernameModal")?.classList.add("hidden");
  document.getElementById("profileScreen")?.classList.add("hidden");
  document.getElementById("chatScreen")?.classList.add("hidden");
  if (screenId) document.getElementById(screenId)?.classList.remove("hidden");

  // 🔥 BUG 1 FIX: Hide the bottom navigation bar on login/username screens!
  const bottomNav = document.querySelector(".bottom-nav");
  if (bottomNav) {
      if (screenId === "login" || screenId === "usernameModal" || !screenId) {
          bottomNav.classList.add("hidden");
      } else {
          bottomNav.classList.remove("hidden");
      }
  }
}

const isRedirecting = localStorage.getItem("isRedirecting");
if (isRedirecting) {
  document.getElementById("loading-screen")?.classList.remove("hidden");
  
  // ESCAPE HATCH: Break lock if Firebase hangs for 8 seconds
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
    
    try {
      userEmail = userAuth.email || userAuth.uid; 
      const userRef = db.collection("users").doc(userEmail);
      let doc = await userRef.get();
      
      if (doc.exists && doc.data().banned === true) { alert("SECURITY ALERT: Suspended."); auth.signOut(); return; }
      
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
    // 🔥 BUG 2 FIX: Only show the login screen AFTER Firebase confirms they are logged out!
    if (!localStorage.getItem("isRedirecting")) {
      switchScreen("login");
      document.getElementById("topAvatar")?.classList.add("hidden");
      document.getElementById("loading-screen")?.classList.add("hidden"); // Drop the shield
    }
  }
});

function initializeUserApp(userData) {
  user = userData?.username || "Student"; realName = userData?.name || "Student";
  userAvatar = userData?.avatar || "👤"; googlePfp = userData?.googlePfp || "";
  
  const topAvatarEl = document.getElementById("topAvatar");
  if(topAvatarEl) { topAvatarEl.innerHTML = renderAvatar(userAvatar); topAvatarEl.classList.remove("hidden"); }
  
  db.collection("users").doc(user).set({
      displayName: realName, 
      avatar: userAvatar,
      uid: auth.currentUser.uid
  }, { merge: true });
  
  // Just establish the home screen state here
  history.pushState({ screen: 'home' }, '', window.location.pathname);
  
  switchScreen("home"); 
  loadChatList(); loadEvents();
  document.getElementById("loading-screen")?.classList.add("hidden");
}

// ==========================================
// USERNAME, PROFILE & EVENT LOGIC
// ==========================================

async function checkUsernameAvailability() {
  const input = document.getElementById("newUsername"); const status = document.getElementById("usernameStatus"); const btn = document.getElementById("claimBtn");
  if(!input || !status || !btn) return;
  let val = input.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); input.value = val; 
  if (val.length === 0) { status.innerText = ""; btn.style.background = "#cbd5e1"; btn.disabled = true; btn.style.cursor = "not-allowed"; return; }
  if (val.length < 3) { status.innerText = "Must be at least 3 characters"; status.style.color = "var(--text-muted)"; btn.style.background = "#cbd5e1"; btn.disabled = true; btn.style.cursor = "not-allowed"; return; }
  const usernameDoc = await db.collection("usernames").doc(val).get();
  if (usernameDoc.exists) { status.innerText = "Taken 😔"; status.style.color = "var(--danger)"; btn.style.background = "#cbd5e1"; btn.disabled = true; btn.style.cursor = "not-allowed"; } 
  else { status.innerText = "Available! 🎉"; status.style.color = "var(--success)"; btn.style.background = "var(--primary)"; btn.disabled = false; btn.style.cursor = "pointer"; }
}

async function claimUsername() {
  const chosenName = document.getElementById("newUsername")?.value; if (!chosenName) return;
  try {
    await db.collection("usernames").doc(chosenName).set({ email: userEmail });
    await db.collection("users").doc(userEmail).set({ username: chosenName }, { merge: true });
    const updatedDoc = await db.collection("users").doc(userEmail).get();
    initializeUserApp(updatedDoc.data());
  } catch (error) { alert("Error claiming username."); }
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
  db.collection("users").doc(userEmail).set({ avatar: newAvatar }, { merge: true });
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
function openCreateModal() { document.getElementById("createModal")?.classList.remove("hidden"); const now = new Date(); const inTwoHours = new Date(now.getTime() + (2 * 60 * 60 * 1000)); const formatForInput = (date) => (new Date(date - (date.getTimezoneOffset() * 60000))).toISOString().slice(0, 16); const startEl = document.getElementById("startTime"); const endEl = document.getElementById("endTime"); if(startEl) startEl.value = formatForInput(now); if(endEl) endEl.value = formatForInput(inTwoHours); }
function closeCreateModal() { document.getElementById("createModal")?.classList.add("hidden"); }

function addEvent() {
  const title = document.getElementById("title")?.value.trim(); const place = document.getElementById("place")?.value.trim(); const description = document.getElementById("description")?.value.trim(); const startTimeStr = document.getElementById("startTime")?.value; const endTimeStr = document.getElementById("endTime")?.value;
  if (!title || !place || !startTimeStr || !endTimeStr) return alert("Please fill out all event details.");
  const startTimestamp = new Date(startTimeStr).getTime(); const endTimestamp = new Date(endTimeStr).getTime();
  if (endTimestamp <= startTimestamp) return alert("Your event end time must be AFTER the start time.");
  if (endTimestamp < Date.now()) return alert("You cannot schedule an event to end in the past.");
  
  // 🔥 SECURITY FIX: Stamped with auth.currentUser.uid
  db.collection("events").add({ 
      title, 
      place, 
      description, 
      tag: currentSelectedTag, 
      user, 
      hostAvatar: userAvatar, 
      startTime: startTimestamp, 
      expiresAt: endTimestamp, 
      participants: [user],
      uid: auth.currentUser.uid 
      hypedBy: []
  });
  
  if(document.getElementById("title")) document.getElementById("title").value = ""; if(document.getElementById("place")) document.getElementById("place").value = ""; if(document.getElementById("description")) document.getElementById("description").value = ""; closeCreateModal();
}

function loadEvents() {
  db.collection("events").orderBy("startTime", "desc").onSnapshot(async (snapshot) => {
    const liveList = document.getElementById("events"); const recapList = document.getElementById("recapEvents");
    if(!liveList || !recapList) return;
    
    let eventsArray = [];
    let uniqueUsers = new Set();
    
    snapshot.forEach(doc => {
        const e = doc.data();
        eventsArray.push({ id: doc.id, ...e });
        uniqueUsers.add(e.user); 
        if (e.participants) e.participants.forEach(p => uniqueUsers.add(p)); 
    });

    for (let u of uniqueUsers) {
        if (!userCache[u]) {
            const doc = await db.collection("users").doc(u).get();
            userCache[u] = doc.exists ? doc.data() : { displayName: u, avatar: "👤" };
        }
    }

    liveList.innerHTML = ""; recapList.innerHTML = "";
    let activeCount = 0; let recapCount = 0; const currentTime = Date.now(); const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);
    
    eventsArray.forEach(data => {
      const e = data; const id = data.id; const attendeesCount = e.participants ? e.participants.length : 1;
      
      const hostDisplayName = userCache[e.user]?.displayName || e.user;

      let attendeeNames = "";
      if (e.participants && e.participants.length > 0) {
          const visibleParticipants = e.participants.slice(0, 3);
          attendeeNames = visibleParticipants.map(p => {
              const pDisplayName = userCache[p]?.displayName || p;
              return `<span onclick="event.stopPropagation(); startChat('${p}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${pDisplayName}</span>`;
          }).join(", ");
          
          if (e.participants.length > 3) {
              const extraCount = e.participants.length - 3;
              attendeeNames += ` <span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">+${extraCount} more</span>`;
          }
      } else {
          attendeeNames = `<span onclick="event.stopPropagation(); startChat('${e.user}')" style="color: var(--primary); cursor: pointer; font-weight: 700;">${hostDisplayName}</span>`;
      }

      // 🔥 THE HYPE CALCULATOR
      const hypeCount = e.hypedBy ? e.hypedBy.length : 0;
      const hasHyped = e.hypedBy && e.hypedBy.includes(user);
      const hypeClass = hasHyped ? "hype-btn active" : "hype-btn";
      const hypeIcon = hasHyped ? "bxs-hot" : "bx-hot";
      const hypeHTML = `<button class="${hypeClass}" onclick="toggleHype('${id}', ${hasHyped})"><i class='bx ${hypeIcon}'></i> ${hypeCount > 0 ? hypeCount : 'Hype'}</button>`;
      
      const displayTag = e.tag ? `<div class="event-tag-badge">${e.tag}</div>` : '';
      const displayDesc = e.description ? `<button class="read-more-btn" onclick="toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${e.description}</div>` : '';
      let statusBadge = (currentTime < e.startTime) ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>` : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;
      const avatarHTML = `<div style="display:inline-block; width:24px; height:24px; border-radius:50%; vertical-align:middle; overflow:hidden; border:1px solid var(--border); margin-right:4px;">${renderAvatar(e.hostAvatar)}</div>`;
      const matchesLive = (typeof currentLiveFilter !== 'undefined' ? (currentLiveFilter === 'All' || e.tag === currentLiveFilter) : true);
      const matchesRecap = (typeof currentRecapFilter !== 'undefined' ? (currentRecapFilter === 'All' || e.tag === currentRecapFilter) : true);
      
      if (e.expiresAt > currentTime) {
        if (matchesLive) {
          activeCount++; const hasJoined = e.participants && e.participants.includes(user);
          liveList.innerHTML += `
            <div class="event card" id="event-${id}">
              
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div style="display: flex; gap: 8px;">${displayTag} ${statusBadge}</div>
                ${hypeHTML}
              </div>
              
              <div class="event-title">${e.title}</div>
              <div class="event-meta" style="display:flex; align-items:center;">
                ${avatarHTML} <span>${e.place} • hosted by ${hostDisplayName}</span>
              </div>
              ${displayDesc}
              <div class="attendees">
                <i class='bx bx-group'></i> Going (${attendeesCount}): ${attendeeNames}
              </div>
              
              ${e.user === user 
                ? `<div style="display:flex; gap:8px; margin-top:16px;">
                     <button class="join" style="margin-top:0; flex:2;" onclick="openEventChat('${id}', '${e.title.replace(/'/g, "\\'")}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
                     <button class="delete-btn" style="margin-top:0; flex:1;" onclick="openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage</button>
                   </div>` 
                : (hasJoined 
                   ? `<div style="display:flex; gap:8px; margin-top:16px;">
                        <button class="join" style="margin-top:0; flex:3;" onclick="openEventChat('${id}', '${e.title.replace(/'/g, "\\'")}')"><i class='bx bx-message-square-dots'></i> Open Chat</button>
                        <button class="leave-btn" style="margin-top:0; flex:1;" onclick="leaveEvent('${id}')"><i class='bx bx-exit'></i></button>
                      </div>` 
                   : `<button class="join" onclick="joinEvent('${id}')">Join Hangout</button>`
                  )
              }
            </div>`;
        }
      } else if (e.expiresAt > oneDayAgo) {
        if (matchesRecap) {
          recapCount++;
          recapList.innerHTML += `
            <div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div style="display: flex; gap: 8px;">${displayTag}</div>
                ${hypeHTML}
              </div>
              <div class="event-title" style="color: #4b5563;">${e.title}</div>
              <div class="event-meta" style="display:flex; align-items:center;">${avatarHTML} <span>${e.place} • hosted by ${hostDisplayName}</span></div>
              <div class="attendees" style="background:#f3f4f6; color: var(--text-muted);"><i class='bx bx-check-double'></i> Attended (${attendeesCount}): ${attendeeNames}</div>
            </div>`;
        }
      }
    });
    if (activeCount === 0) liveList.innerHTML = `<div class="empty-state"><i class='bx bx-ghost'></i><p>Nothing matching that filter right now.</p></div>`;
    if (recapCount === 0) recapList.innerHTML = `<div class="empty-state"><i class='bx bx-history'></i><p>No recent history for this filter.</p></div>`;
  });
}

function joinEvent(id) { db.collection("events").doc(id).update({ participants: firebase.firestore.FieldValue.arrayUnion(user) }); }
function leaveEvent(id) { db.collection("events").doc(id).update({ participants: firebase.firestore.FieldValue.arrayRemove(user) }); }
function openDeleteModal(id) { eventIdToManage = id; document.getElementById("deleteModal")?.classList.remove("hidden"); }
function closeDeleteModal() { eventIdToManage = null; document.getElementById("deleteModal")?.classList.add("hidden"); }
function confirmMoveToRecap() { if (!eventIdToManage) return; db.collection("events").doc(eventIdToManage).update({ expiresAt: Date.now() - 1 }).then(() => closeDeleteModal()); }
function confirmDeletePermanently() { if (!eventIdToManage) return; db.collection("events").doc(eventIdToManage).delete().then(() => closeDeleteModal()); }

// ==========================================
// 💬 CHAT ENGINE (SMART UI & INDICATORS)
// ==========================================
let chatDocUnsubscribe = null, currentChatStatus = "unlocked", currentChatInitiator = "", myMessageCount = 0;
let currentChatData = null; 
let typingTimer = null; 
let currentOtherUser = "";
let replyingToMessage = null;

async function checkCrossedPaths(user1, user2) {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); const snap = await db.collection("events").where("participants", "array-contains", user1).get();
  for (let doc of snap.docs) { const e = doc.data(); if (e.participants.includes(user2) && e.expiresAt > oneDayAgo) return true; } return false;
}

async function startChat(clickedUsername = null) {
  let rawOther = clickedUsername || document.getElementById("chatUser")?.value.trim();
  if (!rawOther) return alert("Please enter a username.");
  const other = rawOther.toLowerCase(); 
  if (other === user) return alert("You can't start a chat with yourself!");
  try {
    const usernameDoc = await db.collection("usernames").doc(other).get();
    if (!usernameDoc.exists) return alert(`User "@${other}" does not exist on campus.`);
    const chatId = [user, other].sort().join("_");
    if(!clickedUsername && document.getElementById("chatUser")) document.getElementById("chatUser").value = ""; 
    openChat(chatId, other);
  } catch (error) { alert("Error finding user."); }
}

function openChat(chatId, otherUser) {
  currentChat = chatId; 
  currentOtherUser = otherUser;
  currentChatType = "direct"; 
  
  const hAvatar = document.getElementById("chatHeaderAvatar"); 
  const hTitle = document.getElementById("chatWithTitle");
  
  if(hAvatar) hAvatar.innerHTML = renderAvatar("👤"); 
  if(hTitle) hTitle.innerText = otherUser;

  // 🔥 THE FIX: Instantly wipe the chat window clean
  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";
  
  db.collection("users").doc(otherUser).get().then(doc => {
      if (doc.exists) {
          const d = doc.data();
          userCache[otherUser] = d; 
          if(hAvatar) hAvatar.innerHTML = renderAvatar(d.avatar || "👤");
          if(hTitle) hTitle.innerText = d.displayName || otherUser;
          
          hAvatar.style.cursor = "pointer";
          hAvatar.onclick = () => openProfileScreen(otherUser);
          hTitle.style.cursor = "pointer";
          hTitle.onclick = () => openProfileScreen(otherUser);
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
         
         if (currentChatData.unreadBy === user) {
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
  if (currentChat) db.collection("chats").doc(currentChat).set({ typing: "" }, { merge: true }); 
  currentChat = null; currentChatData = null; currentOtherUser = ""; // 🔥 CLEAR IT
  if (messagesUnsubscribe) messagesUnsubscribe(); if (chatDocUnsubscribe) chatDocUnsubscribe();
  document.querySelector(".topbar")?.classList.remove("hidden"); switchScreen("home");
}

async function sendMessage() {
  const input = document.getElementById("msgInput"); if(!input) return; 
  const text = input.value.trim(); if (!text || !currentChat) return;
  
  // 1. Grab reply data if it exists
  const replyData = replyingToMessage ? { sender: replyingToMessage.sender, text: replyingToMessage.text, time: replyingToMessage.time } : null;
  replyingToMessage = null; 

  // 2. ALWAYS send the message to the screen immediately
  await db.collection("messages").add({ 
      chatId: currentChat, 
      sender: user, 
      text: text, 
      time: Date.now(), 
      replyTo: replyData,
      uid: auth.currentUser.uid // 🔥 SECURITY FIX: Un-fakeable ID stamp
  });

  // 3. Route the background updates (Typing indicators & Read Receipts)
  if (currentChatType === "event") {
      // EVENT ROUTE: Just clear the typing status
      await db.collection("events").doc(currentChat).update({ 
          typingUsers: firebase.firestore.FieldValue.arrayRemove(user) 
      }).catch(()=>{}); // Catch prevents crashes if array doesn't exist yet
  } else {
      // DIRECT ROUTE: Update read receipts and Icebreakers
      const otherUser = currentOtherUser; 
      const chatRef = db.collection("chats").doc(currentChat); 
      const chatDoc = await chatRef.get(); 
      let newStatus = currentChatStatus;
      
      if (!chatDoc.exists || !chatDoc.data().status) {
          const crossedPaths = await checkCrossedPaths(user, otherUser); 
          newStatus = crossedPaths ? "unlocked" : "icebreaker";
      } else {
          if (currentChatStatus === "icebreaker" && currentChatInitiator === otherUser) newStatus = "unlocked"; 
      }
      
      await chatRef.set({ 
          users: [user, otherUser], 
          unreadBy: otherUser, 
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
      // Event Chat: Add user to an array
      db.collection("events").doc(currentChat).update({
          typingUsers: firebase.firestore.FieldValue.arrayUnion(user)
      });
      
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
          if (currentChat) db.collection("events").doc(currentChat).update({ typingUsers: firebase.firestore.FieldValue.arrayRemove(user) }).catch(()=>{});
      }, 1500);
  } else {
      // Direct Chat: Simple string override
      db.collection("chats").doc(currentChat).set({ typing: user }, { merge: true });
      
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
          if (currentChat) db.collection("chats").doc(currentChat).set({ typing: "" }, { merge: true });
      }, 1500);
  }
}

// 🔥 UPGRADE: Now accepts the 'time' parameter
function initiateReply(sender, text, time) {
  replyingToMessage = { sender, text, time };
  updateChatFooterUI();
  
  setTimeout(() => {
      const input = document.getElementById("msgInput");
      if(input) { 
          input.focus(); 
          input.scrollIntoView({ behavior: "smooth", block: "nearest" }); 
      }
  }, 50);
}

function cancelReply() {
  replyingToMessage = null;
  updateChatFooterUI();
  // Ensure the input keeps focus
  const input = document.getElementById("msgInput");
  if(input) input.focus();
}

function scrollToMessage(time) {
    const targetMsg = document.getElementById(`msg-${time}`);
    if (!targetMsg) return;

    const bubble = targetMsg.querySelector(".msg-bubble");
    if (!bubble) return;

    // 1. Scroll
    targetMsg.scrollIntoView({ behavior: "smooth", block: "center" });

    // 2. Determine color
    const isSent = bubble.classList.contains("msg-sent");
    const flashClass = isSent ? "flash-sent" : "flash-received";

    // 3. Force browser to recognize the class change
    bubble.classList.remove("flash-sent", "flash-received");
    void bubble.offsetWidth; // The magic line that forces the browser to re-paint
    bubble.classList.add(flashClass);

    // 4. Cleanup
    setTimeout(() => {
        bubble.classList.remove(flashClass);
    }, 1600);
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
      const typists = (currentEventData.typingUsers || []).filter(u => u !== user);
      
      if (typists.length > 0) {
          if (nameEl) {
              // 🔥 BUG 3A FIX: Use the smart cache to show real display names!
              const displayName = userCache[typists[0]]?.displayName || typists[0];
              nameEl.innerText = typists.length === 1 ? `${displayName} is typing` : `${typists.length} people typing`;
          }
          bubble.classList.remove("hidden"); 
          box.scrollTop = box.scrollHeight;
      } else {
          bubble.classList.add("hidden");
      }
      
  } else if (currentChatType === "direct" && currentChatData) {
      if (currentChatData.typing === currentOtherUser) { 
          if (nameEl) nameEl.innerText = ""; 
          bubble.classList.remove("hidden"); 
          box.scrollTop = box.scrollHeight; 
      } else { 
          bubble.classList.add("hidden"); 
      }
  }
}

let scrollTimeout = null; // Global timer for the fade effect

function handleChatScroll() {
  const box = document.getElementById("messages");
  let floatingDate = document.getElementById("floatingDate");
  
  // 1. Create the glass badge if it doesn't exist yet
  if (!floatingDate) {
      floatingDate = document.createElement("div");
      floatingDate.id = "floatingDate";
      floatingDate.className = "floating-date";
      document.getElementById("chatScreen").appendChild(floatingDate);
  }
  
  const dateWrappers = box.getElementsByClassName("date-separator");
  let activeDateText = "";
  
  // 2. Calculate exactly which date your thumb is scrolling past
  const boxRect = box.getBoundingClientRect();
  for (let el of dateWrappers) {
      const rect = el.getBoundingClientRect();
      if (rect.top <= boxRect.top + 60) {
          activeDateText = el.innerText;
      }
  }
  
  // 3. Show the glass badge and reset the 1-second fade-out timer
  if (activeDateText) {
      floatingDate.innerText = activeDateText;
      floatingDate.classList.add("visible");
      
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
          floatingDate.classList.remove("visible");
      }, 1200); // Fades out exactly 1.2 seconds after you stop scrolling
  }
}

function loadMessages() {
  if (messagesUnsubscribe) messagesUnsubscribe(); 
  const box = document.getElementById("messages"); if(!box) return;
  
  if (!box.dataset.hasScrollListener) { box.addEventListener("scroll", handleChatScroll); box.dataset.hasScrollListener = "true"; }
  
  // Notice the 'async' added here!
  messagesUnsubscribe = db.collection("messages").where("chatId", "==", currentChat).onSnapshot(async (snapshot) => {
      let lastDateString = ""; myMessageCount = 0; let theirMessageCount = 0;
      let msgs = []; snapshot.forEach(doc => msgs.push(doc.data())); msgs.sort((a, b) => a.time - b.time); 
      
      // ==========================================
      // 🧠 THE SMART CACHE DICTIONARY ENGINE
      // ==========================================
      const uniqueSenders = [...new Set(msgs.map(m => m.sender))];
      
      for (let s of uniqueSenders) {
          if (!userCache[s]) {
              const doc = await db.collection("users").doc(s).get();
              userCache[s] = doc.exists ? doc.data() : { displayName: s, avatar: "👤" };
          }
      }

      let newHTML = "";

      msgs.forEach((m, i) => {
        const isMe = m.sender === user; if(isMe) myMessageCount++; else theirMessageCount++;
        const msgDate = new Date(m.time).toLocaleDateString();
        
        if (msgDate !== lastDateString) { 
            let displayDate = ""; const today = new Date().toLocaleDateString(); const yesterdayObj = new Date(); yesterdayObj.setDate(yesterdayObj.getDate() - 1); const yesterday = yesterdayObj.toLocaleDateString(); 
            if (msgDate === today) displayDate = "Today"; else if (msgDate === yesterday) displayDate = "Yesterday"; else displayDate = new Date(m.time).toLocaleDateString([], { month: 'short', day: 'numeric' }); 
            newHTML += `<div class="date-wrapper"><div class="date-separator">${displayDate}</div></div>`; lastDateString = msgDate; 
        }

        const prev = msgs[i - 1]; const next = msgs[i + 1];
        const isSamePrev = prev && prev.sender === m.sender; const isSameNext = next && next.sender === m.sender;
        let shape = "single"; if (isSamePrev && isSameNext) shape = "middle"; else if (!isSamePrev && isSameNext) shape = "first"; else if (isSamePrev && !isSameNext) shape = "last";

        const safeText = m.text.replace(/[`$'\\]/g, ""); 
        const encodedText = encodeURIComponent(m.text); 
        
        // 🔥 THE NEW CHECK: Is this message ONLY a Youtube or Spotify link?
        const rawText = m.text.trim();
        const isMediaOnly = /^https?:\/\/[^\s]+$/.test(rawText) && (rawText.includes("youtube.com") || rawText.includes("youtu.be") || rawText.includes("spotify.com"));
        
        // 🔥 THE NEW CLASS: Applies the invisible background if true
        const bubbleClass = isMediaOnly ? 'msg-bubble media-only' : 'msg-bubble';

        let replyBlock = "";
        if (m.replyTo) {
            const replyName = m.replyTo.sender === user ? "You" : (userCache[m.replyTo.sender]?.displayName || m.replyTo.sender);
            const timeData = m.replyTo.time ? `data-target-time="${m.replyTo.time}"` : "";
            replyBlock = `<div class="msg-replied-to" ${timeData}><b>${replyName}:</b> ${m.replyTo.text}</div>`;
        }

        const swipeIconHTML = isMe 
            ? `<div class="swipe-reply-icon right"><i class='bx bx-reply' style="transform: scaleX(-1);"></i></div>` 
            : `<div class="swipe-reply-icon left"><i class='bx bx-reply'></i></div>`;

        let nameTagHTML = "";
        
        if (currentChatType === "event" && !isMe && !isSamePrev) {
            const senderDisplayName = userCache[m.sender]?.displayName || m.sender;
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
      
      if (currentChatStatus === "icebreaker" && theirMessageCount > 0 && currentChatInitiator === user) { db.collection("chats").doc(currentChat).update({ status: "unlocked" }); }
      box.scrollTop = box.scrollHeight; 
      updateChatFooterUI(); updateReadReceipts(); updateTypingIndicator();
    });
}

function updateChatFooterUI() {
  const icebreakerMsg = document.getElementById("icebreakerMsg");
  const inputWrapper = document.getElementById("inputWrapper");
  const previewContainer = document.getElementById("replyPreviewContainer");
  
  if (!icebreakerMsg || !inputWrapper || !previewContainer) return;

  // 1. Manage Icebreaker Lock
  if (currentChatStatus === "icebreaker" && currentChatInitiator === user && myMessageCount >= 1) {
      icebreakerMsg.classList.remove("hidden");
      inputWrapper.classList.add("hidden");
      previewContainer.classList.add("hidden");
      return;
  } else {
      icebreakerMsg.classList.add("hidden");
      inputWrapper.classList.remove("hidden");
      previewContainer.classList.remove("hidden");
  }

  // 2. Safely Update the Reply Bar
  if (replyingToMessage) {
      const name = replyingToMessage.sender === user ? "Yourself" : replyingToMessage.sender;
      previewContainer.innerHTML = `
        <div style="background: rgba(79, 70, 229, 0.1); padding: 8px 12px; border-radius: 12px; border-left: 4px solid var(--primary); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
             <div style="color: var(--primary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
                <b>Replying to ${name}:</b><br>${replyingToMessage.text}
             </div>
             <div onclick="cancelReply()" style="cursor: pointer; color: var(--danger); margin-left: 10px; font-size: 20px;"><i class='bx bx-x'></i></div>
        </div>`;
  } else {
      previewContainer.innerHTML = "";
  }
}

function loadChatList() {
  // Notice the async added here!
  db.collection("chats").where("users", "array-contains", user).onSnapshot(async (snapshot) => {
      const list = document.getElementById("chatList"); if(!list) return;
      let hasGlobalUnread = false; let chatsArray = [];
      
      snapshot.docChanges().forEach(change => { 
        if (change.type === "modified") { 
          const chatData = change.doc.data(); 
          if (chatData.unreadBy === user && currentChat !== change.doc.id) { 
            const otherUser = (chatData.users && Array.isArray(chatData.users)) 
                ? chatData.users.find(u => u !== user) 
                : change.doc.id.replace(user, "").replace("_", "");
            showNotification(otherUser, change.doc.id); 
          } 
        } 
      });
      
      snapshot.forEach(doc => { chatsArray.push({ id: doc.id, ...doc.data() }); }); 
      chatsArray.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
      
      // ==========================================
      // 🧠 CHAT LIST DICTIONARY SYNC
      // ==========================================
      const uniqueOthers = [...new Set(chatsArray.map(chat => 
          (chat.users && Array.isArray(chat.users)) ? chat.users.find(u => u !== user) : chat.id.replace(user, "").replace("_", "")
      ))];
      
      // Fetch missing profiles into the cache
      for (let other of uniqueOthers) {
          if (!userCache[other]) {
              const doc = await db.collection("users").doc(other).get();
              userCache[other] = doc.exists ? doc.data() : { displayName: other, avatar: "👤" };
          }
      }
      // ==========================================

      list.innerHTML = "";
      if (chatsArray.length === 0) {
          list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;
          return;
      }
      
      chatsArray.forEach(chat => {
        let other = (chat.users && Array.isArray(chat.users)) ? chat.users.find(u => u !== user) : chat.id.replace(user, "").replace("_", "");

        if (chat.unreadBy === user && currentChat === chat.id) { db.collection("chats").doc(chat.id).set({ unreadBy: "" }, { merge: true }); chat.unreadBy = ""; }
        
        const isUnread = chat.unreadBy === user; 
        if (isUnread) hasGlobalUnread = true;
        
        // 🔥 Pull their data out of the Cache!
        const cachedUser = userCache[other] || {};
        const displayName = cachedUser.displayName || other;
        const avatarCode = cachedUser.avatar || "👤";
        
        const unreadStyles = isUnread ? 'background: #e0e7ff; border-left: 4px solid var(--primary);' : '';
        const nameStyles = isUnread ? 'font-weight: 800;' : '';
        const dotHTML = isUnread ? `<div class="unread-pulse-dot"></div>` : '';
        
        list.innerHTML += `
          <div class="chat-item" onclick="openChat('${chat.id}', '${other}')" style="${unreadStyles}">
            <div class="chat-avatar" style="background: transparent; border: 1px solid var(--border); padding: 0; overflow: hidden;">
                ${renderAvatar(avatarCode)}
            </div>
            <div class="chat-name" style="${nameStyles}; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayName}</div>
            ${dotHTML}
          </div>
        `;
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

function openProfileScreen(targetUsername = null) {
    document.getElementById("home").classList.add("hidden");
    document.getElementById("profileScreen").classList.remove("hidden");

    history.pushState({ screen: 'profile' }, '', window.location.href);
    
    // If no target provided, default to yourself
    currentProfileView = targetUsername || user; 
    loadProfileUI(currentProfileView); 
}

function closeProfileScreen() {
    document.getElementById("profileScreen").classList.add("hidden");
    document.getElementById("home").classList.remove("hidden");
    currentProfileView = ""; 
}

// 🔥 THE FIX: Create a global variable to track the live listener
let profileEventsUnsubscribe = null;

function loadUserEvents(targetUser) {
    const list = document.getElementById("myProfileEvents");
    if (!list) return;
    
    // 🔥 THE FIX: Kill the previous person's listener before starting a new one!
    if (profileEventsUnsubscribe) profileEventsUnsubscribe();
    
    profileEventsUnsubscribe = db.collection("events").where("user", "==", targetUser).onSnapshot(snapshot => {
          list.innerHTML = "";
          let eventsArray = [];
          snapshot.forEach(doc => eventsArray.push({ id: doc.id, ...doc.data() }));
          eventsArray.sort((a, b) => b.startTime - a.startTime);
          
          if (eventsArray.length === 0) {
              list.innerHTML = `<div class="empty-state" style="padding: 20px;"><i class='bx bx-ghost'></i><p>No hosted events yet.</p></div>`;
              return;
          }

          eventsArray.forEach(e => {
              list.innerHTML += `
                <div class="card" style="padding: 16px; margin-bottom: 12px; box-shadow: none; border: 1px solid var(--border);">
                  <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">${e.title}</div>
                  <div style="font-size: 12px; color: var(--text-muted);"><i class='bx bx-map'></i> ${e.place}</div>
                </div>
              `;
          });
      }, error => { console.error("Error loading events:", error); });
}

document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("login-btn"); if (loginBtn) { loginBtn.addEventListener("click", () => loginWithGoogle()); }
  const claimBtn = document.getElementById("claimBtn"); if (claimBtn) { claimBtn.addEventListener("click", async () => { const loadingScreen = document.getElementById("loading-screen"); if (loadingScreen) loadingScreen.classList.remove("hidden"); await claimUsername(); }); }
});

// ==========================================
// 🔔 DESKTOP OS NOTIFICATION UNLOCKER
// ==========================================
// Browsers require a physical click to unlock native notifications. 
// This listens for their very first click anywhere on the page and unlocks them.
document.addEventListener("click", () => {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") console.log("Desktop notifications enabled!");
    });
  }
}, { once: true });

// ==========================================
// 🖱️ + 📲 HYBRID SWIPE TO REPLY ENGINE
// ==========================================
let startX = 0, startY = 0, currentSwipeItem = null, isSwiping = false, swipeDirection = 0;

function handleDragStart(e) {
    const wrapper = e.target.closest(".msg-wrapper");
    if (!wrapper) return;
    
    // Supports both Mouse and Touch
    const touch = e.type.includes("mouse") ? e : e.touches[0];
    startX = touch.clientX; 
    startY = touch.clientY;
    
    currentSwipeItem = wrapper; 
    isSwiping = false;
    wrapper.style.transition = "none"; 
    
    const isSent = wrapper.querySelector(".msg-sent") !== null;
    swipeDirection = isSent ? -1 : 1; 
}

function handleDragMove(e) {
    if (!currentSwipeItem) return;
    
    const touch = e.type.includes("mouse") ? e : e.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    // If moving up/down, let the user scroll normally
    if (!isSwiping && Math.abs(deltaY) > Math.abs(deltaX)) { 
        currentSwipeItem = null; 
        return; 
    }

    // Lock into horizontal swipe mode
    if ((swipeDirection === 1 && deltaX > 10) || (swipeDirection === -1 && deltaX < -10)) {
        isSwiping = true;
        // 🔥 THE FIX: Tells the mobile browser "Stop scrolling, I am dragging!"
        if(e.cancelable) e.preventDefault(); 
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
        const sender = currentSwipeItem.getAttribute("data-sender");
        const text = decodeURIComponent(currentSwipeItem.getAttribute("data-text"));
        // 🔥 THE FIX: Safely grabs the timestamp so the swipe doesn't glitch!
        const time = parseInt(currentSwipeItem.getAttribute("data-time"));
        
        initiateReply(sender, text, time);
        if (navigator.vibrate) navigator.vibrate(50); 
    }
    
    currentSwipeItem.style.transition = "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
    currentSwipeItem.style.transform = "translateX(0px)";
    currentSwipeItem.classList.remove("ready-to-reply");
    currentSwipeItem = null; 
    isSwiping = false;
}

// Attach Desktop Mouse Listeners
document.addEventListener("mousedown", handleDragStart);
document.addEventListener("mousemove", handleDragMove);
document.addEventListener("mouseup", handleDragEnd);

// Attach Mobile Touch Listeners (passive: false is REQUIRED to stop screen sliding)
document.addEventListener("touchstart", handleDragStart, { passive: false });
document.addEventListener("touchmove", handleDragMove, { passive: false });
document.addEventListener("touchend", handleDragEnd);

// Event Chat System
function openEventChat(eventId, eventTitle) {
  currentChat = eventId; 
  currentChatType = "event"; 
  currentChatStatus = "unlocked"; 
  currentChatData = { status: "unlocked", typing: "" }; 
  
  const hAvatar = document.getElementById("chatHeaderAvatar"); 
  const hTitle = document.getElementById("chatWithTitle");
  if(hAvatar) hAvatar.innerText = "📅"; 
  if(hTitle) hTitle.innerText = eventTitle;

  // 🔥 THE FIX: Instantly wipe the chat window clean
  const box = document.getElementById("messages");
  if (box) box.innerHTML = "";
  
  document.querySelector(".topbar")?.classList.add("hidden"); 
  switchScreen("chatScreen");
  
  if(chatDocUnsubscribe) { chatDocUnsubscribe(); chatDocUnsubscribe = null; }
  
  chatDocUnsubscribe = db.collection("events").doc(eventId).onSnapshot(doc => {
      if(doc.exists) {
          currentEventData = doc.data();
          updateTypingIndicator();
      }
  });
  
  updateChatFooterUI();
  loadMessages();
}

// ==========================================
// BUG 1 & 5 FIX: DYNAMIC STATS & AVATAR
// ==========================================
// 3. Dynamic Data Loading
async function loadProfileUI(targetUser) {
    if (!targetUser) return; 

    const avatarEl = document.getElementById("profileAvatarDisplay");
    const nameDisplay = document.getElementById("profileDisplayNameDisplay");
    const usernameDisplay = document.getElementById("profileUsernameDisplay");
    const settingsGear = document.getElementById("profileSettingsBtn");
    const editInput = document.getElementById("editDisplayNameInput"); 
    
    // 🔥 INSTANT WIPE: Destroy the previous user's profile data instantly!
    if (avatarEl) avatarEl.innerHTML = renderAvatar("👤");
    if (nameDisplay) nameDisplay.innerText = "Loading...";
    if (usernameDisplay) usernameDisplay.innerText = targetUser; // 🔥 Removed the @ here!
    
    const statJoined = document.getElementById("statEventsJoined");
    const statHosted = document.getElementById("statEventsHosted");
    const eventsList = document.getElementById("myProfileEvents");
    
    if (statJoined) statJoined.innerText = "-";
    if (statHosted) statHosted.innerText = "-";
    if (eventsList) eventsList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size: 13px;"><i class='bx bx-loader-alt bx-spin'></i> Loading...</div>`;
    
    let cachedUser = userCache[targetUser];
    
    // Quick visual update from cache before DB loads
    if (cachedUser) {
        if (avatarEl && cachedUser.avatar) avatarEl.innerHTML = renderAvatar(cachedUser.avatar);
        if (nameDisplay && cachedUser.displayName) nameDisplay.innerText = cachedUser.displayName;
    }
    
    if (targetUser === user) { settingsGear.classList.remove("hidden"); } 
    else { settingsGear.classList.add("hidden"); }
    
    try {
        const userDoc = await db.collection("users").doc(targetUser).get();
        if (userDoc.exists) {
            const data = userDoc.data();
            userCache[targetUser] = data; 
            
            if (avatarEl) avatarEl.innerHTML = renderAvatar(data.avatar || "👤");
            if (nameDisplay) nameDisplay.innerText = data.displayName || targetUser;

            if (targetUser === user && editInput) {
                userDisplayName = data.displayName || targetUser;
                editInput.value = userDisplayName;
            }
        } else {
            // 🔥 THE FIX: If they have never logged in, officially assign them a default profile!
            if (nameDisplay) nameDisplay.innerText = targetUser; 
        }
        
        db.collection("events").where("user", "==", targetUser).get().then(snap => {
            if(statHosted) statHosted.innerText = snap.size || 0;
        });
        db.collection("events").where("participants", "array-contains", targetUser).get().then(snap => {
            if(statJoined) statJoined.innerText = snap.size || 0;
        });

        loadUserEvents(targetUser);
    } catch(e) { console.error("Profile load error:", e); }
}

// Function triggered by the "Save Profile" button
async function saveProfileData() {
    const nameInput = document.getElementById("editDisplayNameInput");
    const btn = document.getElementById("saveProfileBtn");
    const newName = nameInput.value.trim();
    if (!newName) return alert("Display Name cannot be empty!");

    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
    btn.disabled = true;

    try {
        // 🔥 SECURITY FIX: Stamping the UID so the database knows you own this profile
        await db.collection("users").doc(user).set({ 
            displayName: newName, 
            updatedAt: Date.now(),
            uid: auth.currentUser.uid
        }, { merge: true });
        
        userDisplayName = newName; // Update local memory
        
        // Instantly update the public card behind the modal
        const displayEl = document.getElementById("profileDisplayNameDisplay");
        if (displayEl) displayEl.innerText = newName;
        
        btn.style.background = "var(--success)";
        btn.innerHTML = `<i class='bx bx-check'></i> Saved!`;
        
        setTimeout(() => {
            btn.style.background = "var(--primary)";
            btn.innerHTML = originalText;
            btn.disabled = false;
            closeSettingsModal(); // Auto-close the modal!
        }, 800);

    } catch (e) {
        alert("Failed to save profile. Please check your connection.");
        btn.innerHTML = originalText; btn.disabled = false;
    }
}

function openSettingsModal() { document.getElementById("settingsModal")?.classList.remove("hidden"); }
function closeSettingsModal() { document.getElementById("settingsModal")?.classList.add("hidden"); }

// ==========================================
// 🛡️ STEALTH MODE NATIVE BACK BUTTON
// ==========================================
window.addEventListener('popstate', (event) => {
    if (currentChat) {
        closeChat();
    } else if (currentProfileView && currentProfileView !== "") {
        closeProfileScreen();
    } else if (auth.currentUser) {
        // 🔥 THE ULTIMATE TRAP: If they are logged in and swipe back on the home screen,
        // we instantly throw a new "page" into the history stack so they can NEVER reach Google!
        history.pushState(null, '', window.location.href);
    }
});

// ==========================================
// 🔥 EVENT HYPE LOGIC
// ==========================================
function toggleHype(id, isHyped) {
    if (event) event.stopPropagation(); // Prevents the screen from jumping
    
    const eventRef = db.collection("events").doc(id);
    
    if (isHyped) {
        eventRef.update({ hypedBy: firebase.firestore.FieldValue.arrayRemove(user) });
    } else {
        eventRef.update({ hypedBy: firebase.firestore.FieldValue.arrayUnion(user) });
        if (navigator.vibrate) navigator.vibrate(50); // Haptic feedback on mobile!
    }
}
