# Code map — where everything is

Open THIS before grepping. It says which file holds what, so a task
starts in the right place instead of reading the codebase. Line numbers
change; function names don't — search for the name.

## "I want to change…" → open

| Change | File (functions) | Also |
|---|---|---|
| A feed card (live poster, recap stub) | `js/services/eventsService.js` — `renderEvents`, `cardActions`, `posterBand`, `coverHtml`, `paintVolatile` | `docs/feed.md`, `docs/design.md` |
| Creating / editing an event | `eventsService.js` — `openCreateScreen`, `addEvent`, `saveEventEdits`, `onPlaceInput`; photos: `eventPhotoService.js` | `index.html #createScreen` |
| Joining, hype, requests, manage, delete | `eventsService.js` — `joinEvent`, `toggleHype`, `requestJoin`, `openPeople`, `confirmDeletePermanently` | rules `match /events` |
| The event page (tap a card) | `js/services/eventPage.js` — `openEventPage`, `renderEventPage` (main + side columns) | `index.html #eventScreen` |
| Likes, comments, memories, comment sheet, @mentions | `js/services/memoryService.js` — `socialBarHtml`, `paintSocial`, `memoriesHtml`, `postComment`, `openComments`, `onCommentInput` | rules `social/likes`, `comments`, `memories` |
| Stories | `storyService.js` (UI, loading), `storyRules.js` (pure: hours, rings, songs) | `index.html #storyViewer #storyComposer` |
| Photos (any) | `photoRules.js` (pure: sizes, URL check), `photoService.js` (compress, upload, delete), `utils/photoViewer.js` | `storage.rules`, `config/features.js` (the switch) |
| Chat, messages, inbox | `js/services/chatService.js` — `openChat`, `sendMessage`, `sendChatPhoto`, `renderMessages`, `loadChatList` | `messageRules.js` (pure: edit/retract/reactions/preview) |
| Profile page, Hosted/Joined journal, settings, report sheet | `js/services/profileService.js` — `openProfileScreen`, `paintProfileEvents`, `memoryCard`, `loadUserEvents`, `loadMoreProfileEvents`, `hideFromProfile`, `openReport`, `sendReport`, `refreshBlockedList` | `aboutRules.js` |
| Follow, followers/following lists, private accounts | `js/services/followService.js` — `toggleFollow`, `openFollowList`, `renderFollowList`, `fetchFollowers` | `docs/data.md` |
| Orbit (mutuals, vouches) | `orbitService.js` — `renderOrbit`, `pullIn`, `toggleVouch` | |
| Blocking, reports (filing) | `blockService.js` — `isBlocked`, `blockUser`, `submitReport` | |
| Admin report triage | `adminService.js` | rules `match /reports`, `admins` |
| Things you reported, hidden for you | `hiddenService.js` | |
| Lists of people, 20 at a time | `js/utils/pager.js` — `shown`, `sentinel`, `nextPage`, `watch` | used by follow lists, orbit, blocked |
| Rate limits | `limitsService.js` — `stampEvent`, `stampAsk`, `stampPost` | rules `private/limits`, `postAllowed()` |
| Names, avatars, profile cache | `userService.js` — `fetchUser`, `primeUsers` (batched), `displayNameFor` | |
| Sign-in, sign-up, boot of a user | `authService.js` — `initAuthListener`, `initializeUserApp`, `logout` | `docs/boot.md` |
| Search | `searchService.js`, `interactions/searchUI.js`, `matchRules.js` (pure scorer) | `docs/search.md` |
| Sharing an event | `shareService.js`, `shareRules.js` (pure) | `docs/sharing.md` |
| Recap retention, receipt | `recapRules.js`, `receiptRules.js`, `receiptService.js` | |
| Feed order | `feedRules.js` (pure) | |
| Active now | `presenceService.js` | |
| Circles / geo | `circleService.js`, `geoRules.js` | |
| Screens, tabs, toasts, title | `js/utils/ui.js` — `switchScreen`, `showTab`, `toast` | |
| Layers + Android back | `js/utils/overlays.js` — `openOverlay`, `closeOverlay` | |
| Keyboard / date pickers on phones | `js/utils/viewport.js` — `initViewportFit` (`--vvt`, `--vvh`, `kb-open`, `vv-shifted`) | `docs/layout.md` |
| Theme | `utils/theme.js` | |
| Coming back after a reload (warm start: tab, scroll, open chat) | `js/utils/restore.js`; applied in `app.js` `restoreWhereWeWere` | head script in `index.html`, `html.restoring` in style.css |
| Privacy Policy, Terms | `privacy.html`, `terms.html`, `legal.css` | links in `#settingsScreen .legal-links`, `#login .login-legal` |
| Global handlers used by inline `onclick` | `js/app.js` — the `Object.assign(window, {...})` block. A new `window.x` MUST be added there. | |
| Feature switches | `js/config/features.js` (`photos`) | |
| Firebase init | `js/config/firebase.js` | |

## Files that are not JS

| File | What |
|---|---|
| `index.html` | Every screen and layer, by id: `#home` (tabs `#eventsTab #recapTab #chatsTab`), `#chatScreen`, `#profileScreen`, `#createScreen`, `#eventScreen`, `#settingsScreen`, `#orbitScreen`, `#followListScreen`, `#commentSheet`, `#storyViewer`, `#storyComposer`, `#photoViewer`, `#adminScreen`, `#reportModal`, `#deleteModal` |
| `style.css` | One sheet, ~5000 lines. Tokens at the top (`:root`, then `:root[data-theme="dark"]` near the end). Search section banners (`/* ====`) by name: POSTER, CARD ACTIONS, PHOTOS, THE EVENT PAGE, MEMORIES, THE JOURNAL, STORIES, REPORT TRIAGE, LISTS OF PEOPLE, NO STRETCH, DARK MODE. New rules go at the END unless they must override a media block. |
| `firestore.rules` | ~1500 lines. Helpers at the top (`okPhotoUrl`, `okAvatar`, `isAdmin`, `notBanned`, `postAllowed`, `limits()`), then one `match` per collection. |
| `storage.rules` | Photos: `avatars/{uid}`, and `events|chats|memories|stories/{uid}`. |
| `firestore.indexes.json` | Composite indexes (events, chats, stories). |
| `test/smoke.mjs` | The regression suite, one `group(...)` per area — search the group name. `test/stub.js` fakes Firebase. See `docs/testing.md`. |

## Data, in one screen

```
users/{uid}                 profile (+ following[], hiddenEvents[], banned)
  /followers/{uid}          one doc per follower
  /followRequests/{uid}     asks to a private account
  /private/limits           rate-limit ledger (rules-only shape)
usernames/{handle}          handle -> uid, create-only
events/{id}                 the event (participantUids, hypedUids, photos[] …)
  /messages /typing /pinned the group chat
  /memories/{uid_n}         photos from who went (3 each)
  /social/likes             { uids[], comments, lastCommentId }
  /comments/{id}            { uid, text, createdAt }
chats/{a_b}/messages/{id}   direct messages
stories/{id}                { uid, photo, caption, hours, audience, song }
blocks/{a_b} orbit/{a_b}    pair documents
presence/{uid} circles/{id}
reports/{id}                filed by anyone, read by admins only
admins/{uid}                made by hand in the console
```
