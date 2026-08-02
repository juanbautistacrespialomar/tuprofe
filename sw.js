// Service worker de Tu Profe.
// AUTO-UPDATE garantizado, sin reinstalar:
//   - skipWaiting(): la versión nueva se activa de una, no espera.
//   - message SKIP_WAITING: desbloquea cualquier versión que haya quedado "esperando".
//   - clients.claim(): toma control de las pestañas abiertas.
//   - controllerchange en el cliente: recarga la app sola.
// Network-first: siempre trae lo último si hay internet; cache = respaldo offline.
//
// Para publicar: subí el número de CACHE (v6 -> v7 -> ...).

const CACHE = "tuprofe-v16";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
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
