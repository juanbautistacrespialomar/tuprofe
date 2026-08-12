-- ============================================================
--  Migración: SERIES POR SERIE (prescripción + carga)
--  ------------------------------------------------------------
--  Suma dos cosas SIN borrar nada de lo que ya tenés:
--    1) Tabla `series_plan`: las reps/pausa PLANIFICADAS por cada
--       serie de un ejercicio (antes eran un único valor para todas).
--    2) Columna `serie` en `cargas`: para registrar el peso (kg)
--       POR SERIE (antes era un único peso por ejercicio).
--
--  Es ADITIVA y compatible hacia atrás: el worker está escrito para
--  andar con o sin esta migración. Si todavía no la corrés, la app
--  sigue funcionando en modo viejo (una carga por ejercicio).
--
--  ⚠️  Correr UNA SOLA VEZ. El bloque de `series_plan` es re-ejecutable
--     (no duplica), pero el `ALTER TABLE cargas ADD COLUMN serie` falla
--     si ya existe: eso significa que ya estaba aplicada, no es grave.
--
--  Comando (ver el instructivo que te pasé aparte):
--     npx wrangler d1 execute tuprofe-db --file=migracion-series.sql --remote
-- ============================================================

-- 1) Prescripción por serie -----------------------------------
CREATE TABLE IF NOT EXISTS series_plan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ejercicio_id  INTEGER NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
  numero        INTEGER NOT NULL,   -- 1, 2, 3, 4...
  reps          TEXT,
  pausa         TEXT
);
CREATE INDEX IF NOT EXISTS idx_series_plan_ej ON series_plan(ejercicio_id);

-- 2) Rellenar series_plan desde los ejercicios que YA existen.
--    Por cada ejercicio genera N filas (N = su cantidad de series, o 1
--    si no tiene), copiando las reps/pausa actuales a todas las series.
--    El WHERE NOT EXISTS lo hace re-ejecutable: si ya hay datos, no toca nada.
INSERT INTO series_plan (ejercicio_id, numero, reps, pausa)
WITH RECURSIVE seq(ejercicio_id, n, maxn, reps, pausa) AS (
  SELECT id, 1, COALESCE(NULLIF(series, 0), 1), reps, pausa FROM ejercicios
  UNION ALL
  SELECT ejercicio_id, n + 1, maxn, reps, pausa FROM seq WHERE n < maxn
)
SELECT ejercicio_id, n, reps, pausa FROM seq
WHERE NOT EXISTS (SELECT 1 FROM series_plan);

-- 3) Carga por serie ------------------------------------------
--    Las cargas viejas quedan con serie = NULL (se interpretan como
--    "carga única/global" del ejercicio, sin romper el historial).
ALTER TABLE cargas ADD COLUMN serie INTEGER;
