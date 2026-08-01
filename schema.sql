-- ============================================================
--  tuprofe · Esquema de la base de datos (Cloudflare D1 / SQLite)
-- ============================================================
--  Jerarquía de la rutina:
--    Profe -> Alumno -> Día -> Bloque -> Ejercicio(asignado) -> Cargas
--
--  Biblioteca:
--    Cada profe tiene su CATÁLOGO de ejercicios (nombre + video +
--    material), cargado una sola vez. Al armar la rutina, el profe
--    ELIGE del catálogo y solo define series/reps/pausa para ese alumno.
--
--  Acceso: email + contraseña hasheada, invitación por código,
--          sesión persistente por token.
-- ============================================================

DROP TABLE IF EXISTS sesiones;
DROP TABLE IF EXISTS cargas;
DROP TABLE IF EXISTS ejercicios;
DROP TABLE IF EXISTS catalogo_ejercicios;
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
  password_hash      TEXT NOT NULL,
  password_salt      TEXT NOT NULL,
  codigo_invitacion  TEXT UNIQUE NOT NULL,
  creado             TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- ALUMNOS
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
                    'Fuerza máxima', 'Hipertrofia', 'Recomposición corporal',
                    'Rendimiento deportivo', 'Otro'
                 )),
  observaciones  TEXT,
  creado         TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- SESIONES
-- ------------------------------------------------------------
CREATE TABLE sesiones (
  token       TEXT PRIMARY KEY,
  rol         TEXT NOT NULL,
  usuario_id  INTEGER NOT NULL,
  creado      TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- CATÁLOGO DE EJERCICIOS  (la biblioteca del profe)
--   Se carga una vez. El video vive acá, no en cada rutina.
-- ------------------------------------------------------------
CREATE TABLE catalogo_ejercicios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id     INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,               -- "Movilidad torax con banda"
  material     TEXT,                         -- "Banda Elástica"
  video_id     TEXT,                         -- solo el ID de YouTube (11 chars)
  descripcion  TEXT,
  creado       TEXT DEFAULT (datetime('now'))
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
-- EJERCICIOS  (ASIGNACIÓN: apunta a un ejercicio del catálogo y
--              solo guarda lo que cambia por alumno)
-- ------------------------------------------------------------
CREATE TABLE ejercicios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bloque_id    INTEGER NOT NULL REFERENCES bloques(id) ON DELETE CASCADE,
  catalogo_id  INTEGER NOT NULL REFERENCES catalogo_ejercicios(id) ON DELETE CASCADE,
  orden        INTEGER NOT NULL DEFAULT 0,
  series       INTEGER,
  reps         TEXT,
  pausa        TEXT,
  notas        TEXT                           -- nota puntual para este alumno
);

-- ------------------------------------------------------------
-- CARGAS
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
CREATE INDEX idx_catalogo_profe   ON catalogo_ejercicios(profe_id);
CREATE INDEX idx_dias_alumno      ON dias(alumno_id);
CREATE INDEX idx_bloques_dia      ON bloques(dia_id);
CREATE INDEX idx_ejercicios_bloq  ON ejercicios(bloque_id);
CREATE INDEX idx_ejercicios_cat   ON ejercicios(catalogo_id);
CREATE INDEX idx_cargas_alumno    ON cargas(alumno_id);
CREATE INDEX idx_cargas_ejercicio ON cargas(ejercicio_id);
