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

// NEW: INDEPENDENT FILTERS
let currentLiveFilter = 'All';
let currentRecapFilter = 'All';

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
      auth.signOut();
      return;
    }
    
    // Create base profile if they are brand new
    if (!doc.exists) {
      await userRef.set({ 
        name: userAuth.displayName || userEmail.split('@')[0], 
        avatar: userAuth.photoURL || "👤", 
        banned: false, 
        joinedAt: Date.now() 
      });
      doc = await userRef.get(); // Re-fetch the fresh document
    }

    // NEW FIX: Hide the login screen BEFORE showing the username modal
    if (!doc.data().username) {
      document.getElementById("login").classList.add("hidden"); 
      document.getElementById("usernameModal").classList.remove("hidden");
      return; 
    }

    // If they have a username, let them in!
    user = doc.data().username; 
    userAvatar = doc.data().avatar || "👤";
    
    document.getElementById("topAvatar").innerHTML = `<img src="${userAvatar}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`; 
    
    document.getElementById("login").classList.add("hidden"); 
    document.getElementById("home").classList.remove("hidden");
    loadChatList(); 
    loadEvents();

  } catch (error) {
    console.error(error);
    alert("Database Error: " + error.message + " (Check your Firestore Rules!)");
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

function selectAvatar(element, emoji) {
  // Update Database
  db.collection("users").doc(userEmail).set({ avatar: emoji }, { merge: true });
  userAvatar = emoji;
  document.getElementById("topAvatar").innerText = emoji; // Update Navbar

  // Highlight selection in modal
  document.querySelectorAll('.avatar-option').forEach(opt => opt.classList.remove('selected'));
  element.classList.add('selected');
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
    const liveList = document.getElementById("events"); const recapList = document.getElementById("recapEvents");
    liveList.innerHTML = ""; recapList.innerHTML = "";
    
    let activeCount = 0; let recapCount = 0;
    const currentTime = Date.now(); const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);

    snapshot.forEach(doc => {
      const e = doc.data(); const id = doc.id;
      const attendeesCount = e.participants ? e.participants.length : 1;
      const attendeeNames = e.participants ? e.participants.join(", ") : e.user;

      const displayTag = e.tag ? `<div class="event-tag-badge">${e.tag}</div>` : '';
      const displayDesc = e.description ? `<button class="read-more-btn" onclick="toggleEventDesc('${id}')">Read details...</button><div class="event-desc-box">${e.description}</div>` : '';
      let statusBadge = (currentTime < e.startTime) 
        ? `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>`
        : `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;

      // Check which filters are active
      const matchesLive = (currentLiveFilter === 'All' || e.tag === currentLiveFilter);
      const matchesRecap = (currentRecapFilter === 'All' || e.tag === currentRecapFilter);

      if (e.expiresAt > currentTime) {
        if (matchesLive) {
          activeCount++;
          const hasJoined = e.participants && e.participants.includes(user);
          liveList.innerHTML += `
            <div class="event card" id="event-${id}">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">${displayTag} ${statusBadge}</div>
              <div class="event-title">${e.title}</div>
              <div class="event-meta"><span style="font-size:18px;">${e.hostAvatar || '👤'}</span> ${e.place} • hosted by ${e.user}</div>
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
              <div class="event-meta"><span style="font-size:18px;">${e.hostAvatar || '👤'}</span> ${e.place} • hosted by ${e.user}</div>
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

async function startChat() {
  const other = document.getElementById("chatUser").value.trim();
  if (!other) return alert("Please enter a username.");
  if (other === user) return alert("You can't start a chat with yourself!");

  try {
    const otherEmail = other.toLowerCase() + "@livesociya.com";
    const userRef = db.collection("users").doc(otherEmail);
    const docSnap = await userRef.get();
    if (!docSnap.exists) return alert(`User "${other}" does not exist.`);

    const chatId = [user, other].sort().join("_");
    await db.collection("chats").doc(chatId).set({ users: [user, other], unreadBy: "", lastUpdated: Date.now() }, { merge: true });
    
    document.getElementById("chatUser").value = ""; openChat(chatId, other);
  } catch (error) { alert("Error finding user."); }
}

function openChat(chatId, otherUser) {
  currentChat = chatId; document.getElementById("chatHeaderAvatar").innerText = otherUser.charAt(0); document.getElementById("chatWithTitle").innerText = otherUser;
  document.getElementById("home").classList.add("hidden"); document.querySelector(".topbar").classList.add("hidden"); document.getElementById("chatScreen").classList.remove("hidden");
  db.collection("chats").doc(chatId).set({ unreadBy: "" }, { merge: true }); loadMessages();
}

function closeChat() {
  currentChat = null; if (messagesUnsubscribe) messagesUnsubscribe();
  document.getElementById("chatScreen").classList.add("hidden"); document.querySelector(".topbar").classList.remove("hidden"); document.getElementById("home").classList.remove("hidden");
}

function sendMessage() {
  const text = document.getElementById("msgInput").value.trim(); if (!text || !currentChat) return;
  const otherUser = currentChat.split("_").find(u => u !== user);
  db.collection("messages").add({ chatId: currentChat, sender: user, text: text, time: Date.now() });
  db.collection("chats").doc(currentChat).set({ unreadBy: otherUser, lastUpdated: Date.now() }, { merge: true });
  document.getElementById("msgInput").value = "";
}

function loadMessages() {
  if (messagesUnsubscribe) messagesUnsubscribe();
  const box = document.getElementById("messages");
  messagesUnsubscribe = db.collection("messages").where("chatId", "==", currentChat).orderBy("time", "asc").onSnapshot(snapshot => {
      box.innerHTML = ""; let lastDateString = ""; 
      snapshot.forEach(doc => {
        const m = doc.data(); const isMe = m.sender === user;
        const msgDate = new Date(m.time).toLocaleDateString();
        if (msgDate !== lastDateString) {
          let displayDate = ""; const today = new Date().toLocaleDateString();
          const yesterdayObj = new Date(); yesterdayObj.setDate(yesterdayObj.getDate() - 1); const yesterday = yesterdayObj.toLocaleDateString();
          if (msgDate === today) displayDate = "Today"; else if (msgDate === yesterday) displayDate = "Yesterday"; else displayDate = new Date(m.time).toLocaleDateString([], { month: 'short', day: 'numeric' });
          box.innerHTML += `<div class="date-separator">${displayDate}</div>`; lastDateString = msgDate; 
        }
        box.innerHTML += `<div class="msg-wrapper" style="align-items: ${isMe ? 'flex-end' : 'flex-start'};" onclick="toggleTime(this)"><div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'}">${m.text}</div><div class="msg-time" style="text-align: ${isMe ? 'right' : 'left'}">${formatTime(m.time)}</div></div>`;
      });
      box.scrollTop = box.scrollHeight; 
    });
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
