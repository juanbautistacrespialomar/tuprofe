-- ============================================================
--  Migración: borrado lógico de profesores (soft delete)
--  Correr UNA sola vez, ANTES de deployar el worker nuevo:
--    wrangler d1 execute tuprofe-db --file=migracion-borrado-profes.sql --remote
-- ============================================================

-- borrado = 1 => el profe fue borrado por el admin. Se oculta de la lista y
-- queda sin acceso, pero sus datos (alumnos, rutinas) NO se destruyen.
-- Es reversible: para recuperarlo, poner borrado=0 y habilitado=1.
ALTER TABLE profesores ADD COLUMN borrado INTEGER NOT NULL DEFAULT 0;
