// Service worker de Tu Profe.
// Network-first (siempre trae lo último si hay internet; cache = respaldo offline).
// NO se auto-actualiza: espera a que el usuario toque "Actualizar" (SKIP_WAITING),
// así el cambio es controlado y no se recarga solo mientras la usás.

const CACHE = "tuprofe-v3";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  // Sin skipWaiting acá: queda "esperando" hasta que el usuario toque Actualizar.
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
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
  if (url.hostname.endsWith("workers.dev")) return; // API siempre a la red

  const esDoc = e.request.mode === "navigate" || e.request.destination === "document";
  if (esDoc) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
