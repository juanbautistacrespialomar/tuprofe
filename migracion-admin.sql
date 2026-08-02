-- ============================================================
--  Migración: panel de administrador (creador de la plataforma)
--  Correr UNA sola vez, ANTES de deployar el worker nuevo:
--    wrangler d1 execute tuprofe-db --file=migracion-admin.sql --remote
-- ============================================================

-- 1) Cada profe puede estar habilitado (1) o deshabilitado (0).
--    DEFAULT 0 = TODOS arrancan deshabilitados (los que ya existen y los nuevos).
--    Vos los vas habilitando desde el panel. Tu propia cuenta se re-habilita
--    en el paso 3, así que no te vas a quedar afuera.
ALTER TABLE profesores ADD COLUMN habilitado INTEGER NOT NULL DEFAULT 0;

-- 2) es_admin marca al creador de la plataforma (vos). Solo un admin puede
--    ver el panel y habilitar/deshabilitar profes.
ALTER TABLE profesores ADD COLUMN es_admin INTEGER NOT NULL DEFAULT 0;

-- 3) Te marca admin Y te re-habilita. lower() evita problemas de mayúsculas
--    si te registraste con el mail en otro formato.
UPDATE profesores SET es_admin = 1, habilitado = 1
WHERE lower(email) = 'juanbautistacrespi@hotmail.com';
