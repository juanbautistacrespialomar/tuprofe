-- ============================================================
--  tuprofe · Esquema de la base de datos (Cloudflare D1 / SQLite)
-- ============================================================
--  Jerarquía:  Profe -> Alumno -> Día -> Bloque -> Ejercicio -> Cargas
--
--  Acceso (NUEVO modelo):
--    - Profe:  se registra solo con email + contraseña. Registro abierto.
--    - Alumno: se registra con email + contraseña, pero entrando por el
--              LINK DE INVITACIÓN de su profe (así queda vinculado a él).
--    - Login persistente: al registrarse/loguearse se crea una SESIÓN
--              (un token) que el celu guarda. No vuelve a pedir login
--              hasta que borren la app.
--    - Las contraseñas se guardan HASHEADAS (nunca en texto plano).
-- ============================================================

DROP TABLE IF EXISTS sesiones;
DROP TABLE IF EXISTS cargas;
DROP TABLE IF EXISTS ejercicios;
DROP TABLE IF EXISTS bloques;
DROP TABLE IF EXISTS dias;
DROP TABLE IF EXISTS alumnos;
DROP TABLE IF EXISTS profesores;

-- ------------------------------------------------------------
-- PROFESORES
-- ------------------------------------------------------------
CREATE TABLE profesores (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre             TEXT NOT NULL,
  email              TEXT UNIQUE NOT NULL,
  password_hash      TEXT NOT NULL,             -- hash PBKDF2 (hex)
  password_salt      TEXT NOT NULL,             -- salt único por usuario (hex)
  codigo_invitacion  TEXT UNIQUE NOT NULL,      -- "INV-X7K2", va en el link para sus alumnos
  creado             TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- ALUMNOS  (cada uno pertenece a un profe)
-- ------------------------------------------------------------
CREATE TABLE alumnos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id       INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  nombre         TEXT NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  fecha_nac      TEXT,
  objetivo       TEXT CHECK (objetivo IN (
                    'Fuerza máxima',
                    'Hipertrofia',
                    'Recomposición corporal',
                    'Rendimiento deportivo',
                    'Otro'
                 )),
  observaciones  TEXT,
  creado         TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- SESIONES  (login persistente: un token por dispositivo logueado)
-- ------------------------------------------------------------
CREATE TABLE sesiones (
  token       TEXT PRIMARY KEY,                 -- string aleatorio, lo guarda el celu
  rol         TEXT NOT NULL,                    -- 'profe' | 'alumno'
  usuario_id  INTEGER NOT NULL,                 -- id del profe o del alumno
  creado      TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- DÍAS
-- ------------------------------------------------------------
CREATE TABLE dias (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id  INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  nombre     TEXT NOT NULL,
  orden      INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- BLOQUES
-- ------------------------------------------------------------
CREATE TABLE bloques (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  dia_id   INTEGER NOT NULL REFERENCES dias(id) ON DELETE CASCADE,
  nombre   TEXT NOT NULL,
  orden    INTEGER NOT NULL DEFAULT 0,
  pausa    TEXT
);

-- ------------------------------------------------------------
-- EJERCICIOS  (series simple: un reps y una pausa por ejercicio)
-- ------------------------------------------------------------
CREATE TABLE ejercicios (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bloque_id  INTEGER NOT NULL REFERENCES bloques(id) ON DELETE CASCADE,
  orden      INTEGER NOT NULL DEFAULT 0,
  nombre     TEXT NOT NULL,
  material   TEXT,
  series     INTEGER,
  reps       TEXT,
  pausa      TEXT,
  notas      TEXT,
  video_id   TEXT
);

-- ------------------------------------------------------------
-- CARGAS  (las registra el alumno; el profe las lee)
-- ------------------------------------------------------------
CREATE TABLE cargas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ejercicio_id  INTEGER NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
  alumno_id     INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  fecha         TEXT DEFAULT (datetime('now')),
  peso          REAL,
  reps_hechas   TEXT,
  completado    INTEGER NOT NULL DEFAULT 0,
  notas         TEXT
);

-- ------------------------------------------------------------
-- ÍNDICES
-- ------------------------------------------------------------
CREATE INDEX idx_alumnos_profe    ON alumnos(profe_id);
CREATE INDEX idx_sesiones_usuario ON sesiones(rol, usuario_id);
CREATE INDEX idx_dias_alumno      ON dias(alumno_id);
CREATE INDEX idx_bloques_dia      ON bloques(dia_id);
CREATE INDEX idx_ejercicios_bloq  ON ejercicios(bloque_id);
CREATE INDEX idx_cargas_alumno    ON cargas(alumno_id);
CREATE INDEX idx_cargas_ejercicio ON cargas(ejercicio_id);
