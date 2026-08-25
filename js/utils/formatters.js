// ==========================================
// FORMATTERS & RICH MEDIA EMBEDS
// ==========================================
export function renderAvatar(avatarCode) {
  if (!avatarCode) return "👤";
  if (typeof avatarCode === 'string' && avatarCode.startsWith("http")) {
    return `<img src="${avatarCode}" referrerpolicy="no-referrer" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">`;
  }
  return avatarCode;
}

export function formatTime(ms) {
  const messageDate = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const timeString = messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (messageDate.toDateString() === today.toDateString()) return `Today at ${timeString}`;
  if (messageDate.toDateString() === yesterday.toDateString()) return `Yesterday at ${timeString}`;
  return `${messageDate.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeString}`;
}

export function formatMessage(text, isMediaOnly = false) {
  let safeText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  return safeText.replace(urlRegex, function(url) {
    // YouTube Embed
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

    // Spotify Embed
    if (url.includes("open.spotify.com/track") || url.includes("open.spotify.com/playlist") || url.includes("open.spotify.com/album")) {
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

    // Standard Link
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: inherit; font-weight: 700; text-decoration: underline; word-break: break-all;">${url}</a>`;
  });
}
