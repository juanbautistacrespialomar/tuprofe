// Service worker de tuprofe.
// Cachea el "shell" (la app) para que se instale y abra sin conexión.
// Las llamadas a la API (workers.dev) NO se cachean: siempre van a la red.

const CACHE = "tuprofe-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // La API siempre va a la red (nunca cache)
  if (url.hostname.endsWith("workers.dev")) return;
  // El resto: primero cache, si no está, red
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
