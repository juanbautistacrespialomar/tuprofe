-- ============================================================
--  Migración: foto de perfil del alumno
--  Correr UNA sola vez, ANTES de deployar el worker nuevo:
--    wrangler d1 execute tuprofe-db --file=migracion-foto.sql --remote
-- ============================================================

-- La foto se guarda como data URL (base64) ya comprimida en el celu a ~256px,
-- así pesa poco (~15-25 KB). Suficiente para pocos usuarios sin necesitar R2.
ALTER TABLE alumnos ADD COLUMN foto TEXT;
