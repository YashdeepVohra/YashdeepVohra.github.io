function scrollToMessage(time) {
    const targetMsg = document.getElementById(`msg-${time}`);
    if (!targetMsg) return;

    const bubble = targetMsg.querySelector(".msg-bubble");
    if (!bubble) return;

    // 1. Scroll
    targetMsg.scrollIntoView({ behavior: "smooth", block: "center" });

    // 2. The Force-Render Pattern
    // We wait 450ms for the scroll to finish, then force the browser to render
    setTimeout(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Now apply the animation directly to the GPU
                bubble.animate([
                    { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(79, 70, 229, 0.4)" },
                    { transform: "scale(1.03)", boxShadow: "0 0 0 8px rgba(79, 70, 229, 0.4)" },
                    { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(79, 70, 229, 0)" }
                ], {
                    duration: 1500,
                    easing: "ease-out"
                });
            });
        });
    }, 450);
}
