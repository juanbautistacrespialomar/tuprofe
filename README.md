# Tu Profe

App de rutinas de gimnasio. El profe arma su **catálogo de ejercicios** (con videos de YouTube) y le carga a cada alumno una **rutina** organizada por días → bloques → ejercicios. El alumno la ve en su celular, mira los videos y **registra sus cargas** (peso, reps, si lo completó). Es **bidireccional**: el profe ve el progreso que el alumno va cargando.

Instalable como app (PWA) en Android y iOS, sin pasar por las tiendas.

## Stack

- **Frontend:** PWA vanilla (HTML/CSS/JS en un solo `index.html`), servida por **GitHub Pages**.
- **Backend:** **Cloudflare Worker** (`worker/index.js`).
- **Base de datos:** **Cloudflare D1** (SQLite) — esquema en `schema.sql`.
- Sin frameworks ni dependencias externas.

## Roles y acceso

- **Admin** (dueño de la plataforma): columna `es_admin` en `profesores`. Da de alta/baja profes y les resetea la contraseña desde el panel de admin.
- **Profe:** se registra solo con email + contraseña. Arma su catálogo, invita alumnos (link de un solo uso), arma rutinas y ve el progreso.
- **Alumno:** se registra con email + contraseña entrando por el **link de invitación** de su profe (un solo uso). Ve su rutina, registra cargas y edita su perfil (objetivo, observaciones).

Seguridad:

- Contraseñas **hasheadas** con PBKDF2 (nunca en texto plano).
- **Sesión persistente** por token (no vuelve a pedir login hasta borrar la app o cerrar sesión).
- **Multi-tenant:** cada profe ve solo lo suyo; cada operación verifica la propiedad del recurso.
- **Invitaciones de un solo uso:** el link se "quema" cuando el alumno se registra.

## Estructura

```
tuprofe/
├── index.html                    # toda la PWA (auth + profe + alumno + admin)
├── sw.js                         # service worker (auto-update)
├── manifest.json                 # instalación PWA
├── icon-192.png / icon-512.png   # ícono de la app
├── schema.sql                    # esquema completo (instalación de cero)
├── migracion-invitaciones.sql    # migración: tabla invitaciones sin borrar datos
├── wrangler.toml                 # config Cloudflare + binding a D1
└── worker/
    └── index.js                  # la API
```

## Setup del backend (una vez)

```bash
npm install -g wrangler
wrangler login

wrangler d1 create tuprofe-db          # pegar el database_id en wrangler.toml
wrangler d1 execute tuprofe-db --file=schema.sql --remote

wrangler deploy
```

- Republicar backend tras tocar `worker/index.js`: `wrangler deploy`
- Migraciones que agregan sin borrar: `wrangler d1 execute tuprofe-db --file=<archivo>.sql --remote`

## Frontend (deploy)

Se sirve desde **GitHub Pages** (Settings → Pages → branch `main`, root). Se actualiza subiendo los archivos al repo.

## Endpoints de la API

**Público:** `POST /registro/profe`, `POST /registro/alumno`, `POST /login`

**Con token:** `GET /yo`, `POST /logout`

**Profe:** `GET/POST /catalogo`, `PUT/DELETE /catalogo/:id`, `GET /alumnos`, `GET /alumnos/:id`, `GET /alumnos/:id/cargas`, `POST /alumnos/:id/reset-password`, `GET/POST/DELETE /invitaciones`, `POST/PUT/DELETE` de `/dias`, `/bloques`, `/ejercicios`

**Alumno:** `GET /mi-rutina`, `POST /cargas`, `GET /mis-cargas`, `PUT /mi-perfil` (foto, objetivo, observaciones)

**Admin:** `GET /admin/profesores`, `PUT/DELETE /admin/profesores/:id`, `POST /admin/profesores/:id/reset-password`

## Versionado y auto-update

- La versión vive en el `CACHE` de `sw.js` (`tuprofe-vXX`) y en el cartel de versión del `index.html`.
- **Al publicar, subí SIEMPRE `index.html` y `sw.js` juntos, con el número aumentado.** El `sw.js` es el que dispara la actualización en los celulares.
- La app se actualiza sola: al detectar una versión nueva muestra un cartel central de "Actualizar".
