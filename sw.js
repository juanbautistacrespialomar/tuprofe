// Service worker de Tu Profe.
// Estrategia: NETWORK-FIRST para la app (siempre trae lo último si hay
// internet), y el cache queda solo como respaldo para usar sin conexión.
// Así las actualizaciones se ven al recargar, sin quedar pegado a una copia vieja.

const CACHE = "tuprofe-v2";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

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

  // La API siempre va a la red directa (nunca la tocamos)
  if (url.hostname.endsWith("workers.dev")) return;

  // Navegaciones y HTML: primero red, si falla (offline) usamos el cache
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

  // Resto de assets (íconos, etc.): primero cache, si no está, red
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
