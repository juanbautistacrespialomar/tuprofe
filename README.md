# tuprofe

App de rutinas para profes de gimnasio. El profe arma la rutina de cada
alumno (días → bloques → ejercicios, con video de YouTube y series/reps);
el alumno la ve, mira los videos y registra sus cargas. Bidireccional:
el profe ve el progreso del alumno.

## Stack
- **Frontend:** PWA vanilla (HTML/CSS/JS), instalable en Android e iOS.
- **Hosting front:** Cloudflare Pages (conectado a este repo de GitHub).
- **Backend:** Cloudflare Worker (`worker/index.js`).
- **Base de datos:** Cloudflare D1 (`schema.sql`).

## Acceso
- **Profe:** se registra solo con email + contraseña (abierto).
  Recibe un código de invitación para sus alumnos.
- **Alumno:** se registra con email + contraseña entrando por el
  link de invitación de su profe (queda vinculado a él).
- **Sesión persistente:** al registrarse/loguearse el celu guarda un
  token; no vuelve a pedir login hasta que borren la app.
- **Contraseñas hasheadas** (PBKDF2). Nunca en texto plano.

## Setup del backend (una vez)

```bash
# 1. Instalar wrangler (CLI de Cloudflare)
npm install -g wrangler
wrangler login

# 2. Crear la base D1 y pegar el database_id en wrangler.toml
wrangler d1 create tuprofe-db

# 3. Cargar el esquema (¡con --remote!)
wrangler d1 execute tuprofe-db --file=schema.sql --remote

# 4. Deployar el Worker
wrangler deploy
```

No hace falta ningún secret.

## Probar rápido (con curl)

```bash
# Registrar un profe
curl -X POST https://TU-WORKER.workers.dev/registro/profe \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Francisco Diberti","email":"fran@mail.com","password":"claveSegura1"}'
# -> te devuelve { token, rol:"profe", codigo_invitacion:"INV-XXXX" }

# Registrar un alumno usando ese codigo_invitacion
curl -X POST https://TU-WORKER.workers.dev/registro/alumno \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Juan Crespi","email":"juan@mail.com","password":"otraClave1","codigo_invitacion":"INV-XXXX"}'

# Login
curl -X POST https://TU-WORKER.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{"email":"fran@mail.com","password":"claveSegura1"}'
```

## Estructura

```
tuprofe/
├── README.md
├── schema.sql          # todas las tablas de D1
├── wrangler.toml       # config Cloudflare + binding a D1
└── worker/
    └── index.js        # la API: registro, login, sesiones, endpoints
```

## Qué falta (próximos pasos)
1. Endpoints CRUD de rutina: días, bloques, ejercicios, cargas.
2. Frontend PWA con las vistas (profe / alumno), registro por link
   de invitación y onboarding de instalación en móvil.
3. Dashboard del home (últimos 7 días + calendario de asistencia).
