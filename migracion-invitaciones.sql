-- ============================================================
--  Migración: invitaciones de un solo uso
--  Agrega la tabla `invitaciones` SIN borrar nada de lo existente.
--  Correr una sola vez con:
--    wrangler d1 execute tuprofe-db --file=migracion-invitaciones.sql --remote
-- ============================================================

CREATE TABLE IF NOT EXISTS invitaciones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profe_id   INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  codigo     TEXT UNIQUE NOT NULL,          -- el que viaja en el link
  usada      INTEGER NOT NULL DEFAULT 0,    -- 0 = pendiente, 1 = ya se usó
  alumno_id  INTEGER,                        -- quién la usó
  nota       TEXT,                           -- nombre tentativo, para acordarte
  creada     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invitaciones_profe ON invitaciones(profe_id);
