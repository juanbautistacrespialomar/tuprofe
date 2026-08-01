-- ============================================================
--  COACH APP · Esquema de la base de datos (Cloudflare D1 / SQLite)
-- ============================================================
--  Jerarquía:  Profe -> Alumno -> Día -> Bloque -> Ejercicio -> Cargas
--
--  Roles y acceso:
--    - ADMIN  = un código guardado como variable secreta en el Worker
--               (NO vive en la base). Con él se crean profes.
--    - PROFE  = fila en la tabla `profesores`, código PROF-xxxx
--    - ALUMNO = fila en la tabla `alumnos`,     código ALU-xxxx
--
--  Multi-tenant: cada profe solo ve SUS alumnos (filtro por profe_id).
-- ============================================================

-- Para poder correr este script varias veces sin romper nada durante
-- el desarrollo, borramos y recreamos. OJO: en producción no querés esto.
DROP TABLE IF EXISTS cargas;
DROP TABLE IF EXISTS ejercicios;
DROP TABLE IF EXISTS bloques;
DROP TABLE IF EXISTS dias;
DROP TABLE IF EXISTS alumnos;
DROP TABLE IF EXISTS profesores;

-- ------------------------------------------------------------
-- PROFESORES  (los "inquilinos" de la plataforma)
-- ------------------------------------------------------------
CREATE TABLE profesores (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT NOT NULL,
  codigo_acceso  TEXT UNIQUE NOT NULL,          -- "PROF-X7K2", con esto entra el profe
  creado         TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- ALUMNOS  (cada uno pertenece a un profe)
-- ------------------------------------------------------------
CREATE TABLE alumnos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id       INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  nombre         TEXT NOT NULL,
  codigo_acceso  TEXT UNIQUE NOT NULL,          -- "ALU-9F3M", el profe se lo pasa
  fecha_nac      TEXT,                           -- ISO 'YYYY-MM-DD'
  objetivo       TEXT CHECK (objetivo IN (
                    'Fuerza máxima',
                    'Hipertrofia',
                    'Recomposición corporal',
                    'Rendimiento deportivo',
                    'Otro'
                 )),
  observaciones  TEXT,                           -- lesiones, condiciones para el profe
  creado         TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- DÍAS  (Día 1, Día 2... de la rutina de un alumno)
-- ------------------------------------------------------------
CREATE TABLE dias (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id  INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  nombre     TEXT NOT NULL,                      -- "Día 1 - Tren superior"
  orden      INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- BLOQUES  (agrupan ejercicios dentro de un día: entrada en calor,
--           core, fuerza, accesorios...)
-- ------------------------------------------------------------
CREATE TABLE bloques (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  dia_id   INTEGER NOT NULL REFERENCES dias(id) ON DELETE CASCADE,
  nombre   TEXT NOT NULL,                        -- "Fuerza MMSS - Tracción horizontal"
  orden    INTEGER NOT NULL DEFAULT 0,
  pausa    TEXT                                  -- pausa a nivel bloque, ej "2'"
);

-- ------------------------------------------------------------
-- EJERCICIOS  (modelo de series SIMPLE: un reps y una pausa por ejercicio)
-- ------------------------------------------------------------
CREATE TABLE ejercicios (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bloque_id  INTEGER NOT NULL REFERENCES bloques(id) ON DELETE CASCADE,
  orden      INTEGER NOT NULL DEFAULT 0,
  nombre     TEXT NOT NULL,                      -- "Press banca"
  material   TEXT,                               -- "Banda Elástica", "Cajón", "Peso corporal"
  series     INTEGER,                            -- cantidad de series (3, 4...)
  reps       TEXT,                               -- "6 x lado", "8-12", "al fallo"
  pausa      TEXT,                               -- "90s", "—"
  notas      TEXT,
  video_id   TEXT                                -- solo el ID de YouTube (11 chars)
);

-- ------------------------------------------------------------
-- CARGAS  (lo que registra el ALUMNO; el profe lo lee. Bidireccional)
-- ------------------------------------------------------------
CREATE TABLE cargas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ejercicio_id  INTEGER NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
  alumno_id     INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  fecha         TEXT DEFAULT (datetime('now')),
  peso          REAL,                            -- kg
  reps_hechas   TEXT,                            -- lo que efectivamente hizo
  completado    INTEGER NOT NULL DEFAULT 0,      -- 0/1
  notas         TEXT
);

-- ------------------------------------------------------------
-- ÍNDICES  (para que las consultas más frecuentes vuelen)
-- ------------------------------------------------------------
CREATE INDEX idx_alumnos_profe    ON alumnos(profe_id);
CREATE INDEX idx_dias_alumno      ON dias(alumno_id);
CREATE INDEX idx_bloques_dia      ON bloques(dia_id);
CREATE INDEX idx_ejercicios_bloq  ON ejercicios(bloque_id);
CREATE INDEX idx_cargas_alumno    ON cargas(alumno_id);
CREATE INDEX idx_cargas_ejercicio ON cargas(ejercicio_id);

-- ------------------------------------------------------------
-- SEED opcional para probar: un profe de ejemplo
-- (el código admin lo definís como secret en el Worker, no acá)
-- ------------------------------------------------------------
INSERT INTO profesores (nombre, codigo_acceso) VALUES ('Francisco Diberti', 'PROF-DEMO1');
