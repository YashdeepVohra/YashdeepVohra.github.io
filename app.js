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
let messagesUnsubscribe = null, eventIdToManage = null;
let currentSelectedTag = '☕ Chill', googlePfp = "", realName = "";
let currentLiveFilter = 'All', currentRecapFilter = 'All';

function renderAvatar(avatarCode) {
  if (!avatarCode) return "👤";
  if (typeof avatarCode === 'string' && avatarCode.startsWith("http")) return `<img src="${avatarCode}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
  return avatarCode;
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

  // Clear previous notifications so they never stack
  toastBox.innerHTML = "";

  const toast = document.createElement("div");
  toast.style.cssText = "background: var(--primary); color: white; padding: 14px 20px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); font-size: 14px; font-weight: 600; cursor: pointer; transform: translateY(-150%); transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; align-items: center; gap: 10px; width: 100%; pointer-events: auto;";
  toast.innerHTML = `<i class='bx bxs-message-rounded-dots' style="font-size: 20px;"></i> New message from @${senderUsername}`;

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
    document.getElementById("loading-screen")?.classList.remove("hidden");
    
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
    if (!localStorage.getItem("isRedirecting")) {
      switchScreen("login");
      document.getElementById("topAvatar")?.classList.add("hidden");
      document.getElementById("loading-screen")?.classList.add("hidden");
    }
  }
});

function initializeUserApp(userData) {
  user = userData?.username || "Student"; realName = userData?.name || "Student";
  userAvatar = userData?.avatar || "👤"; googlePfp = userData?.googlePfp || "";
  
  const topAvatarEl = document.getElementById("topAvatar");
  if(topAvatarEl) { topAvatarEl.innerHTML = renderAvatar(userAvatar); topAvatarEl.classList.remove("hidden"); }
  
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
  db.collection("events").add({ title, place, description, tag: currentSelectedTag, user, hostAvatar: userAvatar, startTime: startTimestamp, expiresAt: endTimestamp, participants: [user] });
  if(document.getElementById("title")) document.getElementById("title").value = ""; if(document.getElementById("place")) document.getElementById("place").value = ""; if(document.getElementById("description")) document.getElementById("description").value = ""; closeCreateModal();
}

function loadEvents() {
  db.collection("events").orderBy("startTime", "desc").onSnapshot(snapshot => {
    const liveList = document.getElementById("events"); const recapList = document.getElementById("recapEvents");
    if(!liveList || !recapList) return;
    liveList.innerHTML = ""; recapList.innerHTML = "";
    let activeCount = 0; let recapCount = 0; const currentTime = Date.now(); const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);
    snapshot.forEach(doc => {
      const e = doc.data(); const id = doc.id; const attendeesCount = e.participants ? e.participants.length : 1;
      const attendeeNames = e.participants ? e.participants.map(p => `<span onclick="event.stopPropagation(); startChat('${p}')" style="color: var(--primary); cursor: pointer;">@${p}</span>`).join(", ") : `<span onclick="event.stopPropagation(); startChat('${e.user}')" style="color: var(--primary); cursor: pointer;">@${e.user}</span>`;
      const displayTag = e.tag ? `<div class="event-tag-badge">${e.tag}</div>` : '';
      const displayDesc = e.description ? `<button class="read-more-btn" onclick="toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${e.description}</div>` : '';
      let statusBadge = (currentTime < e.startTime) ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>` : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;
      const avatarHTML = `<div style="display:inline-block; width:24px; height:24px; border-radius:50%; vertical-align:middle; overflow:hidden; border:1px solid var(--border); margin-right:4px;">${renderAvatar(e.hostAvatar)}</div>`;
      const matchesLive = (typeof currentLiveFilter !== 'undefined' ? (currentLiveFilter === 'All' || e.tag === currentLiveFilter) : true);
      const matchesRecap = (typeof currentRecapFilter !== 'undefined' ? (currentRecapFilter === 'All' || e.tag === currentRecapFilter) : true);
      if (e.expiresAt > currentTime) {
        if (matchesLive) {
          activeCount++; const hasJoined = e.participants && e.participants.includes(user);
          liveList.innerHTML += `<div class="event card" id="event-${id}"><div style="display: flex; justify-content: space-between; align-items: flex-start;">${displayTag} ${statusBadge}</div><div class="event-title">${e.title}</div><div class="event-meta" style="display:flex; align-items:center;">${avatarHTML} <span>${e.place} • hosted by @${e.user}</span></div>${displayDesc}<div class="attendees"><i class='bx bx-group'></i> Going (${attendeesCount}): ${attendeeNames}</div>${e.user === user ? `<button class="delete-btn" onclick="openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage Event</button>` : (hasJoined ? `<button class="leave-btn" onclick="leaveEvent('${id}')"><i class='bx bx-exit'></i> Leave Hangout</button>` : `<button class="join" onclick="joinEvent('${id}')">Join Hangout</button>`)}</div>`;
        }
      } else if (e.expiresAt > oneDayAgo) {
        if (matchesRecap) {
          recapCount++;
          recapList.innerHTML += `<div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">${displayTag}<div class="event-title" style="color: #4b5563;">${e.title}</div><div class="event-meta" style="display:flex; align-items:center;">${avatarHTML} <span>${e.place} • hosted by @${e.user}</span></div><div class="attendees" style="background:#f3f4f6; color: var(--text-muted);"><i class='bx bx-check-double'></i> Attended (${attendeesCount}): ${attendeeNames}</div></div>`;
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
  
  const hAvatar = document.getElementById("chatHeaderAvatar"); 
  const hTitle = document.getElementById("chatWithTitle");
  if(hAvatar) hAvatar.innerText = otherUser.charAt(0).toUpperCase(); 
  if(hTitle) hTitle.innerText = otherUser;
  
  document.querySelector(".topbar")?.classList.add("hidden"); switchScreen("chatScreen");
  
  if(chatDocUnsubscribe) chatDocUnsubscribe();
  chatDocUnsubscribe = db.collection("chats").doc(chatId).onSnapshot(doc => {
     if(doc.exists) { 
         currentChatData = doc.data(); 
         currentChatStatus = currentChatData.status || "unlocked"; 
         currentChatInitiator = currentChatData.initiatedBy || ""; 
         
         // 🔥 THE FIX: ONLY wipe the unread tag if the message was actually unread by YOU
         if (currentChatData.unreadBy === user) {
             db.collection("chats").doc(chatId).set({ unreadBy: "" }, { merge: true });
             currentChatData.unreadBy = ""; // Instantly update locally so UI doesn't lag
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
  
  // 🔥 UPGRADE: We now save the 'time' into the Firebase database!
  const replyData = replyingToMessage ? { sender: replyingToMessage.sender, text: replyingToMessage.text, time: replyingToMessage.time } : null;
  replyingToMessage = null; 
  
  await chatRef.set({ users: [user, otherUser], unreadBy: otherUser, lastUpdated: Date.now(), status: newStatus, typing: "" }, { merge: true });
  await db.collection("messages").add({ chatId: currentChat, sender: user, text: text, time: Date.now(), replyTo: replyData }); 
  
  input.value = "";
  updateChatFooterUI(); 
}

function handleTyping() {
  if (!currentChat) return;
  db.collection("chats").doc(currentChat).set({ typing: user }, { merge: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
      if (currentChat) db.collection("chats").doc(currentChat).set({ typing: "" }, { merge: true });
  }, 1500);
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
}

function scrollToMessage(time) {
    const targetMsg = document.getElementById(`msg-${time}`);
    const chatBox = document.getElementById("messages");
    if (!targetMsg || !chatBox) return;

    const bubble = targetMsg.querySelector(".msg-bubble");
    if (!bubble) return;

    // 1. The Graphics Engine
    const playGlow = () => {
        // Cancels any stuck animations if you double-tap fast
        if (typeof bubble.getAnimations === 'function') {
            bubble.getAnimations().forEach(anim => anim.cancel());
        }

        const isSent = bubble.classList.contains("msg-sent");
        const glowColor = isSent ? "rgba(255, 255, 255, 0.9)" : "var(--primary)";

        bubble.animate([
            { transform: "scale(1)", filter: "brightness(1)", boxShadow: "0 0 0 0px transparent" },
            { transform: "scale(1.03)", filter: "brightness(1.15)", boxShadow: `0 0 0 4px ${glowColor}`, offset: 0.15 },
            { transform: "scale(1)", filter: "brightness(1)", boxShadow: "0 0 0 0px transparent" }
        ], { duration: 1300, easing: "cubic-bezier(0.175, 0.885, 0.32, 1.275)" });
    };

    // 2. Trigger the smooth scroll normally (back to center)
    targetMsg.scrollIntoView({ behavior: "smooth", block: "center" });

    // 3. The Smart Scroll Tracker
    let isScrolling = false;
    let scrollTimeout;

    const scrollHandler = () => {
        isScrolling = true; // We detect movement!
        clearTimeout(scrollTimeout);
        
        // Every time the screen moves a pixel, this 60ms timer resets.
        // When the screen finally stops moving for 60ms, the scroll is officially done.
        scrollTimeout = setTimeout(() => {
            chatBox.removeEventListener('scroll', scrollHandler);
            playGlow();
        }, 60);
    };

    chatBox.addEventListener('scroll', scrollHandler);

    // 4. The Failsafe (Fixes the "On Screen / Didn't Move" Bug)
    // If we tell it to scroll, but 100ms pass and the screen NEVER moved,
    // it means the message was already right in front of us. Just play the glow!
    setTimeout(() => {
        if (!isScrolling) {
            chatBox.removeEventListener('scroll', scrollHandler);
            playGlow();
        }
    }, 100);
}

function updateReadReceipts() {
  const receipt = document.getElementById("readReceipt");
  if (receipt && currentChatData) {
      if (currentChatData.unreadBy === "") receipt.innerHTML = `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>`;
      else receipt.innerHTML = `Sent <i class='bx bx-check'></i>`;
  }
}

function updateTypingIndicator() {
  const bubble = document.getElementById("typingBubble"); const box = document.getElementById("messages");
  if (bubble && currentChatData) {
      const otherUser = currentOtherUser; // 🔥 FIXED
      if (currentChatData.typing === otherUser) { bubble.classList.remove("hidden"); box.scrollTop = box.scrollHeight; } 
      else { bubble.classList.add("hidden"); }
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
  
  messagesUnsubscribe = db.collection("messages").where("chatId", "==", currentChat).onSnapshot(snapshot => {
      let lastDateString = ""; myMessageCount = 0; let theirMessageCount = 0;
      let msgs = []; snapshot.forEach(doc => msgs.push(doc.data())); msgs.sort((a, b) => a.time - b.time); 
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
        
        let replyBlock = "";
        if (m.replyTo) {
            const replyName = m.replyTo.sender === user ? "You" : m.replyTo.sender;
            // 🔥 THE FIX: We use a safe data tag instead of inline onclick!
            const timeData = m.replyTo.time ? `data-target-time="${m.replyTo.time}"` : "";
            replyBlock = `<div class="msg-replied-to" ${timeData}><b>${replyName}:</b> ${m.replyTo.text}</div>`;
        }

        const swipeIconHTML = isMe 
            ? `<div class="swipe-reply-icon right"><i class='bx bx-reply' style="transform: scaleX(-1);"></i></div>` 
            : `<div class="swipe-reply-icon left"><i class='bx bx-reply'></i></div>`;
            
        // 🔥 THE UPGRADE: Added handleMessageTap, removed the button!
        newHTML += `<div id="msg-${m.time}" class="msg-wrapper" data-sender="${m.sender}" data-time="${m.time}" data-text="${encodedText}" style="align-items: ${isMe ? 'flex-end' : 'flex-start'};" onclick="handleMessageTap(event, this, '${m.sender}', '${encodedText}', ${m.time})">
                      ${swipeIconHTML}
                      <div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'} ${shape}">
                         ${replyBlock}
                         ${m.text}
                      </div>
                      <div class="msg-time" style="text-align: ${isMe ? 'right' : 'left'}">
                         ${formatTime(m.time)}
                      </div>
                    </div>`;
        
        if (i === msgs.length - 1 && isMe) {
            let statusHtml = (currentChatData && currentChatData.unreadBy === "") ? `Read <i class='bx bx-check-double' style="color: var(--primary);"></i>` : `Sent <i class='bx bx-check'></i>`;
            newHTML += `<div class="msg-status" id="readReceipt">${statusHtml}</div>`; 
        }
      });
      
      newHTML += `<div id="typingBubble" class="typing-indicator hidden"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
      box.innerHTML = newHTML;
      
      if (currentChatStatus === "icebreaker" && theirMessageCount > 0 && currentChatInitiator === user) { db.collection("chats").doc(currentChat).update({ status: "unlocked" }); }
      box.scrollTop = box.scrollHeight; 
      updateChatFooterUI(); updateReadReceipts(); updateTypingIndicator();
    });
}

function updateChatFooterUI() {
  const footer = document.querySelector(".chat-footer"); if(!footer) return;

  if (currentChatStatus === "icebreaker" && currentChatInitiator === user && myMessageCount >= 1) {
      footer.innerHTML = `<div style="width: 100%; text-align: center; color: var(--text-muted); font-size: 13px; font-weight: bold; padding: 10px;"><i class='bx bxs-lock-alt'></i> Icebreaker sent! Waiting for reply...</div>`;
      footer.style.flexDirection = "row";
      return;
  }

  footer.style.flexDirection = "column"; 
  footer.style.alignItems = "stretch";

  // 🔥 THE FIX: We specifically look for the container, not the input
  if (!document.getElementById("replyPreviewContainer")) {
      const existingInput = document.getElementById("msgInput");
      const currentVal = existingInput ? existingInput.value : "";
      
      // Builds the missing container AND keeps whatever you were typing
      footer.innerHTML = `
        <div id="replyPreviewContainer"></div>
        <div style="display: flex; gap: 10px; width: 100%; margin-top: 12px; z-index: 1;">
            <input id="msgInput" value="${currentVal}" placeholder="Message..." autocomplete="off" oninput="handleTyping()" onkeydown="if(event.key === 'Enter') sendMessage()" style="margin-bottom:0;" />
            <button onclick="sendMessage()"><i class='bx bxs-send'></i></button>
        </div>`;
  }

  // Now we know 100% that the container exists, so we inject the blue bar!
  const previewContainer = document.getElementById("replyPreviewContainer");
  if (previewContainer) {
      if (replyingToMessage) {
          const name = replyingToMessage.sender === user ? "Yourself" : replyingToMessage.sender;
          previewContainer.innerHTML = `
            <div class="reply-preview-bar">
               <div class="reply-preview-content">
                 <i class='bx bx-reply reply-preview-icon'></i>
                 <div style="color: var(--primary);"><b>Replying to ${name}:</b><br><span style="color: #6366f1; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;">${replyingToMessage.text}</span></div>
               </div>
               <div onclick="cancelReply()" style="background: white; width: 26px; height: 26px; min-width: 26px; border-radius: 50%; display: flex; justify-content: center; align-items: center; cursor: pointer; color: var(--danger); box-shadow: var(--shadow-sm);"><i class='bx bx-x'></i></div>
            </div>`;
      } else {
          previewContainer.innerHTML = "";
      }
  }
}

function loadChatList() {
  db.collection("chats").where("users", "array-contains", user).onSnapshot(snapshot => {
      const list = document.getElementById("chatList"); if(!list) return;
      list.innerHTML = ""; let hasGlobalUnread = false; let chatsArray = [];
      
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
      
      if (chatsArray.length === 0) list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;
      
      chatsArray.forEach(chat => {
        let other = "Unknown";
        if (chat.users && Array.isArray(chat.users)) {
            other = chat.users.find(u => u !== user) || "Unknown";
        } else {
            other = chat.id.replace(user, "").replace("_", "");
            db.collection("chats").doc(chat.id).set({ users: [user, other] }, { merge: true });
        }

        if (chat.unreadBy === user && currentChat === chat.id) { db.collection("chats").doc(chat.id).set({ unreadBy: "" }, { merge: true }); chat.unreadBy = ""; }
        
        const initial = other.charAt(0).toUpperCase(); 
        const isUnread = chat.unreadBy === user; 
        if (isUnread) hasGlobalUnread = true;
        
        // 🔥 THE FIX: Using the unbreakable, pulsing CSS class!
        const unreadStyles = isUnread ? 'background: #e0e7ff; border-left: 4px solid var(--primary);' : '';
        const nameStyles = isUnread ? 'font-weight: 800;' : '';
        const dotHTML = isUnread ? `<div class="unread-pulse-dot"></div>` : '';
        
        list.innerHTML += `
          <div class="chat-item" onclick="openChat('${chat.id}', '${other}')" style="${unreadStyles}">
            <div class="chat-avatar">${initial}</div>
            <div class="chat-name" style="${nameStyles}">${other}</div>
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

function openProfileScreen() {
  try {
    const dName = document.getElementById("profileDisplayName"); const uName = document.getElementById("profileUsername"); const pAvatar = document.getElementById("profileLargeAvatar");
    if(dName) dName.innerText = typeof realName !== 'undefined' ? realName : "Student";
    if(uName) uName.innerText = "@" + (typeof user !== 'undefined' ? user : "username");
    if(pAvatar) pAvatar.innerHTML = renderAvatar(typeof userAvatar !== 'undefined' ? userAvatar : "👤");
    document.querySelector(".topbar")?.classList.add("hidden"); switchScreen("profileScreen"); loadMyEvents();
  } catch (error) { alert("Profile Screen Error: " + error.message); }
}

function closeProfileScreen() { document.querySelector(".topbar")?.classList.remove("hidden"); switchScreen("home"); }

function loadMyEvents() {
  const myEventsBox = document.getElementById("myProfileEvents"); if(!myEventsBox) return;
  myEventsBox.innerHTML = "<p style='text-align:center; color:gray;'>Loading...</p>";
  
  // 🔥 FIX 3: Removed orderBy() here as well to prevent the Profile screen from crashing
  db.collection("events").where("user", "==", user).get().then(snapshot => {
    myEventsBox.innerHTML = "";
    if (snapshot.empty) { myEventsBox.innerHTML = `<div class="empty-state"><i class='bx bx-ghost'></i><p>You haven't hosted any events yet.</p></div>`; return; }
    
    let evts = [];
    snapshot.forEach(doc => evts.push(doc.data()));
    evts.sort((a, b) => b.startTime - a.startTime); // Sorted locally

    evts.forEach(e => { 
        myEventsBox.innerHTML += `<div class="event card" style="padding: 16px;"><div class="event-title" style="font-size: 16px;">${e.title}</div><div class="event-meta" style="font-size: 13px;">${e.tag || ''} • ${e.place}</div></div>`; 
    });
  });
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
