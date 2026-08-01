# Coach App

App de rutinas para profes de gimnasio. El profe arma la rutina de cada
alumno (días → bloques → ejercicios, con video de YouTube y series/reps);
el alumno la ve, mira los videos y registra sus cargas. Bidireccional:
el profe ve el progreso del alumno.

## Stack
- **Frontend:** PWA vanilla (HTML/CSS/JS), instalable en Android e iOS.
- **Hosting front:** Cloudflare Pages (conectado a este repo de GitHub).
- **Backend:** Cloudflare Worker (`worker/index.js`).
- **Base de datos:** Cloudflare D1 (`schema.sql`).

## Roles (login por código, una sola pantalla para todos)
- **Admin (vos):** código guardado como secret en el Worker. Crea profes.
- **Profe:** código `PROF-xxxx`. Crea alumnos y arma rutinas. Ve solo lo suyo.
- **Alumno:** código `ALU-xxxx`. Ve su rutina y registra cargas.

## Setup del backend (una vez)

```bash
# 1. Instalar wrangler (CLI de Cloudflare)
npm install -g wrangler
wrangler login

# 2. Crear la base D1 y pegar el database_id en wrangler.toml
wrangler d1 create coach-app-db

# 3. Cargar el esquema
wrangler d1 execute coach-app-db --file=schema.sql

# 4. Definir tu código de admin (secreto, encriptado)
wrangler secret put ADMIN_CODE
#   te lo pide por teclado, poné algo tipo "ADMIN-TUCLAVE"

# 5. Deployar el Worker
wrangler deploy
```

## Probar rápido (con la base seed)

```bash
# Login como el profe de ejemplo
curl -X POST https://TU-WORKER.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{"codigo":"PROF-DEMO1"}'

# Crear un alumno (usando el código del profe)
curl -X POST https://TU-WORKER.workers.dev/alumnos \
  -H "Authorization: Bearer PROF-DEMO1" \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Juan Crespi","objetivo":"Hipertrofia"}'
```

## Estructura

```
coach-app/
├── README.md
├── schema.sql          # todas las tablas de D1
├── wrangler.toml       # config Cloudflare + binding a D1
└── worker/
    └── index.js        # la API: login multi-rol + endpoints
```

## Qué falta (próximos pasos)
1. Endpoints CRUD de rutina: días, bloques, ejercicios, cargas.
2. Frontend PWA con las 3 vistas (admin / profe / alumno) + onboarding
   de instalación en móvil.
3. Dashboard del home (últimos 7 días + calendario de asistencia).
