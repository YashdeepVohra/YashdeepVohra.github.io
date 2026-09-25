// ==========================================
// EMOJI PICKER — the smiley in the chat composer
// ==========================================
//
// A phone has emoji on its keyboard; a laptop does not, and hunting for
// the OS picker shortcut is the reason people on a laptop typed ":)"
// instead. So the composer carries its own: a button inside the field,
// a panel above it with Recent + eight categories, and a tap puts the
// emoji where the caret is.
//
// Rules it keeps:
//   - Nothing in it takes focus off the message field. Every control
//     cancels its own mousedown, the same trick Send uses, so on a
//     laptop you can click three emoji and keep typing, and on iOS the
//     keyboard never drops.
//   - On a touch screen it does NOT focus the field after inserting:
//     that would throw the keyboard up over the panel you are using.
//   - It is a popover, not a layer: it lives inside the chat footer,
//     closes on Escape, on a click anywhere else, and with the chat.
//   - "Recent" is a per-device convenience in localStorage, wrapped,
//     because private windows throw on it.
//   - Plain Unicode, no images, no network. What you pick is what the
//     other person's phone draws.
// ==========================================

const CATEGORIES = [
  { id: "smileys", label: "Smileys", icon: "😀", list:
    "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 🤡 👻 👽 🤖 💩" },
  { id: "people", label: "People", icon: "👋", list:
    "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫶 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🦾 🫡 🫠 🫢 🫣 🤷 🤦 🙋 🙆 🙅 💁 🙇 🧍 🚶 🏃 💃 🕺 👯 🧑‍🤝‍🧑 👀 👁️ 🧠 🫀 👄" },
  { id: "hearts", label: "Hearts", icon: "❤️", list:
    "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💋 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ ⭐ 🌟 🔥 ⚡ 🌈" },
  { id: "food", label: "Food", icon: "🍕", list:
    "☕ 🍵 🧋 🥤 🧃 🍺 🍻 🥂 🍷 🍹 🍕 🍔 🍟 🌭 🥪 🌮 🌯 🥙 🧆 🍜 🍝 🍛 🍲 🍚 🍙 🥟 🍱 🍣 🥗 🍿 🧂 🥐 🍞 🥯 🧇 🥞 🍳 🧀 🍗 🍖 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍦 🍨 🍎 🍌 🍉 🍇 🍓 🥭 🍍 🥥 🥑 🌶️ 🌽 🥕" },
  { id: "activity", label: "Activity", icon: "⚽", list:
    "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🏓 🏸 🏏 🏑 🥅 ⛳ 🏊 🚴 🧗 🏋️ 🤸 🧘 🏆 🥇 🥈 🥉 🏅 🎖️ 🎯 🎳 🎮 🕹️ 🎲 ♟️ 🧩 🎨 🎭 🎬 🎤 🎧 🎼 🎹 🥁 🎸 🎺 🎻 📚 📖 ✏️ 📝 💻 📸 🎉 🎊 🎈 🎁 🪩" },
  { id: "nature", label: "Nature", icon: "🌿", list:
    "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦉 🦋 🐝 🐞 🐢 🐍 🐙 🐬 🐳 🦈 🌸 🌼 🌻 🌹 🌷 🌱 🌿 🍀 🍁 🍂 🌵 🌴 🌳 🌙 ☀️ ⛅ 🌧️ ⛈️ ❄️ 🌊" },
  { id: "travel", label: "Places", icon: "🚗", list:
    "🚗 🚕 🛺 🚌 🚎 🏍️ 🛵 🚲 🛴 🚆 🚇 🚉 ✈️ 🚀 🛸 ⛵ 🗺️ 📍 🏠 🏫 🏢 🏥 🏟️ ⛪ 🕌 🛕 🏖️ 🏕️ ⛰️ 🌋 🌃 🌆 🌇 🌉 🎡 🎢 🎪 ⏰ ⌛ 📅 📆 📱 ☎️ 🔋 💡 🔦 🕯️ 💸 💰 🛒 🎒 👟 🧢 👓 🕶️" },
  { id: "symbols", label: "Symbols", icon: "✅", list:
    "✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ❓ ❔ ❗ ‼️ ⁉️ 〰️ ⚠️ 🚫 ⛔ 🔞 📵 🆗 🆒 🆕 🆓 🆙 🔝 🔜 ⏩ ⏪ ▶️ ⏸️ ⏹️ 🔁 🔀 🔔 🔕 📢 📣 🔒 🔓 🔑 ♻️ ⭕ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟩 🟦 ➡️ ⬅️ ⬆️ ⬇️ ↗️ 🔗 #️⃣ *️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣" }
];

const RECENT_KEY = "ls_recent_emoji";
const RECENT_MAX = 24;

let panel = null;
let current = "recent";

const coarse = () => !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x.length <= 16).slice(0, RECENT_MAX) : [];
  } catch (e) {
    return [];
  }
}

function remember(emoji) {
  try {
    const next = [emoji, ...readRecent().filter((x) => x !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch (e) { /* a private window: fine, just no Recent */ }
}

function listFor(id) {
  if (id === "recent") return readRecent();
  const cat = CATEGORIES.find((c) => c.id === id);
  return cat ? cat.list.split(" ").filter(Boolean) : [];
}

function paintGrid() {
  if (!panel) return;
  const grid = panel.querySelector(".emoji-grid");
  const title = panel.querySelector(".emoji-title");
  const list = listFor(current);
  const cat = CATEGORIES.find((c) => c.id === current);
  title.textContent = current === "recent" ? "Recently used" : cat.label;
  // Emoji are fixed strings from the list above (or ones we stored from
  // it), never user text — but they still go in through textContent.
  grid.textContent = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "emoji-empty";
    p.textContent = "The ones you use will show up here.";
    grid.appendChild(p);
  } else {
    const frag = document.createDocumentFragment();
    list.forEach((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-cell";
      b.textContent = e;
      b.setAttribute("aria-label", e);
      b.dataset.emoji = e;
      frag.appendChild(b);
    });
    grid.appendChild(frag);
  }
  grid.scrollTop = 0;
  panel.querySelectorAll(".emoji-tab").forEach((t) => {
    const on = t.dataset.cat === current;
    t.classList.toggle("on", on);
    t.setAttribute("aria-selected", String(on));
  });
}

function build() {
  const footer = document.querySelector("#chatScreen .chat-footer");
  if (!footer) return null;
  const el = document.createElement("div");
  el.id = "emojiPanel";
  el.className = "emoji-panel hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Emoji");

  const tabs = document.createElement("div");
  tabs.className = "emoji-tabs";
  tabs.setAttribute("role", "tablist");
  const mkTab = (id, label, glyph) => {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "emoji-tab";
    t.dataset.cat = id;
    t.setAttribute("role", "tab");
    t.setAttribute("aria-label", label);
    t.title = label;
    t.textContent = glyph;
    tabs.appendChild(t);
  };
  mkTab("recent", "Recent", "🕘");
  CATEGORIES.forEach((c) => mkTab(c.id, c.label, c.icon));

  const title = document.createElement("div");
  title.className = "emoji-title";
  const grid = document.createElement("div");
  grid.className = "emoji-grid";

  el.append(tabs, title, grid);
  footer.insertBefore(el, footer.firstChild);

  // Nothing in here may steal focus from the message field.
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    const cell = e.target.closest(".emoji-cell");
    if (cell) return insertEmoji(cell.dataset.emoji);
    const tab = e.target.closest(".emoji-tab");
    if (tab) { current = tab.dataset.cat; paintGrid(); }
  });
  return el;
}

/** Put `emoji` where the caret is in the message field. */
export function insertEmoji(emoji) {
  const input = document.getElementById("msgInput");
  if (!input || !emoji) return;
  const v = input.value;
  const start = typeof input.selectionStart === "number" ? input.selectionStart : v.length;
  const end = typeof input.selectionEnd === "number" ? input.selectionEnd : v.length;
  input.value = v.slice(0, start) + emoji + v.slice(end);
  const caret = start + emoji.length;
  try { input.setSelectionRange(caret, caret); } catch (e) {}
  if (!coarse()) input.focus();
  // The composer listens for input (typing indicator, the Send state).
  input.dispatchEvent(new Event("input", { bubbles: true }));
  remember(emoji);
}

export function isEmojiOpen() {
  return !!panel && !panel.classList.contains("hidden");
}

export function openEmojiPicker() {
  panel = panel || build();
  if (!panel) return;
  // Open on Recent when there is something in it, else on Smileys.
  if (current === "recent" && !readRecent().length) current = "smileys";
  paintGrid();
  panel.classList.remove("hidden");
  document.getElementById("emojiBtn")?.setAttribute("aria-expanded", "true");
  document.getElementById("emojiBtn")?.classList.add("on");
}

export function closeEmojiPicker() {
  if (!panel) return;
  panel.classList.add("hidden");
  document.getElementById("emojiBtn")?.setAttribute("aria-expanded", "false");
  document.getElementById("emojiBtn")?.classList.remove("on");
  if (!readRecent().length) return;
  current = "recent";
}

export function toggleEmojiPicker() {
  if (isEmojiOpen()) closeEmojiPicker();
  else openEmojiPicker();
}

/** Wire the button, Escape and click-away. Called once at boot. */
export function initEmojiPicker() {
  const btn = document.getElementById("emojiBtn");
  if (!btn) return;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => { e.stopPropagation(); toggleEmojiPicker(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isEmojiOpen()) { e.stopPropagation(); closeEmojiPicker(); }
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (!isEmojiOpen()) return;
    if (e.target.closest && (e.target.closest("#emojiPanel") || e.target.closest("#emojiBtn") || e.target.closest("#msgInput") || e.target.closest("#sendBtn"))) return;
    closeEmojiPicker();
  });
}
