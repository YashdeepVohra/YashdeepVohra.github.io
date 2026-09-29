/**
 * A small tick you can feel — for the moments a phone app would give
 * one: a message picked up by a long press, a swipe that has gone far
 * enough to reply, a reaction, a hype.
 *
 * ANDROID: navigator.vibrate, a few milliseconds. Chrome only lets a
 * page vibrate once the person has touched it, which in a chat they
 * always have; the phone's own "touch vibration" setting still wins.
 *
 * iPHONE: Safari has no vibrate at all. iOS 18 does give a haptic when
 * a switch-style checkbox is toggled, and toggling one from a real tap
 * works — so where vibrate is missing, a hidden switch is flipped. It
 * only fires inside a tap (not from a timer), so on an iPhone the
 * swipe-to-reply and the sheet's buttons tick and a long press is
 * silent. Older iPhones: nothing, and nothing breaks.
 *
 * Nothing here can throw, and nothing waits on it.
 */
let iosSwitch = null;

function iosTick() {
  try {
    if (!iosSwitch) {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      label.appendChild(input);
      // Its clicks are nobody else's business: the emoji panel, for one,
      // closes on any click outside it.
      const stop = (e) => e.stopPropagation();
      label.addEventListener("click", stop);
      input.addEventListener("click", stop);
      document.body.appendChild(label);
      iosSwitch = label;
    }
    iosSwitch.click();
  } catch (e) { /* no haptics here */ }
}

export function buzz(ms = 12) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(ms);
      return;
    }
    if (/iP(hone|ad|od)/.test(navigator.userAgent || "")) iosTick();
  } catch (e) { /* no haptics here */ }
}
