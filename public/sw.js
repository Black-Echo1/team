// Minimal service worker: mainly exists so the browser considers this app
// installable (PWA requirement). Deliberately does NOT cache-first the app
// shell, because Vite renames built JS/CSS files on every deploy (content
// hash in the filename) — caching index.html would keep pointing at old,
// now-deleted asset filenames and break the app with 404s after an update.
// It also does NOT cache ffmpeg.wasm core files or video/audio blobs.

const CACHE_NAME = "dubbing-studio-shell-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Network-first for navigations and the built JS/CSS assets: always try to
  // get the latest version first, only falling back to cache if fully offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
  );
});

