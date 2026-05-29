// PASTE YOUR FIREBASE CONFIG MATRIX RIGHT HERE
const firebaseConfig = {
  apiKey: "AIzaSyBvcJJ2wz2yteRUYdasRUe8oaTt_Vp9kGQ",
  authDomain: "livesociyaweb.firebaseapp.com",
  projectId: "livesociyaweb",
  storageBucket: "livesociyaweb.firebasestorage.app",
  messagingSenderId: "676740518716",
  appId: "1:676740518716:web:c552e59b56a93f5a35c439"
};

// Initialize Instance
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentChat = null;
let user = "";
let messagesUnsubscribe = null; 
let eventIdToManage = null;

// Helper: Smart Timestamp Formatter (Today, Yesterday, or Older Date Contexts)
function formatTime(ms) {
  const messageDate = new Date(ms);
  const today = new Date();
  
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const timeString = messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (messageDate.toDateString() === today.toDateString()) {
    return `Today at ${timeString}`;
  } else if (messageDate.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${timeString}`;
  } else {
    const dateString = messageDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dateString} at ${timeString}`;
  }
}

// Helper: Handles the accordion effect for message times
function toggleTime(element) {
  const currentlyShowing = document.querySelector('.msg-wrapper.show-time');
  if (currentlyShowing && currentlyShowing !== element) {
    currentlyShowing.classList.remove('show-time');
  }
  element.classList.toggle('show-time');
}

// SECURITY HUB & IDENTITY TRACKING
function login() {
  const name = document.getElementById("name").value.trim();
  const password = document.getElementById("password").value;
  if (!name || !password) return alert("Please fill out all identity credentials.");

  const email = name.toLowerCase() + "@livesociya.com";

  auth.signInWithEmailAndPassword(email, password)
    .catch((error) => {
      if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
        if (error.code === 'auth/wrong-password') return alert("Incorrect password choice.");
        return auth.createUserWithEmailAndPassword(email, password)
          .then(() => db.collection("users").doc(email).set({ name: name }));
      } else {
        alert(error.message);
      }
    });
}

auth.onAuthStateChanged(async (userAuth) => {
  if (!userAuth) {
    document.getElementById("home").classList.add("hidden");
    document.getElementById("login").classList.remove("hidden");
    return;
  }

  const email = userAuth.email;
  const userRef = db.collection("users").doc(email);
  let doc = await userRef.get();

  if (!doc.exists) {
    user = email.replace("@livesociya.com", "");
    await userRef.set({ name: user });
  } else {
    user = doc.data().name;
  }

  document.getElementById("login").classList.add("hidden");
  document.getElementById("home").classList.remove("hidden");

  loadChatList();
  loadEvents();
});

function logout() { auth.signOut(); }

// --- NEW LOGIC: TAG SELECTION ---
let currentSelectedTag = '☕ Chill'; // Default tag

function selectTag(element, tag) {
  // Remove active class from all tags
  document.querySelectorAll('.tag').forEach(t => t.classList.remove('active'));
  // Add active class to clicked tag
  element.classList.add('active');
  // Update state
  currentSelectedTag = element.innerText;
}

// --- NEW LOGIC: EXPAND EVENT DESCRIPTION ---
function toggleEventDesc(eventId) {
  const eventCard = document.getElementById(`event-${eventId}`);
  eventCard.classList.toggle('expanded');
  
  // Toggle the button text
  const btn = eventCard.querySelector('.read-more-btn');
  if (eventCard.classList.contains('expanded')) {
    btn.innerText = "Hide details";
  } else {
    btn.innerText = "Read details...";
  }
}

// --- NEW LOGIC: CREATE MODAL & TIME HELPERS ---
function openCreateModal() {
  document.getElementById("createModal").classList.remove("hidden");
  
  // Auto-fill the time inputs so the user doesn't have to work as hard!
  const now = new Date();
  const inTwoHours = new Date(now.getTime() + (2 * 60 * 60 * 1000));
  
  // datetime-local input requires a specific format (YYYY-MM-DDTHH:MM)
  const formatForInput = (date) => {
    // Offset for local timezone
    const offset = date.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(date - offset)).toISOString().slice(0, 16);
    return localISOTime;
  };

  document.getElementById("startTime").value = formatForInput(now);
  document.getElementById("endTime").value = formatForInput(inTwoHours);
}

function closeCreateModal() {
  document.getElementById("createModal").classList.add("hidden");
}

// EVENT MANAGEMENT ACTIONS
function addEvent() {
  const title = document.getElementById("title").value.trim();
  const place = document.getElementById("place").value.trim();
  const description = document.getElementById("description").value.trim();
  
  const startTimeStr = document.getElementById("startTime").value;
  const endTimeStr = document.getElementById("endTime").value;

  if (!title || !place) return alert("Please add a title and location.");
  if (!startTimeStr || !endTimeStr) return alert("Please set your start and end times.");

  // Convert HTML time strings back into standard Unix Milliseconds
  const startTimestamp = new Date(startTimeStr).getTime();
  const endTimestamp = new Date(endTimeStr).getTime();
  const currentTime = Date.now();

  // Validate times
  if (endTimestamp <= startTimestamp) return alert("Your event end time must be AFTER the start time.");
  if (endTimestamp < currentTime) return alert("You cannot schedule an event to end in the past.");

  db.collection("events").add({
    title,
    place,
    description,
    tag: currentSelectedTag, 
    user,
    startTime: startTimestamp, // NEW: Saves custom start time
    expiresAt: endTimestamp,   // NEW: Saves custom end time
    participants: [user] 
  });

  // Reset and close
  document.getElementById("title").value = "";
  document.getElementById("place").value = "";
  document.getElementById("description").value = "";
  closeCreateModal();
}

function loadEvents() {
  db.collection("events")
    .orderBy("startTime", "desc") // Order by our new start time
    .onSnapshot(snapshot => {
      const liveList = document.getElementById("events");
      const recapList = document.getElementById("recapEvents");
      
      liveList.innerHTML = "";
      recapList.innerHTML = "";

      const currentTime = Date.now();
      const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);

      snapshot.forEach(doc => {
        const e = doc.data();
        const id = doc.id;
        const attendeesCount = e.participants ? e.participants.length : 1;
        const attendeeNames = e.participants ? e.participants.join(", ") : e.user;

        const displayTag = e.tag ? `<div class="event-tag-badge">${e.tag}</div>` : '';
        const displayDesc = e.description 
          ? `<button class="read-more-btn" onclick="toggleEventDesc('${id}')">Read details...</button>
             <div class="event-desc-box">${e.description}</div>` 
          : '';

        // NEW: Smart Badges! Shows if an event is "LIVE" or "UPCOMING"
        let statusBadge = '';
        if (currentTime < e.startTime) {
           statusBadge = `<span style="background: #fef08a; color: #854d0e; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Upcoming</span>`;
        } else {
           statusBadge = `<span style="background: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase;"><i class='bx bx-radio-circle-marked bx-burst'></i> Live</span>`;
        }

        // Event is currently active or upcoming
        if (e.expiresAt > currentTime) {
          const hasJoined = e.participants && e.participants.includes(user);
          
          liveList.innerHTML += `
            <div class="event card" id="event-${id}">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                ${displayTag}
                ${statusBadge}
              </div>
              <div class="event-title">${e.title}</div>
              <div class="event-meta"><i class='bx bx-map'></i> ${e.place} • hosted by ${e.user}</div>
              
              ${displayDesc}
              
              <div class="attendees"><i class='bx bx-group'></i> Going (${attendeesCount}): ${attendeeNames}</div>
              
              ${e.user === user ? 
                `<button class="delete-btn" onclick="openDeleteModal('${id}')"><i class='bx bx-slider'></i> Manage Event</button>` : 
                (hasJoined ? 
                  `<button class="leave-btn" onclick="leaveEvent('${id}')"><i class='bx bx-exit'></i> Leave Hangout</button>` : 
                  `<button class="join" onclick="joinEvent('${id}')">Join Hangout</button>`
                )
              }
            </div>
          `;
        } 
        // Event has expired, move to recap
        else if (e.expiresAt > oneDayAgo) {
          recapList.innerHTML += `
            <div class="event card" style="background: #f9fafb; border: none; box-shadow: none;">
              ${displayTag}
              <div class="event-title" style="color: #4b5563;">${e.title}</div>
              <div class="event-meta"><i class='bx bx-map'></i> ${e.place} • hosted by ${e.user}</div>
              <div class="attendees" style="background:#f3f4f6; color: var(--text-muted);"><i class='bx bx-check-double'></i> Attended (${attendeesCount}): ${attendeeNames}</div>
            </div>
          `;
        }
      });
    });
}

function joinEvent(id) { db.collection("events").doc(id).update({ participants: firebase.firestore.FieldValue.arrayUnion(user) }); }
function leaveEvent(id) { db.collection("events").doc(id).update({ participants: firebase.firestore.FieldValue.arrayRemove(user) }); }
function openDeleteModal(id) { eventIdToManage = id; document.getElementById("deleteModal").classList.remove("hidden"); }
function closeDeleteModal() { eventIdToManage = null; document.getElementById("deleteModal").classList.add("hidden"); }
function confirmMoveToRecap() { if (!eventIdToManage) return; db.collection("events").doc(eventIdToManage).update({ expiresAt: Date.now() - 1 }).then(() => { closeDeleteModal(); }); }
function confirmDeletePermanently() { if (!eventIdToManage) return; db.collection("events").doc(eventIdToManage).delete().then(() => { closeDeleteModal(); }); }

// REALTIME MESSENGER & UNREAD BADGES
async function startChat() {
  const other = document.getElementById("chatUser").value.trim();
  if (!other) return alert("Please enter a username.");
  if (other === user) return alert("You can't start a chat with yourself!");

  try {
    const otherEmail = other.toLowerCase() + "@livesociya.com";
    const userRef = db.collection("users").doc(otherEmail);
    const docSnap = await userRef.get();
    if (!docSnap.exists) return alert(`User "${other}" does not exist. Please check the spelling.`);

    const chatId = [user, other].sort().join("_");
    
    // NEW: Added lastUpdated to track sorting
    await db.collection("chats").doc(chatId).set({ 
      users: [user, other],
      unreadBy: "",
      lastUpdated: Date.now() 
    }, { merge: true });
    
    document.getElementById("chatUser").value = "";
    openChat(chatId, other);

  } catch (error) { console.error("Error:", error); alert("Error finding user."); }
}

function openChat(chatId, otherUser) {
  currentChat = chatId;
  document.getElementById("chatHeaderAvatar").innerText = otherUser.charAt(0);
  document.getElementById("chatWithTitle").innerText = otherUser;
  document.getElementById("home").classList.add("hidden");
  document.querySelector(".topbar").classList.add("hidden");
  document.getElementById("chatScreen").classList.remove("hidden");
  
  db.collection("chats").doc(chatId).update({ unreadBy: "" });
  loadMessages();
}

function closeChat() {
  currentChat = null;
  if (messagesUnsubscribe) messagesUnsubscribe();
  document.getElementById("chatScreen").classList.add("hidden");
  document.querySelector(".topbar").classList.remove("hidden");
  document.getElementById("home").classList.remove("hidden");
}

// NEW: Captures the Enter key to send messages
function handleEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
}

function sendMessage() {
  const text = document.getElementById("msgInput").value.trim();
  if (!text || !currentChat) return;

  const otherUser = currentChat.split("_").find(u => u !== user);

  db.collection("messages").add({
    chatId: currentChat,
    sender: user,
    text: text,
    time: Date.now()
  });

  // NEW: Updates lastUpdated so this chat jumps to the top of the list!
  db.collection("chats").doc(currentChat).update({
    unreadBy: otherUser,
    lastUpdated: Date.now()
  });

  document.getElementById("msgInput").value = "";
}

function loadMessages() {
  if (messagesUnsubscribe) messagesUnsubscribe();
  const box = document.getElementById("messages");
  box.innerHTML = "";

  messagesUnsubscribe = db.collection("messages")
    .where("chatId", "==", currentChat)
    .orderBy("time", "asc")
    .onSnapshot(snapshot => {
      box.innerHTML = "";
      
      let lastDateString = ""; // NEW: Tracks the day to add separators

      snapshot.forEach(doc => {
        const m = doc.data();
        const isMe = m.sender === user;
        
        // --- NEW: DATE SEPARATOR LOGIC ---
        const msgDate = new Date(m.time).toLocaleDateString();
        if (msgDate !== lastDateString) {
          let displayDate = "";
          const today = new Date().toLocaleDateString();
          const yesterdayObj = new Date();
          yesterdayObj.setDate(yesterdayObj.getDate() - 1);
          const yesterday = yesterdayObj.toLocaleDateString();

          if (msgDate === today) displayDate = "Today";
          else if (msgDate === yesterday) displayDate = "Yesterday";
          else displayDate = new Date(m.time).toLocaleDateString([], { month: 'short', day: 'numeric' });

          box.innerHTML += `<div class="date-separator">${displayDate}</div>`;
          lastDateString = msgDate; // Update the tracker
        }
        // ---------------------------------

        box.innerHTML += `
          <div class="msg-wrapper" style="align-items: ${isMe ? 'flex-end' : 'flex-start'};" onclick="toggleTime(this)">
            <div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'}">
              ${m.text}
            </div>
            <div class="msg-time" style="text-align: ${isMe ? 'right' : 'left'}">
              ${formatTime(m.time)}
            </div>
          </div>
        `;
      });
      
      // Auto-scroll to the bottom when new message arrives
      box.scrollTop = box.scrollHeight; 
      
      if (currentChat) {
        db.collection("chats").doc(currentChat).update({ unreadBy: "" });
      }
    });
}

function loadChatList() {
  db.collection("chats")
    .where("users", "array-contains", user)
    .onSnapshot(snapshot => {
      const list = document.getElementById("chatList");
      list.innerHTML = "";
      
      let hasGlobalUnread = false;
      let chatsArray = [];

      // Collect all chats into an array first
      snapshot.forEach(doc => {
        chatsArray.push({ id: doc.id, ...doc.data() });
      });

      // NEW: Sort the array so the most recently updated chat is at the top (Index 0)
      chatsArray.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

      // Render the sorted list
      chatsArray.forEach(chat => {
        const other = chat.users.find(u => u !== user);
        const initial = other.charAt(0);
        const isUnread = chat.unreadBy === user;
        if (isUnread) hasGlobalUnread = true;
        
        list.innerHTML += `
          <div class="chat-item" onclick="openChat('${chat.id}', '${other}')" style="${isUnread ? 'background: #e0e7ff; border-color: var(--primary);' : ''}">
            <div class="chat-avatar">${initial}</div>
            <div class="chat-name" style="${isUnread ? 'font-weight: 800;' : ''}">${other}</div>
            ${isUnread ? `<div class="chat-unread-dot"></div>` : ''}
          </div>
        `;
      });

      const badge = document.getElementById("chatBadge");
      if (hasGlobalUnread) badge.classList.remove("hidden");
      else badge.classList.add("hidden");
    });
}

// UI NAVIGATION CONTROL LAYER
function showTab(tab) {
  document.getElementById("eventsTab").classList.add("hidden");
  document.getElementById("recapTab").classList.add("hidden");
  document.getElementById("chatsTab").classList.add("hidden");
  
  document.querySelectorAll(".nav-item").forEach(t => t.classList.remove("active"));

  if (tab === 'events') {
    document.getElementById("eventsTab").classList.remove("hidden");
    document.querySelectorAll(".nav-item")[0].classList.add("active");
  } else if (tab === 'recap') {
    document.getElementById("recapTab").classList.remove("hidden");
    document.querySelectorAll(".nav-item")[1].classList.add("active");
  } else {
    document.getElementById("chatsTab").classList.remove("hidden");
    document.querySelectorAll(".nav-item")[2].classList.add("active");
  }
}
