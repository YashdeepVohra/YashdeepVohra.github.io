// ==========================================
// PASTE YOUR FIREBASE CONFIG KEYS HERE!
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBvcJJ2wz2yteRUYdasRUe8oaTt_Vp9kGQ",
  authDomain: "livesociyaweb.firebaseapp.com",
  projectId: "livesociyaweb",
  storageBucket: "livesociyaweb.firebasestorage.app",
  messagingSenderId: "676740518716",
  appId: "1:676740518716:web:c552e59b56a93f5a35c439"
};

try { firebase.initializeApp(firebaseConfig); } catch (e) { console.error("Firebase not initialized!"); }

const auth = firebase.auth();
const db = firebase.firestore();

// NEW: REGISTER PWA SERVICE WORKER
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

let currentChat = null;
let user = "";
let userEmail = "";
let userAvatar = "👤"; // Default Avatar
let messagesUnsubscribe = null; 
let eventIdToManage = null;
let currentSelectedTag = '☕ Chill'; 
let googlePfp = ""; 
let realName = "";

// NEW: INDEPENDENT FILTERS
let currentLiveFilter = 'All';
let currentRecapFilter = 'All';

// Add this near the top of app.js if you don't have it already!
// This is the "Translator" that converts text links into actual images
function renderAvatar(avatarCode) {
  // 1. Check if the code actually exists
  if (!avatarCode) return "👤";

  // 2. If it is a Google Photo (starts with http), turn it into an <img> tag
  if (typeof avatarCode === 'string' && avatarCode.startsWith("http")) {
    return `<img src="${avatarCode}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
  }

  // 3. Otherwise, it's an emoji! Just return the emoji.
  return avatarCode;
}

function formatTime(ms) {
  const messageDate = new Date(ms); const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
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

// --- NEW: SECURE GOOGLE LOGIN ---
// --- UPDATED: SECURE GOOGLE LOGIN ---
function loginWithGoogle() {
  if (Object.keys(firebaseConfig).length === 0) return alert("Firebase Config is missing!");
  
  const provider = new firebase.auth.GoogleAuthProvider();
  
  // We removed the messy database logic from here so it doesn't race!
  auth.signInWithPopup(provider).catch((error) => {
    if (error.code !== 'auth/popup-closed-by-user') alert(error.message);
  });
}

// --- UPDATED: AUTH WATCHER & USERNAME GATEKEEPER ---
auth.onAuthStateChanged(async (userAuth) => {
  if (!userAuth) {
    document.getElementById("home").classList.add("hidden"); 
    document.getElementById("login").classList.remove("hidden");
    return;
  }
  
  try {
    userEmail = userAuth.email;
    const userRef = db.collection("users").doc(userEmail);
    let doc = await userRef.get();
    
    if (doc.exists && doc.data().banned === true) {
      alert("SECURITY ALERT: Your account has been suspended.");
      auth.signOut(); return;
    }
    
    if (!doc.exists) {
      await userRef.set({ 
        name: userAuth.displayName || userEmail.split('@')[0], 
        googlePfp: userAuth.photoURL || "", // Safely store their real photo forever
        avatar: userAuth.photoURL || "👤", 
        banned: false, joinedAt: Date.now() 
      });
      doc = await userRef.get();
    }

    if (!doc.data().username) {
      document.getElementById("login").classList.add("hidden"); 
      document.getElementById("usernameModal").classList.remove("hidden");
      return; 
    }

    // Set all global data
    user = doc.data().username; 
    realName = doc.data().name;
    userAvatar = doc.data().avatar || "👤";
    googlePfp = doc.data().googlePfp || userAuth.photoURL;
    
    // Safely render the avatar using our new helper!
    document.getElementById("topAvatar").innerHTML = renderAvatar(userAvatar); 
    
    document.getElementById("login").classList.add("hidden"); 
    document.getElementById("home").classList.remove("hidden");
    loadChatList(); loadEvents();

  } catch (error) {
    console.error(error); alert("Database Error: " + error.message);
  }
});

// --- NEW: LIVE USERNAME CHECKER ---
// --- UPDATED: SMARTER USERNAME CHECKER ---
async function checkUsernameAvailability() {
  const input = document.getElementById("newUsername");
  const status = document.getElementById("usernameStatus");
  const btn = document.getElementById("claimBtn");
  
  // Force lowercase and remove spaces/special characters
  let val = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  input.value = val; 

  // FIX: If the box is totally empty, just reset the text and stop checking
  if (val.length === 0) {
    status.innerText = ""; 
    btn.style.background = "#cbd5e1"; btn.disabled = true; btn.style.cursor = "not-allowed";
    return;
  }

  // Check for the 3 character minimum
  if (val.length < 3) {
    status.innerText = "Must be at least 3 characters"; 
    status.style.color = "var(--text-muted)"; // Changed to gray so it's less aggressive than red!
    btn.style.background = "#cbd5e1"; btn.disabled = true; btn.style.cursor = "not-allowed";
    return;
  }

  // Check the Database to see if anyone owns this handle
  const usernameDoc = await db.collection("usernames").doc(val).get();
  
  if (usernameDoc.exists) {
    status.innerText = "Taken 😔"; status.style.color = "var(--danger)";
    btn.style.background = "#cbd5e1"; btn.disabled = true; btn.style.cursor = "not-allowed";
  } else {
    status.innerText = "Available! 🎉"; status.style.color = "var(--success)";
    btn.style.background = "var(--primary)"; btn.disabled = false; btn.style.cursor = "pointer";
  }
}

// --- NEW: CLAIM AND SAVE USERNAME ---
async function claimUsername() {
  const chosenName = document.getElementById("newUsername").value;
  if (!chosenName) return;

  try {
    // 1. Lock the username in the registry so nobody else can take it
    await db.collection("usernames").doc(chosenName).set({ email: userEmail });
    
    // 2. Add the username to their main profile
    await db.collection("users").doc(userEmail).set({ username: chosenName }, { merge: true });

    // 3. Close the modal and let them into the app!
    document.getElementById("usernameModal").classList.add("hidden");
    
    // Trigger the auth watcher again to load the app
    auth.currentUser.reload();
    const userAuth = auth.currentUser;
    auth.updateCurrentUser(userAuth); 
    
  } catch (error) {
    alert("Error claiming username. Try another one.");
  }
}

function logout() { auth.signOut(); }

// --- NEW: AVATAR SYSTEM LOGIC ---
function openProfileModal() { document.getElementById("profileModal").classList.remove("hidden"); }
function closeProfileModal() { document.getElementById("profileModal").classList.add("hidden"); }

function selectAvatar(element, type) {
  // If they click google, use their saved googlePfp. Otherwise, use the emoji.
  let newAvatar = (type === 'google') ? googlePfp : type;
  
  db.collection("users").doc(userEmail).set({ avatar: newAvatar }, { merge: true });
  userAvatar = newAvatar;
  
  // Update both the top bar and the profile screen instantly
  document.getElementById("topAvatar").innerHTML = renderAvatar(userAvatar);
  document.getElementById("profileLargeAvatar").innerHTML = renderAvatar(userAvatar);
  
  closeProfileModal();
}
// --------------------------------

function selectTag(element, tag) {
  document.querySelectorAll('#tagSelector .tag').forEach(t => t.classList.remove('active'));
  element.classList.add('active'); currentSelectedTag = element.innerText;
}

// --- NEW: SEPARATE FILTER LOGIC ---
function setLiveFilter(element, tag) {
  currentLiveFilter = tag;
  document.querySelectorAll('#liveFilters .filter-pill').forEach(pill => pill.classList.remove('active'));
  element.classList.add('active');
  loadEvents(); // Reload Feed
}

function setRecapFilter(element, tag) {
  currentRecapFilter = tag;
  document.querySelectorAll('#recapFilters .filter-pill').forEach(pill => pill.classList.remove('active'));
  element.classList.add('active');
  loadEvents(); // Reload Recap
}
// ----------------------------------

function toggleEventDesc(eventId) {
  const eventCard = document.getElementById(`event-${eventId}`); eventCard.classList.toggle('expanded');
  eventCard.querySelector('.read-more-btn').innerText = eventCard.classList.contains('expanded') ? "Hide details" : "Read details...";
}

function openCreateModal() {
  document.getElementById("createModal").classList.remove("hidden");
  const now = new Date(); const inTwoHours = new Date(now.getTime() + (2 * 60 * 60 * 1000));
  const formatForInput = (date) => (new Date(date - (date.getTimezoneOffset() * 60000))).toISOString().slice(0, 16);
  document.getElementById("startTime").value = formatForInput(now); document.getElementById("endTime").value = formatForInput(inTwoHours);
}

function closeCreateModal() { document.getElementById("createModal").classList.add("hidden"); }

function addEvent() {
  const title = document.getElementById("title").value.trim(); const place = document.getElementById("place").value.trim();
  const description = document.getElementById("description").value.trim();
  const startTimeStr = document.getElementById("startTime").value; const endTimeStr = document.getElementById("endTime").value;

  if (!title || !place || !startTimeStr || !endTimeStr) return alert("Please fill out all event details.");
  const startTimestamp = new Date(startTimeStr).getTime(); const endTimestamp = new Date(endTimeStr).getTime();
  if (endTimestamp <= startTimestamp) return alert("Your event end time must be AFTER the start time.");
  if (endTimestamp < Date.now()) return alert("You cannot schedule an event to end in the past.");

  db.collection("events").add({
    title, place, description, tag: currentSelectedTag, user, 
    hostAvatar: userAvatar, // NEW: Stamps the avatar onto the event!
    startTime: startTimestamp, expiresAt: endTimestamp, participants: [user] 
  });
  
  document.getElementById("title").value = ""; document.getElementById("place").value = ""; document.getElementById("description").value = "";
  closeCreateModal();
}

function loadEvents() {
  db.collection("events").orderBy("startTime", "desc").onSnapshot(snapshot => {
    const liveList = document.getElementById("events"); 
    const recapList = document.getElementById("recapEvents");
    liveList.innerHTML = ""; recapList.innerHTML = "";
    
    let activeCount = 0; let recapCount = 0;
    const currentTime = Date.now(); 
    const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);

    snapshot.forEach(doc => {
      const e = doc.data(); 
      const id = doc.id;
      const attendeesCount = e.participants ? e.participants.length : 1;
      // This makes every username a clickable link that opens the chat!
      const attendeeNames = e.participants 
        ? e.participants.map(p => `<span onclick="event.stopPropagation(); startChat('${p}')" style="color: var(--primary); cursor: pointer;">@${p}</span>`).join(", ") 
        : `<span onclick="event.stopPropagation(); startChat('${e.user}')" style="color: var(--primary); cursor: pointer;">@${e.user}</span>`;

      const displayTag = e.tag ? `<div class="event-tag-badge">${e.tag}</div>` : '';
      const displayDesc = e.description ? `<button class="read-more-btn" onclick="toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${e.description}</div>` : '';
      let statusBadge = (currentTime < e.startTime) 
        ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>`
        : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;

      // 🐛 BUG FIX: The safe Avatar Renderer wrapper
      const avatarHTML = `<div style="display:inline-block; width:24px; height:24px; border-radius:50%; vertical-align:middle; overflow:hidden; border:1px solid var(--border); margin-right:4px;">${renderAvatar(e.hostAvatar)}</div>`;

      const matchesLive = (typeof currentLiveFilter !== 'undefined' ? (currentLiveFilter === 'All' || e.tag === currentLiveFilter) : true);
      const matchesRecap = (typeof currentRecapFilter !== 'undefined' ? (currentRecapFilter === 'All' || e.tag === currentRecapFilter) : true);

      if (e.expiresAt > currentTime) {
        if (matchesLive) {
          activeCount++;
          const hasJoined = e.participants && e.participants.includes(user);
          liveList.innerHTML += `
            <div class="event card" id="event-${id}">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">${displayTag} ${statusBadge}</div>
              <div class="event-title">${e.title}</div>
              
              <div class="event-meta" style="display:flex; align-items:center;">
                ${avatarHTML} <span>${e.place} • hosted by @${e.user}</span>
              </div>
              
              ${displayDesc}
              <div class="attendees"><i class='bx bx-group'></i> Going (${attendeesCount}): ${attendeeNames}</div>
              ${e.user === user ? `<button class="delete-btn" onclick="openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage Event</button>` : (hasJoined ? `<button class="leave-btn" onclick="leaveEvent('${id}')"><i class='bx bx-exit'></i> Leave Hangout</button>` : `<button class="join" onclick="joinEvent('${id}')">Join Hangout</button>`)}
            </div>`;
        }
      } else if (e.expiresAt > oneDayAgo) {
        if (matchesRecap) {
          recapCount++;
          recapList.innerHTML += `
            <div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">
              ${displayTag}
              <div class="event-title" style="color: #4b5563;">${e.title}</div>
              
              <div class="event-meta" style="display:flex; align-items:center;">
                ${avatarHTML} <span>${e.place} • hosted by @${e.user}</span>
              </div>
              
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
function openDeleteModal(id) { eventIdToManage = id; document.getElementById("deleteModal").classList.remove("hidden"); }
function closeDeleteModal() { eventIdToManage = null; document.getElementById("deleteModal").classList.add("hidden"); }
function confirmMoveToRecap() { if (!eventIdToManage) return; db.collection("events").doc(eventIdToManage).update({ expiresAt: Date.now() - 1 }).then(() => closeDeleteModal()); }
function confirmDeletePermanently() { if (!eventIdToManage) return; db.collection("events").doc(eventIdToManage).delete().then(() => closeDeleteModal()); }

// ==========================================
// 💬 HYBRID CHAT ENGINE (Crossed Paths & Icebreakers)
// ==========================================

let chatDocUnsubscribe = null;
let currentChatStatus = "unlocked";
let currentChatInitiator = "";
let myMessageCount = 0;

// NEW: Checks if two users shared an event in the last 24 hours
async function checkCrossedPaths(user1, user2) {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const snap = await db.collection("events").where("participants", "array-contains", user1).get();
  for (let doc of snap.docs) {
    const e = doc.data();
    if (e.participants.includes(user2) && e.expiresAt > oneDayAgo) {
      return true; // They crossed paths!
    }
  }
  return false;
}

// UPDATED: Now handles both the Search Bar AND clicking a name
async function startChat(clickedUsername = null) {
  // If they clicked a name, use it. Otherwise, use the search bar.
  const other = clickedUsername || document.getElementById("chatUser").value.trim();
  
  if (!other) return alert("Please enter a username.");
  if (other === user) return alert("You can't start a chat with yourself!");

  try {
    const otherEmail = other.toLowerCase() + "@livesociya.com";
    const userRef = db.collection("users").doc(otherEmail);
    const docSnap = await userRef.get();
    if (!docSnap.exists) return alert(`User "@${other}" does not exist on campus.`);

    const chatId = [user, other].sort().join("_");
    const chatDoc = await db.collection("chats").doc(chatId).get();
    
    // If this is a brand new chat, figure out if it should be Locked or Unlocked
    if (!chatDoc.exists) {
      const crossedPaths = await checkCrossedPaths(user, other);
      await db.collection("chats").doc(chatId).set({ 
        users: [user, other], 
        unreadBy: "", 
        lastUpdated: Date.now(),
        status: crossedPaths ? "unlocked" : "icebreaker", // The Magic Gatekeeper
        initiatedBy: user
      });
    }
    
    if(!clickedUsername) document.getElementById("chatUser").value = ""; 
    openChat(chatId, other);
  } catch (error) { alert("Error finding user."); }
}

function openChat(chatId, otherUser) {
  currentChat = chatId; 
  document.getElementById("chatHeaderAvatar").innerText = otherUser.charAt(0); 
  document.getElementById("chatWithTitle").innerText = otherUser;
  
  document.getElementById("home").classList.add("hidden"); 
  document.querySelector(".topbar").classList.add("hidden"); 
  document.getElementById("chatScreen").classList.remove("hidden");
  
  db.collection("chats").doc(chatId).set({ unreadBy: "" }, { merge: true }); 
  
  // Listen to the Chat's Status (Locked or Unlocked)
  if(chatDocUnsubscribe) chatDocUnsubscribe();
  chatDocUnsubscribe = db.collection("chats").doc(chatId).onSnapshot(doc => {
     if(doc.exists) {
         currentChatStatus = doc.data().status || "unlocked";
         currentChatInitiator = doc.data().initiatedBy || "";
         updateChatFooterUI();
     }
  });

  loadMessages();
}

function closeChat() {
  currentChat = null; 
  if (messagesUnsubscribe) messagesUnsubscribe();
  if (chatDocUnsubscribe) chatDocUnsubscribe();
  document.getElementById("chatScreen").classList.add("hidden"); 
  document.querySelector(".topbar").classList.remove("hidden"); 
  document.getElementById("home").classList.remove("hidden");
}

async function sendMessage() {
  const input = document.getElementById("msgInput");
  if(!input) return; // If locked, input doesn't exist!
  
  const text = input.value.trim(); 
  if (!text || !currentChat) return;
  
  const otherUser = currentChat.split("_").find(u => u !== user);
  
  // 1. Send the message
  await db.collection("messages").add({ chatId: currentChat, sender: user, text: text, time: Date.now() });
  
  // 2. If I am replying to an Icebreaker they sent, SHATTER THE LOCK!
  let newStatus = currentChatStatus;
  if (currentChatStatus === "icebreaker" && currentChatInitiator === otherUser) {
      newStatus = "unlocked";
  }

  await db.collection("chats").doc(currentChat).set({ 
      unreadBy: otherUser, 
      lastUpdated: Date.now(),
      status: newStatus 
  }, { merge: true });
  
  input.value = "";
}

function loadMessages() {
  if (messagesUnsubscribe) messagesUnsubscribe();
  const box = document.getElementById("messages");
  
  messagesUnsubscribe = db.collection("messages").where("chatId", "==", currentChat).orderBy("time", "asc").onSnapshot(snapshot => {
      box.innerHTML = ""; let lastDateString = ""; 
      myMessageCount = 0;
      let theirMessageCount = 0;

      snapshot.forEach(doc => {
        const m = doc.data(); const isMe = m.sender === user;
        if(isMe) myMessageCount++; else theirMessageCount++;
        
        const msgDate = new Date(m.time).toLocaleDateString();
        if (msgDate !== lastDateString) {
          let displayDate = ""; const today = new Date().toLocaleDateString();
          const yesterdayObj = new Date(); yesterdayObj.setDate(yesterdayObj.getDate() - 1); const yesterday = yesterdayObj.toLocaleDateString();
          if (msgDate === today) displayDate = "Today"; else if (msgDate === yesterday) displayDate = "Yesterday"; else displayDate = new Date(m.time).toLocaleDateString([], { month: 'short', day: 'numeric' });
          box.innerHTML += `<div class="date-separator">${displayDate}</div>`; lastDateString = msgDate; 
        }
        box.innerHTML += `<div class="msg-wrapper" style="align-items: ${isMe ? 'flex-end' : 'flex-start'};" onclick="toggleTime(this)"><div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'}">${m.text}</div><div class="msg-time" style="text-align: ${isMe ? 'right' : 'left'}">${formatTime(m.time)}</div></div>`;
      });
      
      // Auto-Unlock if they replied to my Icebreaker
      if (currentChatStatus === "icebreaker" && theirMessageCount > 0 && currentChatInitiator === user) {
          db.collection("chats").doc(currentChat).update({ status: "unlocked" });
      }

      box.scrollTop = box.scrollHeight; 
      updateChatFooterUI();
    });
}

// NEW: Dynamically changes the bottom bar to a lock or an input field
function updateChatFooterUI() {
  const footer = document.querySelector(".chat-footer");
  if (currentChatStatus === "icebreaker" && currentChatInitiator === user && myMessageCount >= 1) {
      // 🔒 LOCK IT DOWN!
      footer.innerHTML = `<div style="width: 100%; text-align: center; color: var(--text-muted); font-size: 13px; font-weight: bold; padding: 10px;"><i class='bx bxs-lock-alt'></i> Icebreaker sent! Waiting for reply...</div>`;
  } else {
      // 🔓 KEEP IT OPEN!
      footer.innerHTML = `<input id="msgInput" placeholder="Message..." onkeydown="if(event.key === 'Enter') sendMessage()" />
                          <button onclick="sendMessage()"><i class='bx bxs-send'></i></button>`;
  }
}

function loadChatList() {
  db.collection("chats").where("users", "array-contains", user).onSnapshot(snapshot => {
      const list = document.getElementById("chatList"); list.innerHTML = ""; let hasGlobalUnread = false; let chatsArray = [];
      snapshot.forEach(doc => { chatsArray.push({ id: doc.id, ...doc.data() }); });
      chatsArray.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

      if (chatsArray.length === 0) list.innerHTML = `<div class="empty-state" style="padding-top: 20px;"><i class='bx bx-message-square-x'></i><p>No messages yet.</p></div>`;

      chatsArray.forEach(chat => {
        if (chat.unreadBy === user && currentChat === chat.id) { db.collection("chats").doc(chat.id).set({ unreadBy: "" }, { merge: true }); chat.unreadBy = ""; }
        const other = chat.users.find(u => u !== user); const initial = other.charAt(0); const isUnread = chat.unreadBy === user;
        if (isUnread) hasGlobalUnread = true;
        list.innerHTML += `<div class="chat-item" onclick="openChat('${chat.id}', '${other}')" style="${isUnread ? 'background: #e0e7ff; border-color: var(--primary);' : ''}"><div class="chat-avatar">${initial}</div><div class="chat-name" style="${isUnread ? 'font-weight: 800;' : ''}">${other}</div>${isUnread ? `<div class="chat-unread-dot"></div>` : ''}</div>`;
      });
      const badge = document.getElementById("chatBadge"); if (hasGlobalUnread) badge.classList.remove("hidden"); else badge.classList.add("hidden");
    });
}

function showTab(tab) {
  document.getElementById("eventsTab").classList.add("hidden"); document.getElementById("recapTab").classList.add("hidden"); document.getElementById("chatsTab").classList.add("hidden");
  document.querySelectorAll(".nav-item").forEach(t => t.classList.remove("active"));
  if (tab === 'events') { document.getElementById("eventsTab").classList.remove("hidden"); document.querySelectorAll(".nav-item")[0].classList.add("active"); } 
  else if (tab === 'recap') { document.getElementById("recapTab").classList.remove("hidden"); document.querySelectorAll(".nav-item")[1].classList.add("active"); } 
  else { document.getElementById("chatsTab").classList.remove("hidden"); document.querySelectorAll(".nav-item")[2].classList.add("active"); }
}

// Smart function to render either an image tag or an emoji string
function renderAvatar(avatarCode) {
  if (avatarCode && avatarCode.startsWith("http")) {
    return `<img src="${avatarCode}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
  }
  return avatarCode || "👤";
}

// --- NEW: PROFILE SCREEN LOGIC ---
function openProfileScreen() {
  try {
    // 1. Fill in the text (with fallbacks just in case the variables are empty!)
    document.getElementById("profileDisplayName").innerText = typeof realName !== 'undefined' ? realName : "Student";
    document.getElementById("profileUsername").innerText = "@" + (typeof user !== 'undefined' ? user : "username");
    
    // 2. Set the avatar
    document.getElementById("profileLargeAvatar").innerHTML = renderAvatar(typeof userAvatar !== 'undefined' ? userAvatar : "👤");
    
    // 3. Hide main app, show profile
    document.getElementById("home").classList.add("hidden");
    const topbar = document.querySelector(".topbar");
    if(topbar) topbar.classList.add("hidden");
    document.getElementById("profileScreen").classList.remove("hidden");

    // 4. Load their personal events
    loadMyEvents();

  } catch (error) {
    // If anything fails, it will pop up an alert telling you exactly what broke!
    alert("Profile Screen Error: " + error.message);
  }
}

function closeProfileScreen() {
  document.getElementById("profileScreen").classList.add("hidden");
  document.querySelector(".topbar").classList.remove("hidden");
  document.getElementById("home").classList.remove("hidden");
}

function loadMyEvents() {
  const myEventsBox = document.getElementById("myProfileEvents");
  myEventsBox.innerHTML = "<p style='text-align:center; color:gray;'>Loading...</p>";
  
  db.collection("events").where("user", "==", user).orderBy("startTime", "desc").get().then(snapshot => {
    myEventsBox.innerHTML = "";
    if (snapshot.empty) {
      myEventsBox.innerHTML = `<div class="empty-state"><i class='bx bx-ghost'></i><p>You haven't hosted any events yet.</p></div>`;
      return;
    }
    snapshot.forEach(doc => {
      const e = doc.data();
      myEventsBox.innerHTML += `
        <div class="event card" style="padding: 16px;">
          <div class="event-title" style="font-size: 16px;">${e.title}</div>
          <div class="event-meta" style="font-size: 13px;">${e.tag || ''} • ${e.place}</div>
        </div>
      `;
    });
  });
}

