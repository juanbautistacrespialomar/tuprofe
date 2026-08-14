// Service worker de Tu Profe.
// UPDATE CON AVISO (no automático):
//   - En install NO llamamos skipWaiting: la versión nueva queda "waiting".
//   - El cliente detecta esa versión esperando y muestra el botón "Actualizar".
//   - Al tocarlo, el cliente manda SKIP_WAITING -> se activa -> controllerchange -> recarga.
// La primera instalación (sin versión previa) se activa sola igual (no hay nada que esperar).
// Network-first: siempre trae lo último si hay internet; cache = respaldo offline.
//
// Para publicar: subí el número de CACHE (v23 -> v24 -> ...).

const CACHE = "tuprofe-v42";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  // Sin skipWaiting: la versión nueva espera a que el usuario toque "Actualizar".
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
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
