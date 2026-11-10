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
- **Olvidé mi contraseña (sin mails):** el usuario deja un pedido; al admin (si es profe) o a su profe (si es alumno) le aparece un aviso y resetea con la llave. La respuesta es siempre la misma, exista o no el mail.
- **Clave temporal:** todo reseteo marca `debe_cambiar = 1`; al entrar, la app obliga a elegir una contraseña propia. Cambiar la clave cierra las sesiones de los otros dispositivos.

## Estructura

```
tuprofe/
├── index.html                    # toda la PWA (auth + profe + alumno + admin)
├── sw.js                         # service worker (auto-update)
├── manifest.json                 # instalación PWA
├── icon-192.png / icon-512.png   # ícono de la app
├── schema.sql                    # esquema completo (instalación de cero)
├── migracion-invitaciones.sql    # migración: tabla invitaciones sin borrar datos
├── migracion-planificaciones-evaluaciones.sql  # migración: plantillas + evaluaciones (solo crea tablas)
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

**Público:** `POST /registro/profe`, `POST /registro/alumno`, `POST /login`, `POST /auth/google`, `POST /olvide-password`, `POST /reset-password`

**Con token:** `GET /yo`, `POST /logout`, `PUT /mi-password`

**Profe:** `GET/POST /catalogo`, `PUT/DELETE /catalogo/:id`, `GET /alumnos`, `GET /alumnos/:id`, `GET /alumnos/:id/cargas`, `POST /alumnos/:id/reset-password`, `GET/POST/DELETE /invitaciones`, `POST/PUT/DELETE` de `/dias`, `/bloques`, `/ejercicios`

**Profe · Planificaciones:** `GET/POST /plantillas`, `GET/PUT/DELETE /plantillas/:id`, `POST /plantillas/:id/duplicar`, `POST /plantillas/:id/asignar` (`{ alumno_id, fechas: [...] }`), `POST/PUT/DELETE` de `/plantilla-bloques` y `/plantilla-ejercicios`

**Profe · Evaluaciones:** `GET /evaluaciones` (`?alumno_id=`), `POST /evaluaciones` (`{ alumno_ids, tipo, ... }`), `GET/PUT/DELETE /evaluaciones/:id`

**Alumno:** `GET/PUT /mi-wellness`, `GET /mis-evaluaciones`, `PUT /mis-evaluaciones/:id`, `GET /mi-rutina`, `POST /cargas`, `GET /mis-cargas`, `GET /mis-mejores-marcas`, `PUT /mi-perfil` (foto, objetivo, observaciones)

**Admin:** `GET /admin/profesores`, `PUT/DELETE /admin/profesores/:id` (`{ habilitado }` y/o `{ tope_alumnos }`), `POST /admin/profesores/:id/reset-password`

## Versionado y auto-update

- La versión vive en el `CACHE` de `sw.js` (`tuprofe-vXX`) y en el cartel de versión del `index.html`.
- **Al publicar, subí SIEMPRE `index.html` y `sw.js` juntos, con el número aumentado.** El `sw.js` es el que dispara la actualización en los celulares.
- La app se actualiza sola: al detectar una versión nueva muestra un cartel central de "Actualizar".

## Planificaciones y evaluaciones (v80)

- **Planificaciones:** plantillas generales del profe (solapa propia). Se arman con el mismo editor que la rutina y se **asignan** a un alumno en una o varias fechas: se crea una COPIA en su rutina, editable sin tocar la plantilla. También se puede guardar cualquier día de un alumno como planificación (ícono de capas).
- **Evaluaciones:** el profe pide un test (uno o varios alumnos, con instrucciones y video). Al alumno le aparece un puntito en la solapa Evaluaciones hasta que lo carga; al profe, uno cuando hay algo para revisar.
  - Test iniciales: `ohs` (overhead squat) y `unipodal` (por pierna). El alumno pega el link del video; el profe marca compensaciones y puntaje 0-3.
  - Evaluaciones físicas: `rm` (1RM estimado, Brzycki/Epley), `cmj`, `abalakov`, `sj` (altura en cm o por tiempo de vuelo; potencia de Sayers; % de brazos e índice de elasticidad contra el último CMJ) y `vbt` (perfil carga-velocidad y 1RM estimado).
- Migración: `npx wrangler d1 execute tuprofe-db --file=migracion-planificaciones-evaluaciones.sql --remote` (solo crea tablas; re-ejecutable).

## Wellness, tope de alumnos y recuperación por mail (v92)

No hace falta correr ninguna migración: el worker agrega solo la columna `profesores.tope_alumnos` y crea las tablas `wellness` y `codigos_reset` la primera vez que arranca (solo suma, no toca datos).

- **Wellness:** cuestionario de 4 preguntas (sueño, estrés, fatiga, dolor muscular), del 1 (lo mejor) al 7 (lo peor). Total de 4 a 28: más bajo, mejor.
  - Alumno: se le abre solo cuando marca el último ejercicio del día. Si lo saltea, queda una tarjeta en el día para responderlo. Una respuesta por día; funciona sin señal (cola). Si el dolor es 5 o más, pregunta dónde.
  - Profe: semáforo en la lista de alumnos (respuestas de los últimos 3 días) y, en Seguimiento, el detalle de cada día + la tendencia de 4 semanas.
  - Semáforo: **rojo** si algún ítem es 6-7, el total es 20 o más, o está 4+ puntos arriba de su promedio; **amarillo** si algún ítem es 5, el total es 16 o más, o está 2+ puntos arriba. El promedio es el de sus 4 semanas previas y solo cuenta con 3 respuestas o más.
  - El export (JSON y CSV) incluye el wellness; en el CSV va en las columnas `wl_*` de cada fila.
- **Tope de alumnos:** en el panel de admin, tocar la cantidad de alumnos de un profe y elegir "Sin límite" o un número. Con el tope alcanzado el profe no puede generar invitaciones y los links pendientes no dejan registrarse (no se queman). Nunca se borra a nadie.
- **Olvidé mi contraseña:** tres caminos.
  1. Botón de Google en esa pantalla (si el mail es de Google, entra sin clave).
  2. Código de 6 dígitos por mail: se activa cargando en el Worker los secretos `MAIL_URL` y `MAIL_CLAVE` (ver `apps-script-mail.gs`). Vence a los 15 minutos, 5 intentos, y al usarlo entra directo.
  3. Sin esos secretos (o si el envío falla) sigue el camino de siempre: el pedido le aparece al profe o al admin.

## Inicio del profe (v93)

El profe ahora entra a la pestaña **Inicio** ("Tu día") en vez de caer en el catálogo. Sin migraciones: solo lee.

- **Tu día:** alumnos (contra el tope si tiene), cuántos entrenan hoy y cuántos ya terminaron.
- **Para atender:** wellness en alerta, evaluaciones para revisar, rutina por cargar (alumno sin rutina, o cuyo último día con fecha es hoy o ya pasó), alumnos que hace 7 días o más no registran nada, y pedidos de clave. Un grupo con un solo alumno abre directo; con varios, se despliega.
- **Hoy entrenan:** quien tiene un día con fecha de hoy o ya registró algo hoy, con su avance o su wellness.
- **Últimas notas:** notas de ejercicios y notas para el entrenador de los últimos 14 días.
- Endpoint nuevo: `GET /inicio?hoy=YYYY-MM-DD&tz=<minutos>` (profe). Si el worker todavía no lo tiene, la pantalla muestra lo que puede con lo ya cargado.
