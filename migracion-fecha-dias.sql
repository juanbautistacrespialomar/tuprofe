-- ============================================================
--  Migración: fecha del día
--  Agrega la columna `fecha` a la tabla `dias` SIN borrar nada.
--  Permite que el profe le asigne una fecha a cada día y que
--  el alumno vea su rutina tipo calendario.
--
--  ⚠️  Correr UNA SOLA VEZ (ADD COLUMN falla si ya existe):
--    wrangler d1 execute tuprofe-db --file=migracion-fecha-dias.sql --remote
--
--  El worker está escrito para funcionar con o sin esta columna,
--  así que si todavía no la corriste la app no se rompe: simplemente
--  las fechas no se guardan hasta que la ejecutes.
-- ============================================================

ALTER TABLE dias ADD COLUMN fecha TEXT;
