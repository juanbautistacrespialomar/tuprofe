-- ============================================================
--  Migración: PLANIFICACIONES (plantillas generales) + EVALUACIONES
--  ------------------------------------------------------------
--  100% ADITIVA: solo crea tablas e índices NUEVOS.
--  No hace ALTER, UPDATE, DELETE ni DROP sobre nada existente,
--  así que no toca ni una fila de profes, alumnos, rutinas o cargas.
--
--  Es RE-EJECUTABLE: todo es "IF NOT EXISTS". Si la corrés dos
--  veces no pasa nada.
--
--  Comando:
--    npx wrangler d1 execute tuprofe-db --file=migracion-planificaciones-evaluaciones.sql --remote
--
--  Sobre los ON DELETE CASCADE: son a propósito. Si un profe borra
--  un alumno, sus evaluaciones se van con él (igual que su rutina).
--  Sin el CASCADE, D1 BLOQUEARÍA el borrado del alumno.
-- ============================================================

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
