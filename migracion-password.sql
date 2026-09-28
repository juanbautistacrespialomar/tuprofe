-- ============================================================
--  Migración: cambio de contraseña + "olvidé mi contraseña"
--  Correr UNA sola vez, ANTES de deployar el worker nuevo:
--    wrangler d1 execute tuprofe-db --file=migracion-password.sql --remote
-- ============================================================

-- debe_cambiar = 1 => la clave es temporal (la generó un reseteo). Al entrar,
-- la app obliga a elegir una propia. Se apaga sola al cambiarla.
ALTER TABLE profesores ADD COLUMN debe_cambiar INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alumnos    ADD COLUMN debe_cambiar INTEGER NOT NULL DEFAULT 0;

-- Pedidos de "olvidé mi contraseña". Uno pendiente por persona (PK compuesta):
-- se borra cuando el admin/profe resetea o cuando el usuario cambia la clave.
CREATE TABLE IF NOT EXISTS pedidos_reset (
  rol         TEXT NOT NULL,              -- 'profe' | 'alumno'
  usuario_id  INTEGER NOT NULL,
  creado      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (rol, usuario_id)
);
