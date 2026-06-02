function updateChatFooterUI() {
  const footer = document.querySelector(".chat-footer");
  if (!footer) return;

  // 1. Icebreaker check (Only if it hasn't been initialized)
  if (currentChatStatus === "icebreaker" && currentChatInitiator === user && myMessageCount >= 1) {
      footer.innerHTML = `<div style="width: 100%; text-align: center; color: var(--text-muted); font-size: 13px; font-weight: bold; padding: 10px;">Icebreaker sent! Waiting...</div>`;
      return;
  }

  // 2. Check if the input already exists
  const existingInput = document.getElementById("msgInput");
  
  // If the input doesn't exist yet, build the footer shell
  if (!existingInput) {
    footer.style.flexDirection = "column";
    footer.innerHTML = `
      <div id="replyPreviewContainer"></div>
      <div class="input-wrapper" style="display: flex; gap: 10px; width: 100%;">
          <input id="msgInput" placeholder="Message..." autocomplete="off" oninput="handleTyping()" onkeydown="if(event.key === 'Enter') sendMessage()" style="margin-bottom:0;" />
          <button onclick="sendMessage()" style="height: 50px; width: 50px; flex-shrink: 0;"><i class='bx bxs-send'></i></button>
      </div>`;
  }

  // 3. Update ONLY the Reply Bar (The input is left alone, so keyboard stays open!)
  const previewContainer = document.getElementById("replyPreviewContainer");
  if (previewContainer) {
      if (replyingToMessage) {
          const name = replyingToMessage.sender === user ? "Yourself" : replyingToMessage.sender;
          previewContainer.innerHTML = `
            <div class="reply-preview-bar" style="background: rgba(79, 70, 229, 0.1); padding: 8px 12px; border-radius: 12px; border-left: 4px solid var(--primary); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                 <div style="color: var(--primary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <b>Replying to ${name}:</b><br>${replyingToMessage.text}
                 </div>
                 <div onclick="cancelReply()" style="cursor: pointer; color: var(--danger); margin-left: 10px;"><i class='bx bx-x' style="font-size: 20px;"></i></div>
            </div>`;
      } else {
          previewContainer.innerHTML = "";
      }
  }
}
