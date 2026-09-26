/**
 * Features that are built but not switched on.
 *
 * PHOTOS needs Cloud Storage, and Cloud Storage needs the Blaze plan.
 * Everything for it is in the app already — compression, upload,
 * storage.rules, the pickers, the cover on a card — and stays out of
 * sight until this is true. Nothing that is off costs a byte: the
 * Storage SDK is only fetched the first time a photo is picked.
 *
 * Turning it on (docs/photos.md has the whole checklist):
 *   1. Blaze + a budget alert
 *   2. Storage → Get started → US-CENTRAL1 (the no-cost region)
 *   3. firebase deploy --only storage,firestore:rules
 *   4. photos: true below, npm run build, commit, push
 *
 * An object, not a const, so a test can flip it on the live module.
 */
export const features = {
  photos: false
};

/** Called once at boot: every `.needs-photos` element follows the flag. */
export function applyFeatureFlags(doc = document) {
  doc.body?.classList.toggle("photos-on", features.photos === true);
}
