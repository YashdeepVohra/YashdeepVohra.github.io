/**
 * Photos, the side that touches the browser and the network.
 *
 * Every photo is squeezed ON THE DEVICE before it goes anywhere: a
 * 4 MB phone picture becomes ~200 KB, so an upload on campus wifi takes
 * a second instead of a minute and the free storage allowance lasts
 * twenty times longer. What is stored is the DOWNLOAD URL, which names
 * its bucket — see isOurPhotoUrl in photoRules.js for why that matters.
 *
 * Nothing here runs while features.photos is off.
 */
import { state } from '../state/store.js';
import { features } from '../config/features.js';
import { PHOTO, fitWithin, squareCrop, photoName, pathOfUrl } from './photoRules.js';

const SDK = "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage-compat.js";
let sdkLoading = null;

/**
 * The Storage SDK is fetched the first time it is needed, not at boot.
 * Everybody who never picks a photo never downloads it, and the boot
 * path (docs/boot.md) stays exactly as it was.
 */
export function loadStorage() {
  if (window.firebase && typeof window.firebase.storage === "function") {
    return Promise.resolve(window.firebase.storage());
  }
  if (!sdkLoading) {
    sdkLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SDK;
      s.async = true;
      s.onload = () => {
        try { resolve(window.firebase.storage()); } catch (e) { reject(e); }
      };
      s.onerror = () => { sdkLoading = null; reject(new Error("storage-sdk")); };
      document.head.appendChild(s);
    });
  }
  return sdkLoading;
}

/** Open the system picker; resolves to the chosen files (maybe none). */
export function pickImages({ multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PHOTO.ACCEPT;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(Array.from(input.files || []));
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    // Browsers apply the photo's EXIF rotation when drawing an <img>
    // now, so a portrait phone picture does not arrive on its side.
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}

/**
 * Shrink and re-encode as JPEG. `square` cuts the centred square first
 * (profile pictures). Re-encoding also drops EXIF — including where the
 * photo was taken, which nobody meant to publish.
 */
export async function compressImage(file, { edge, square = false } = {}) {
  if (!file || !/^image\//.test(file.type || "image/")) throw new Error("not-image");
  const img = await decode(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  let sx = 0, sy = 0, sw = W, sh = H;
  if (square) {
    const c = squareCrop(W, H);
    sx = c.sx; sy = c.sy; sw = sh = c.side;
  }
  const out = fitWithin(sw, sh, edge);
  if (!out.w) throw new Error("decode");
  const canvas = document.createElement("canvas");
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext("2d");
  // A transparent PNG would turn black as JPEG; paper-white behind it.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.w, out.h);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, out.w, out.h);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", PHOTO.QUALITY));
  if (!blob) throw new Error("encode");
  return blob;
}

/**
 * Upload one compressed photo to `folder/<my uid>/<random>.jpg` and
 * hand back its download URL. storage.rules checks the folder is
 * yours, the type is JPEG and the size is sane.
 */
export async function uploadPhoto(folder, blob) {
  if (!features.photos) throw new Error("photos-off");
  if (!state.uid) throw new Error("signed-out");
  const storage = await loadStorage();
  const ref = storage.ref(`${folder}/${state.uid}/${photoName()}`);
  await ref.put(blob, {
    contentType: "image/jpeg",
    // Names are never reused, so a photo can be cached for a year.
    cacheControl: "public, max-age=31536000, immutable"
  });
  return ref.getDownloadURL();
}

/** Best effort: a photo that outlived its record costs cents, not errors. */
export async function deletePhotoByUrl(url) {
  const path = pathOfUrl(url);
  if (!path || !features.photos) return;
  try {
    const storage = await loadStorage();
    await storage.ref(path).delete();
  } catch (e) {
    console.warn("Photo cleanup skipped:", e.code || e.message);
  }
}

/** Plain words for whatever went wrong, for a toast. */
export function photoError(e) {
  const m = (e && (e.code || e.message)) || "";
  if (/not-image|decode/.test(m)) return "That file isn't a photo we can read.";
  if (/storage-sdk|network|retry-limit/.test(m)) return "Couldn't upload — check your connection and try again.";
  if (/unauthorized|permission/.test(m)) return "That photo was refused. Try a smaller one.";
  return "Couldn't add that photo. Try again.";
}
