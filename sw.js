// This empty Service Worker allows the browser to trigger the "Add to Home Screen" prompt!
self.addEventListener('install', (e) => {
  console.log('[Service Worker] Installed');
});

self.addEventListener('fetch', (e) => {
  // Pass through all requests
});
