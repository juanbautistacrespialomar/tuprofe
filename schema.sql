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

DROP TABLE IF EXISTS evaluaciones;
DROP TABLE IF EXISTS plantilla_ejercicios;
DROP TABLE IF EXISTS plantilla_bloques;
DROP TABLE IF EXISTS plantillas;
DROP TABLE IF EXISTS pedidos_reset;
DROP TABLE IF EXISTS invitaciones;
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
  habilitado         INTEGER NOT NULL DEFAULT 0,  -- 0 = deshabilitado (arranca en pausa hasta que el admin lo active)
  es_admin           INTEGER NOT NULL DEFAULT 0,  -- 1 = creador/administrador de la plataforma
  borrado            INTEGER NOT NULL DEFAULT 0,  -- 1 = borrado (soft delete): oculto y sin acceso, datos preservados
  debe_cambiar       INTEGER NOT NULL DEFAULT 0,  -- 1 = clave temporal (reseteo): obliga a elegir una propia
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
  foto           TEXT,  -- data URL (base64) de la foto de perfil, comprimida en el cliente
  objetivo       TEXT CHECK (objetivo IN (
                    'Fuerza máxima', 'Hipertrofia', 'Recomposición corporal',
                    'Rendimiento deportivo', 'Otro'
                 )),
  observaciones  TEXT,
  debe_cambiar   INTEGER NOT NULL DEFAULT 0,  -- 1 = clave temporal (reseteo): obliga a elegir una propia
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
-- INVITACIONES  (de un solo uso: un link por alumno)
-- ------------------------------------------------------------
CREATE TABLE invitaciones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id   INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  codigo     TEXT UNIQUE NOT NULL,
  usada      INTEGER NOT NULL DEFAULT 0,
  alumno_id  INTEGER,
  nota       TEXT,
  creada     TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- PEDIDOS DE RESETEO  ("olvidé mi contraseña": uno pendiente por persona)
-- ------------------------------------------------------------
CREATE TABLE pedidos_reset (
  rol         TEXT NOT NULL,
  usuario_id  INTEGER NOT NULL,
  creado      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (rol, usuario_id)
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
  orden      INTEGER NOT NULL DEFAULT 0,
  fecha      TEXT              -- fecha asignada por el profe (YYYY-MM-DD), opcional
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
CREATE INDEX idx_invitaciones_profe ON invitaciones(profe_id);
CREATE INDEX idx_catalogo_profe   ON catalogo_ejercicios(profe_id);
CREATE INDEX idx_dias_alumno      ON dias(alumno_id);
CREATE INDEX idx_bloques_dia      ON bloques(dia_id);
CREATE INDEX idx_ejercicios_bloq  ON ejercicios(bloque_id);
CREATE INDEX idx_ejercicios_cat   ON ejercicios(catalogo_id);
CREATE INDEX idx_cargas_alumno    ON cargas(alumno_id);
CREATE INDEX idx_cargas_ejercicio ON cargas(ejercicio_id);

-- ------------------------------------------------------------
-- PLANTILLAS (planificaciones generales del profe)
--   Viven aparte de las rutinas de los alumnos. Asignar una plantilla
--   a un alumno crea una COPIA en su rutina: editar esa copia no toca
--   la plantilla, y editar la plantilla no toca lo ya asignado.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plantillas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id    INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  etiqueta    TEXT,                          -- "Fuerza", "Hipertrofia"... (libre, para filtrar)
  notas       TEXT,                          -- descripción interna del profe
  usos        INTEGER NOT NULL DEFAULT 0,    -- cuántas veces se asignó
  creado      TEXT DEFAULT (datetime('now')),
  actualizado TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plantilla_bloques (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plantilla_id  INTEGER NOT NULL REFERENCES plantillas(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  orden         INTEGER NOT NULL DEFAULT 0,
  pausa         TEXT
);

-- La prescripción de cada ejercicio se guarda como JSON en `datos`
-- ({ series_plan, registrar_carga, notas }): es EXACTAMENTE lo mismo que
-- el editor le manda a POST /ejercicios. Así, al asignar, el worker
-- crea el ejercicio del alumno con el mismo código que usa siempre.
CREATE TABLE IF NOT EXISTS plantilla_ejercicios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bloque_id    INTEGER NOT NULL REFERENCES plantilla_bloques(id) ON DELETE CASCADE,
  catalogo_id  INTEGER NOT NULL REFERENCES catalogo_ejercicios(id) ON DELETE CASCADE,
  orden        INTEGER NOT NULL DEFAULT 0,
  datos        TEXT
);

CREATE INDEX IF NOT EXISTS idx_plantillas_profe   ON plantillas(profe_id);
CREATE INDEX IF NOT EXISTS idx_plbloques_plant    ON plantilla_bloques(plantilla_id);
CREATE INDEX IF NOT EXISTS idx_plejercicios_bloq  ON plantilla_ejercicios(bloque_id);
CREATE INDEX IF NOT EXISTS idx_plejercicios_cat   ON plantilla_ejercicios(catalogo_id);

-- ------------------------------------------------------------
-- EVALUACIONES (tests físicos)
--   Ciclo: pendiente (el profe la pidió) -> realizada (el alumno cargó)
--          -> revisada (el profe dio su devolución).
--   El profe también puede cargarla directo como realizada/revisada
--   (cuando la toma él en persona).
--   `resultado` es JSON y depende del tipo de test (ver worker).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evaluaciones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id         INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  alumno_id        INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  tipo             TEXT NOT NULL,             -- ohs | unipodal | rm | cmj | abalakov | sj | vbt
  estado           TEXT NOT NULL DEFAULT 'pendiente',
  instrucciones    TEXT,                      -- lo que el profe le explica al alumno
  video_id         TEXT,                      -- video de YouTube del profe (ID de 11 chars)
  catalogo_id      INTEGER,                   -- ejercicio evaluado (RM / VBT), opcional
  fecha_limite     TEXT,                      -- YYYY-MM-DD, opcional
  fecha_realizada  TEXT,                      -- YYYY-MM-DD
  peso_corporal    REAL,                      -- kg, opcional (fuerza relativa, potencia)
  resultado        TEXT,                      -- JSON según el tipo
  video_alumno     TEXT,                      -- link que pega el alumno (YouTube/Drive/etc.)
  comentario       TEXT,                      -- comentario del alumno
  devolucion       TEXT,                      -- devolución del profe
  creado           TEXT DEFAULT (datetime('now')),
  actualizado      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_alumno ON evaluaciones(alumno_id, estado);
CREATE INDEX IF NOT EXISTS idx_eval_profe  ON evaluaciones(profe_id, estado);
