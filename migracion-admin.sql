-- ============================================================
--  Migración: panel de administrador (creador de la plataforma)
--  Correr UNA sola vez, ANTES de deployar el worker nuevo:
--    wrangler d1 execute tuprofe-db --file=migracion-admin.sql --remote
-- ============================================================

-- 1) Cada profe puede estar habilitado (1) o deshabilitado (0).
--    Los profes existentes quedan habilitados por defecto, así no se rompe nada.
--    El día que quieras cobrar suscripción, podés cambiar el default a 0 para que
--    los nuevos profes entren deshabilitados hasta que vos los actives.
ALTER TABLE profesores ADD COLUMN habilitado INTEGER NOT NULL DEFAULT 1;

-- 2) es_admin marca al creador de la plataforma (vos). Solo un admin puede
--    ver el panel y habilitar/deshabilitar profes.
ALTER TABLE profesores ADD COLUMN es_admin INTEGER NOT NULL DEFAULT 0;

-- 3) IMPORTANTE: marcate como admin. Reemplazá el email por el tuyo (el de tu
--    cuenta de profe) y corré esta línea (podés incluirla en el mismo archivo).
-- UPDATE profesores SET es_admin = 1, habilitado = 1 WHERE email = 'TU_EMAIL_ACA';
