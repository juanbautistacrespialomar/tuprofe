// ============================================================
//  tuprofe · Worker (la API que corre en Cloudflare)
// ============================================================
//  Acceso: email + contraseña hasheada, invitación por código,
//  sesión persistente por token.
//
//  Biblioteca: cada profe tiene su CATÁLOGO de ejercicios (con video).
//  Al armar la rutina elige del catálogo y solo define series/reps.
//
//  Toda escritura verifica que el recurso pertenezca a quien lo toca.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ------------------------------------------------------------
//  Seguridad
// ------------------------------------------------------------
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256);
  return { hash: bufToHex(bits), salt: bufToHex(salt) };
}
async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === hashHex;
}
function genToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}
function genCodigo(prefijo) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return `${prefijo}-${s}`;
}
function genClaveTemp() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");

// Del link/URL de YouTube saca solo el ID de 11 caracteres.
function extraerVideoId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  const m = input.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function emailEnUso(email, env) {
  const p = await env.DB.prepare("SELECT 1 FROM profesores WHERE email = ?").bind(email).first();
  if (p) return true;
  const a = await env.DB.prepare("SELECT 1 FROM alumnos WHERE email = ?").bind(email).first();
  return !!a;
}
async function crearSesion(rol, usuarioId, env) {
  const token = genToken();
  await env.DB.prepare("INSERT INTO sesiones (token, rol, usuario_id) VALUES (?, ?, ?)")
    .bind(token, rol, usuarioId).run();
  return token;
}
async function resolverSesion(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const s = await env.DB.prepare("SELECT rol, usuario_id FROM sesiones WHERE token = ?")
    .bind(token).first();
  return s ? { rol: s.rol, id: s.usuario_id } : null;
}

// ------------------------------------------------------------
//  LOGIN CON GOOGLE
// ------------------------------------------------------------
//  El front (botón de Google) nos manda un "ID token" firmado por Google.
//  Lo verificamos acá mismo con las claves públicas de Google (RS256):
//  firma, emisor, audiencia (nuestro client ID), vencimiento y mail verificado.
//  Si todo da, el mail de Google es tan confiable como una contraseña.
const GOOGLE_CLIENT_ID = "470393235359-fmaqhamksf7o30b3kgv7rcq2d7bjclqf.apps.googleusercontent.com";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";

function b64urlABytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlAJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlABytes(s)));

// Devuelve los datos del usuario ({ email, nombre }) o tira un error con mensaje para mostrar.
async function verificarTokenGoogle(credential, env) {
  const partes = String(credential || "").split(".");
  if (partes.length !== 3) throw new Error("Credencial de Google inválida");
  let header, payload;
  try { header = b64urlAJSON(partes[0]); payload = b64urlAJSON(partes[1]); }
  catch { throw new Error("Credencial de Google inválida"); }
  if (header.alg !== "RS256" || !header.kid) throw new Error("Credencial de Google inválida");

  // Claves públicas de Google (Cloudflare las cachea una hora).
  const resp = await fetch(GOOGLE_CERTS, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!resp.ok) throw new Error("No pudimos validar con Google. Probá de nuevo.");
  const { keys } = await resp.json();
  const jwk = (keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Credencial de Google vencida. Probá de nuevo.");
  const clave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valida = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", clave, b64urlABytes(partes[2]),
    new TextEncoder().encode(partes[0] + "." + partes[1]));
  if (!valida) throw new Error("Credencial de Google inválida");

  const clientId = (env && env.GOOGLE_CLIENT_ID) || GOOGLE_CLIENT_ID;
  const ahora = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId) throw new Error("Credencial de Google inválida");
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") throw new Error("Credencial de Google inválida");
  if (!payload.exp || payload.exp < ahora - 60) throw new Error("La sesión de Google venció. Probá de nuevo.");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("Tu mail de Google no está verificado");
  const email = String(payload.email || "").trim().toLowerCase();
  if (!emailOk(email)) throw new Error("Google no nos pasó un mail válido");
  return { email, nombre: String(payload.name || payload.given_name || email.split("@")[0]).slice(0, 80) };
}

// ------------------------------------------------------------
//  Verificaciones de propiedad
// ------------------------------------------------------------
async function alumnoEsDelProfe(id, profeId, env) {
  return !!(await env.DB.prepare("SELECT 1 FROM alumnos WHERE id = ? AND profe_id = ?")
    .bind(id, profeId).first());
}
async function catalogoEsDelProfe(id, profeId, env) {
  return !!(await env.DB.prepare("SELECT 1 FROM catalogo_ejercicios WHERE id = ? AND profe_id = ?")
    .bind(id, profeId).first());
}
async function diaEsDelProfe(id, profeId, env) {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM dias d JOIN alumnos a ON a.id = d.alumno_id WHERE d.id = ? AND a.profe_id = ?`)
    .bind(id, profeId).first());
}
async function bloqueEsDelProfe(id, profeId, env) {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM bloques b JOIN dias d ON d.id = b.dia_id JOIN alumnos a ON a.id = d.alumno_id
     WHERE b.id = ? AND a.profe_id = ?`).bind(id, profeId).first());
}
async function ejercicioEsDelProfe(id, profeId, env) {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM ejercicios e JOIN bloques b ON b.id = e.bloque_id JOIN dias d ON d.id = b.dia_id
     JOIN alumnos a ON a.id = d.alumno_id WHERE e.id = ? AND a.profe_id = ?`).bind(id, profeId).first());
}
async function ejercicioEsDelAlumno(id, alumnoId, env) {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM ejercicios e JOIN bloques b ON b.id = e.bloque_id JOIN dias d ON d.id = b.dia_id
     WHERE e.id = ? AND d.alumno_id = ?`).bind(id, alumnoId).first());
}
async function diaEsDelAlumno(id, alumnoId, env) {
  return !!(await env.DB.prepare("SELECT 1 FROM dias WHERE id = ? AND alumno_id = ?")
    .bind(id, alumnoId).first());
}

// ------------------------------------------------------------
//  ESQUEMA AL DÍA (automático y aditivo)
// ------------------------------------------------------------
//  La app usa columnas que se fueron sumando con el tiempo. En vez de depender de
//  migraciones manuales, la primera vez que arranca cada worker revisa qué columnas
//  existen y AGREGA solo las que faltan (ALTER TABLE ... ADD COLUMN). Nunca borra ni
//  modifica datos. Si otra instancia la agregó al mismo tiempo, el "duplicate column"
//  se ignora.
const COLUMNAS_NECESARIAS = {
  dias:        [["fecha", "TEXT"], ["es_molde", "INTEGER NOT NULL DEFAULT 0"], ["nota_alumno", "TEXT"], ["origen_dia_id", "INTEGER"]],
  ejercicios:  [["registrar_carga", "INTEGER NOT NULL DEFAULT 1"]],
  series_plan: [["peso", "REAL"], ["rpe", "TEXT"]],
  cargas:      [["serie", "INTEGER"], ["rpe", "TEXT"]],
};
let ESQUEMA_OK = false;
async function asegurarEsquema(env) {
  if (ESQUEMA_OK) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS series_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ejercicio_id INTEGER NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
      numero INTEGER NOT NULL, reps TEXT, pausa TEXT)`).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_series_plan_ej ON series_plan(ejercicio_id)").run();
    for (const tabla in COLUMNAS_NECESARIAS) {
      const existentes = new Set((await env.DB.prepare(`PRAGMA table_info(${tabla})`).all()).results.map((c) => c.name));
      for (const [col, tipo] of COLUMNAS_NECESARIAS[tabla]) {
        if (existentes.has(col)) continue;
        try { await env.DB.prepare(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`).run(); }
        catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
      }
    }
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_dias_origen ON dias(origen_dia_id)").run();
    ESQUEMA_OK = true;
  } catch (e) {
    // Si algo falla seguimos igual (las consultas tienen sus propios planes B) y se reintenta en el próximo pedido.
    console.log("asegurarEsquema:", String(e));
  }
}

const redondear05 = (n) => Math.round(n * 2) / 2;

// Rutina anidada: días -> bloques -> ejercicios (con datos del catálogo)
//   incluirMoldes = true  -> trae TODO (para el profe: rutina real + cajón de sesiones)
//   incluirMoldes = false -> excluye los moldes (para el alumno: nunca ve la biblioteca del profe)
//   rango = { desde, hasta } (YYYY-MM-DD, opcional): trae solo los días con fecha en ese
//   rango + los días sin fecha y los moldes (esos vienen siempre). Sin rango, trae todo.
async function armarRutina(alumnoId, env, incluirMoldes = true, rango = null) {
  const conRango = !!(rango && rango.desde && rango.hasta);
  const filtro = conRango ? " AND (d.fecha IS NULL OR (d.fecha >= ? AND d.fecha <= ?))" : "";
  const args = conRango ? [alumnoId, rango.desde, rango.hasta] : [alumnoId];
  const qDias = `SELECT d.id, d.nombre, d.orden, d.fecha, d.es_molde, d.nota_alumno, d.origen_dia_id FROM dias d
     WHERE d.alumno_id = ?${filtro} ORDER BY (d.fecha IS NULL), d.fecha, d.orden`;
  const qBloques = `SELECT b.id, b.dia_id, b.nombre, b.orden, b.pausa
     FROM bloques b JOIN dias d ON d.id = b.dia_id
     WHERE d.alumno_id = ?${filtro} ORDER BY b.orden`;
  const qEjercicios = `SELECT e.id, e.bloque_id, e.orden, e.series, e.reps, e.pausa, e.notas, e.catalogo_id, e.registrar_carga,
            c.nombre, c.material, c.video_id
     FROM ejercicios e
     JOIN catalogo_ejercicios c ON c.id = e.catalogo_id
     JOIN bloques b ON b.id = e.bloque_id
     JOIN dias d ON d.id = b.dia_id
     WHERE d.alumno_id = ?${filtro} ORDER BY e.orden`;
  const qSeries = `SELECT sp.ejercicio_id, sp.numero, sp.reps, sp.pausa, sp.peso, sp.rpe
       FROM series_plan sp
       JOIN ejercicios e ON e.id = sp.ejercicio_id
       JOIN bloques b ON b.id = e.bloque_id
       JOIN dias d ON d.id = b.dia_id
       WHERE d.alumno_id = ?${filtro} ORDER BY sp.ejercicio_id, sp.numero`;

  let dias, bloques, ejercicios, spRows;
  try {
    // Las 4 lecturas en un SOLO viaje a la base (batch). Es lo que hace que abrir
    // la rutina sea rápido en vez de sumar 4 idas y vueltas.
    const res = await env.DB.batch([
      env.DB.prepare(qDias).bind(...args),
      env.DB.prepare(qBloques).bind(...args),
      env.DB.prepare(qEjercicios).bind(...args),
      env.DB.prepare(qSeries).bind(...args),
    ]);
    dias = res[0].results; bloques = res[1].results;
    ejercicios = res[2].results; spRows = res[3].results;
  } catch (e) {
    // Fallback (alguna migración no corrió): vamos query por query, degradando sin romper.
    try {
      dias = (await env.DB.prepare(qDias).bind(...args).all()).results;
    } catch (e0) { try {
      dias = (await env.DB.prepare(qDias.replace(", d.origen_dia_id", "")).bind(...args).all()).results;
    } catch (e1) {
      try {
        dias = (await env.DB.prepare("SELECT id, nombre, orden, fecha FROM dias WHERE alumno_id = ? ORDER BY (fecha IS NULL), fecha, orden").bind(alumnoId).all()).results;
      } catch (e2) {
        dias = (await env.DB.prepare("SELECT id, nombre, orden FROM dias WHERE alumno_id = ? ORDER BY orden").bind(alumnoId).all()).results;
        for (const d of dias) d.fecha = null;
      }
      for (const d of dias) d.es_molde = 0;
    } }
    for (const d of dias) if (d.nota_alumno === undefined) d.nota_alumno = null;
    bloques = (await env.DB.prepare(qBloques).bind(...args).all()).results;
    try { ejercicios = (await env.DB.prepare(qEjercicios).bind(...args).all()).results; }
    catch (e4) { ejercicios = (await env.DB.prepare(qEjercicios.replace(", e.registrar_carga", "")).bind(...args).all()).results; }
    try { spRows = (await env.DB.prepare(qSeries).bind(...args).all()).results; }
    catch (e3) {
      try { spRows = (await env.DB.prepare(qSeries.replace(", sp.peso, sp.rpe", "")).bind(...args).all()).results; }
      catch (e5) { spRows = []; }
    }
  }

  // El alumno nunca ve los moldes. Filtramos acá: los bloques/ejercicios se
  // ensamblan por dia_id contra este array ya filtrado, así que los del molde se descartan solos.
  if (!incluirMoldes) dias = dias.filter((d) => !Number(d.es_molde));

  const planPorEj = {};
  for (const r of (spRows || [])) (planPorEj[r.ejercicio_id] = planPorEj[r.ejercicio_id] || []).push({
    numero: r.numero, reps: r.reps, pausa: r.pausa,
    peso: r.peso != null ? r.peso : null, rpe: r.rpe != null ? r.rpe : null,
  });
  for (const e of ejercicios) {
    e.series_plan = planPorEj[e.id] || [];
    e.registrar_carga = e.registrar_carga === 0 ? 0 : 1;   // por defecto se pide carga
  }

  // Tilde "guardado en el cajón": un día real está guardado si existe un molde que salió de él.
  // Los moldes no tienen fecha, así que siempre vienen en la consulta aunque haya rango.
  const origenesConMolde = new Set(dias.filter((d) => Number(d.es_molde) && d.origen_dia_id != null).map((d) => d.origen_dia_id));
  for (const d of dias) {
    if (d.origen_dia_id === undefined) d.origen_dia_id = null;
    d.guardado_cajon = !Number(d.es_molde) && origenesConMolde.has(d.id) ? 1 : 0;
  }

  for (const b of bloques) b.ejercicios = ejercicios.filter((e) => e.bloque_id === b.id);
  for (const d of dias) d.bloques = bloques.filter((b) => b.dia_id === d.id);
  return dias;
}

// Reemplaza la prescripción por serie de un ejercicio. Degrada sin romper
// si la tabla series_plan todavía no existe (migración sin correr).
async function guardarSeriesPlan(env, ejId, plan) {
  if (!Array.isArray(plan)) return false;
  try {
    const numPeso = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(",", ".")); return isNaN(n) ? null : n; };
    const txtRpe = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().slice(0, 10));
    // Borrar + insertar en el MISMO batch (atómico): si algo falla, no queda el ejercicio sin series.
    const conPeso = [env.DB.prepare("DELETE FROM series_plan WHERE ejercicio_id = ?").bind(ejId)].concat(plan.map((s, i) =>
      env.DB.prepare("INSERT INTO series_plan (ejercicio_id, numero, reps, pausa, peso, rpe) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(ejId, s.numero ?? (i + 1), s.reps || null, s.pausa || null, numPeso(s.peso), txtRpe(s.rpe))));
    try { await env.DB.batch(conPeso); }
    catch (e) {
      // Base sin columnas peso/rpe: guardamos al menos reps y pausa (comportamiento anterior).
      await env.DB.batch([env.DB.prepare("DELETE FROM series_plan WHERE ejercicio_id = ?").bind(ejId)].concat(plan.map((s, i) =>
        env.DB.prepare("INSERT INTO series_plan (ejercicio_id, numero, reps, pausa) VALUES (?, ?, ?, ?)")
          .bind(ejId, s.numero ?? (i + 1), s.reps || null, s.pausa || null))));
    }
    return true;
  } catch (e) { return false; }
}

// ============================================================
//  PLANIFICACIONES (plantillas generales) + EVALUACIONES
// ============================================================
//  Todo lo nuevo vive en este bloque y entra al router con UNA línea:
//      const rNueva = await rutasPlanEval(request, env, url, path, method, seg, sesion, esProfe, esAlumno);
//      if (rNueva) return rNueva;
//  Devuelve una Response si la ruta es suya, o null si no (y el router sigue).
//
//  No modifica ninguna tabla existente: lee/escribe las tablas nuevas de
//  migracion-planificaciones-evaluaciones.sql, y al ASIGNAR una plantilla
//  inserta días/bloques/ejercicios del alumno igual que lo haría el editor.
// ============================================================

const TIPOS_EVAL = ["ohs", "unipodal", "rm", "cmj", "abalakov", "sj", "vbt"];
const ESTADOS_EVAL = ["pendiente", "realizada", "revisada"];
const MAX_JSON = 20000;   // tope de tamaño para resultado/datos (texto JSON)

const numONull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
};
const txt = (v, max) => (v === null || v === undefined || String(v).trim() === "") ? null : String(v).trim().slice(0, max || 2000);
const fechaISO = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
function jsonSeguro(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function linkOk(v) {
  const s = txt(v, 500);
  return s && /^https?:\/\/\S+$/i.test(s) ? s : null;
}

// Normaliza la prescripción de un ejercicio de plantilla. Es el MISMO formato que
// el editor le manda a POST /ejercicios: { series_plan, registrar_carga, notas }.
function normalizarDatosEj(body) {
  const plan = Array.isArray(body.series_plan) ? body.series_plan.slice(0, 20) : [];
  return {
    series_plan: plan.map((s, i) => ({
      numero: i + 1,
      reps: txt(s && s.reps, 40),
      pausa: txt(s && s.pausa, 40),
      peso: numONull(s && s.peso),
      rpe: txt(s && s.rpe, 10),
    })),
    registrar_carga: (body.registrar_carga === 0 || body.registrar_carga === false || body.registrar_carga === "0") ? 0 : 1,
    notas: txt(body.notas, 2000),
  };
}

// ---------- Propiedad ----------
async function plantillaEsDelProfe(id, profeId, env) {
  return !!(await env.DB.prepare("SELECT 1 FROM plantillas WHERE id = ? AND profe_id = ?").bind(id, profeId).first());
}
async function plBloqueEsDelProfe(id, profeId, env) {
  const r = await env.DB.prepare(
    `SELECT b.plantilla_id FROM plantilla_bloques b JOIN plantillas p ON p.id = b.plantilla_id
     WHERE b.id = ? AND p.profe_id = ?`).bind(id, profeId).first();
  return r ? r.plantilla_id : null;
}
async function plEjercicioEsDelProfe(id, profeId, env) {
  const r = await env.DB.prepare(
    `SELECT b.plantilla_id FROM plantilla_ejercicios e JOIN plantilla_bloques b ON b.id = e.bloque_id
     JOIN plantillas p ON p.id = b.plantilla_id WHERE e.id = ? AND p.profe_id = ?`).bind(id, profeId).first();
  return r ? r.plantilla_id : null;
}
// Devuelve el Set de catalogo_id (de esa lista) que SÍ son del profe. Consulta por tandas
// porque D1 limita la cantidad de parámetros por consulta.
async function catalogosDelProfe(ids, profeId, env) {
  const uniq = [...new Set(ids.map(Number).filter((n) => n > 0))];
  const ok = new Set();
  for (let i = 0; i < uniq.length; i += 80) {
    const tanda = uniq.slice(i, i + 80);
    const ph = tanda.map(() => "?").join(",");
    const rs = (await env.DB.prepare(
      `SELECT id FROM catalogo_ejercicios WHERE profe_id = ? AND id IN (${ph})`).bind(profeId, ...tanda).all()).results;
    rs.forEach((r) => ok.add(r.id));
  }
  return ok;
}
const tocarPlantilla = (env, id) =>
  env.DB.prepare("UPDATE plantillas SET actualizado = datetime('now') WHERE id = ?").bind(id).run();

// Plantilla completa, con la misma forma que un "día" de la rutina
// (bloques -> ejercicios con nombre/video del catálogo y series_plan),
// así el front la pinta con las mismas funciones.
async function armarPlantilla(id, env) {
  const p = await env.DB.prepare(
    "SELECT id, nombre, etiqueta, notas, usos, creado, actualizado FROM plantillas WHERE id = ?").bind(id).first();
  if (!p) return null;
  const res = await env.DB.batch([
    env.DB.prepare("SELECT id, plantilla_id, nombre, orden, pausa FROM plantilla_bloques WHERE plantilla_id = ? ORDER BY orden, id").bind(id),
    env.DB.prepare(
      `SELECT e.id, e.bloque_id, e.catalogo_id, e.orden, e.datos, c.nombre, c.material, c.video_id
       FROM plantilla_ejercicios e
       JOIN plantilla_bloques b ON b.id = e.bloque_id
       JOIN catalogo_ejercicios c ON c.id = e.catalogo_id
       WHERE b.plantilla_id = ? ORDER BY e.orden, e.id`).bind(id),
  ]);
  const bloques = res[0].results;
  const ejs = res[1].results.map((e) => {
    const d = jsonSeguro(e.datos) || {};
    const plan = Array.isArray(d.series_plan) ? d.series_plan : [];
    return {
      id: e.id, bloque_id: e.bloque_id, catalogo_id: e.catalogo_id, orden: e.orden,
      nombre: e.nombre, material: e.material, video_id: e.video_id,
      series_plan: plan, series: plan.length || null,
      reps: plan[0] ? plan[0].reps : null, pausa: plan[0] ? plan[0].pausa : null,
      registrar_carga: d.registrar_carga === 0 ? 0 : 1, notas: d.notas || null,
    };
  });
  for (const b of bloques) b.ejercicios = ejs.filter((e) => e.bloque_id === b.id);
  p.bloques = bloques;
  return p;
}

// Inserta en lote los ejercicios ya mapeados a sus bloques nuevos, con su series_plan.
//   items: [{ bloque_id, catalogo_id, orden, datos }]
// Prueba primero con todas las columnas modernas (registrar_carga, peso, rpe) y, si la base
// no las tiene, degrada sin romper. Cada batch de D1 es atómico: si una variante falla,
// no queda nada a medias y se prueba la siguiente.
async function insertarEjerciciosRutina(env, items) {
  if (!items.length) return [];
  const conReg = items.map((it) => {
    const d = it.datos, p = d.series_plan || [];
    return env.DB.prepare(
      "INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas, registrar_carga) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(it.bloque_id, it.catalogo_id, it.orden || 0, p.length || null, p[0] ? p[0].reps : null, p[0] ? p[0].pausa : null, d.notas || null, d.registrar_carga === 0 ? 0 : 1);
  });
  let res;
  try { res = await env.DB.batch(conReg); }
  catch (e) {
    res = await env.DB.batch(items.map((it) => {
      const d = it.datos, p = d.series_plan || [];
      return env.DB.prepare(
        "INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(it.bloque_id, it.catalogo_id, it.orden || 0, p.length || null, p[0] ? p[0].reps : null, p[0] ? p[0].pausa : null, d.notas || null);
    }));
  }
  const ids = res.map((r) => r.meta.last_row_id);

  // series_plan de todos los ejercicios en un solo batch (con variantes por columnas).
  const filas = [];
  items.forEach((it, i) => (it.datos.series_plan || []).forEach((s, k) => filas.push({ ej: ids[i], n: s.numero || k + 1, s })));
  if (filas.length) {
    const variantes = [
      ["INSERT INTO series_plan (ejercicio_id, numero, reps, pausa, peso, rpe) VALUES (?, ?, ?, ?, ?, ?)", (f) => [f.ej, f.n, f.s.reps || null, f.s.pausa || null, numONull(f.s.peso), f.s.rpe != null && f.s.rpe !== "" ? String(f.s.rpe) : null]],
      ["INSERT INTO series_plan (ejercicio_id, numero, reps, pausa, peso) VALUES (?, ?, ?, ?, ?)", (f) => [f.ej, f.n, f.s.reps || null, f.s.pausa || null, numONull(f.s.peso)]],
      ["INSERT INTO series_plan (ejercicio_id, numero, reps, pausa) VALUES (?, ?, ?, ?)", (f) => [f.ej, f.n, f.s.reps || null, f.s.pausa || null]],
    ];
    for (const [sql, args] of variantes) {
      try { await env.DB.batch(filas.map((f) => env.DB.prepare(sql).bind(...args(f)))); break; }
      catch (e) { /* probamos la variante siguiente */ }
    }
  }
  return ids;
}

// Crea en la rutina del alumno UN día copiando la plantilla (ya armada con armarPlantilla).
async function plantillaADia(env, pl, alumnoId, fecha, nombre) {
  let rd;
  try {
    rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha) VALUES (?, ?, ?, ?)")
      .bind(alumnoId, nombre, 0, fecha || null).run();
  } catch (e) {
    rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden) VALUES (?, ?, ?)")
      .bind(alumnoId, nombre, 0).run();
  }
  const diaId = rd.meta.last_row_id;
  if (!pl.bloques.length) return diaId;
  const resB = await env.DB.batch(pl.bloques.map((b) =>
    env.DB.prepare("INSERT INTO bloques (dia_id, nombre, orden, pausa) VALUES (?, ?, ?, ?)")
      .bind(diaId, b.nombre, b.orden || 0, b.pausa || null)));
  const items = [];
  pl.bloques.forEach((b, i) => {
    const nuevoBloque = resB[i].meta.last_row_id;
    for (const e of b.ejercicios) {
      items.push({
        bloque_id: nuevoBloque, catalogo_id: e.catalogo_id, orden: e.orden,
        datos: { series_plan: e.series_plan, registrar_carga: e.registrar_carga, notas: e.notas },
      });
    }
  });
  await insertarEjerciciosRutina(env, items);
  return diaId;
}

// Crea una plantilla completa a partir de una "foto" (snapshot) que manda el front:
//   { nombre, etiqueta, notas, bloques: [{ nombre, pausa, ejercicios: [{ catalogo_id, series_plan, registrar_carga, notas }] }] }
// Se usa para "Guardar como plantilla" (desde un día de un alumno) y para duplicar plantillas.
async function crearPlantillaDesdeFoto(env, profeId, foto) {
  const nombre = txt(foto.nombre, 120);
  if (!nombre) throw errorValidacion("Poné un nombre para la planificación");
  const bloques = Array.isArray(foto.bloques) ? foto.bloques.slice(0, 40) : [];
  const catIds = [];
  bloques.forEach((b) => (Array.isArray(b.ejercicios) ? b.ejercicios : []).forEach((e) => catIds.push(e.catalogo_id)));
  const validos = await catalogosDelProfe(catIds, profeId, env);

  const rp = await env.DB.prepare("INSERT INTO plantillas (profe_id, nombre, etiqueta, notas) VALUES (?, ?, ?, ?)")
    .bind(profeId, nombre, txt(foto.etiqueta, 40), txt(foto.notas, 2000)).run();
  const plId = rp.meta.last_row_id;
  if (!bloques.length) return plId;

  const resB = await env.DB.batch(bloques.map((b, i) =>
    env.DB.prepare("INSERT INTO plantilla_bloques (plantilla_id, nombre, orden, pausa) VALUES (?, ?, ?, ?)")
      .bind(plId, txt(b.nombre, 120) || "Bloque " + (i + 1), i, txt(b.pausa, 40))));
  const stmts = [];
  bloques.forEach((b, i) => {
    const bId = resB[i].meta.last_row_id;
    (Array.isArray(b.ejercicios) ? b.ejercicios.slice(0, 60) : []).forEach((e, k) => {
      if (!validos.has(Number(e.catalogo_id))) return;   // ejercicio ajeno o borrado: lo salteamos
      stmts.push(env.DB.prepare("INSERT INTO plantilla_ejercicios (bloque_id, catalogo_id, orden, datos) VALUES (?, ?, ?, ?)")
        .bind(bId, Number(e.catalogo_id), k, JSON.stringify(normalizarDatosEj(e))));
    });
  });
  if (stmts.length) await env.DB.batch(stmts);
  return plId;
}

// Evaluación lista para el front: resultado parseado + nombre del ejercicio/alumno.
function evalSalida(r) {
  return {
    id: r.id, alumno_id: r.alumno_id, alumno_nombre: r.alumno_nombre, tipo: r.tipo, estado: r.estado,
    instrucciones: r.instrucciones, video_id: r.video_id, catalogo_id: r.catalogo_id,
    ejercicio: r.ejercicio || null, fecha_limite: r.fecha_limite, fecha_realizada: r.fecha_realizada,
    peso_corporal: r.peso_corporal, resultado: jsonSeguro(r.resultado), video_alumno: r.video_alumno,
    comentario: r.comentario, devolucion: r.devolucion, creado: r.creado, actualizado: r.actualizado,
  };
}
const SQL_EVAL = `SELECT ev.*, a.nombre AS alumno_nombre, c.nombre AS ejercicio
  FROM evaluaciones ev
  JOIN alumnos a ON a.id = ev.alumno_id
  LEFT JOIN catalogo_ejercicios c ON c.id = ev.catalogo_id`;

function resultadoJSON(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = JSON.stringify(v);
  if (s.length > MAX_JSON) throw new Error("El resultado es demasiado grande");
  return s;
}

// ============================================================
async function rutasPlanEval(request, env, url, path, method, seg, sesion, esProfe, esAlumno) {
  const esMia =
    seg[0] === "plantillas" || seg[0] === "plantilla-bloques" || seg[0] === "plantilla-ejercicios" ||
    seg[0] === "evaluaciones" || seg[0] === "mis-evaluaciones";
  if (!esMia) return null;
  try {
    return await rutasPlanEvalInterno(request, env, url, path, method, seg, sesion, esProfe, esAlumno);
  } catch (err) {
    // Si todavía no se corrió la migración, avisamos claro en vez de un "Error del servidor".
    if (/no such table/i.test(String(err && err.message)))
      return json({ error: "Falta correr la migración de planificaciones y evaluaciones en la base." }, 503);
    if (err && err.esValidacion) return json({ error: err.message }, 400);
    throw err;   // el catch general del router responde 500
  }
}
function errorValidacion(m) { const e = new Error(m); e.esValidacion = true; return e; }

async function rutasPlanEvalInterno(request, env, url, path, method, seg, sesion, esProfe, esAlumno) {
  const body = (method === "POST" || method === "PUT") ? await request.json().catch(() => ({})) : {};

  // ================= PLANTILLAS (profe) =================
  if (esProfe && seg[0] === "plantillas") {
    // Listado con conteos (para las tarjetas)
    if (seg.length === 1 && method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.nombre, p.etiqueta, p.notas, p.usos, p.creado, p.actualizado,
                (SELECT COUNT(*) FROM plantilla_bloques b WHERE b.plantilla_id = p.id) AS n_bloques,
                (SELECT COUNT(*) FROM plantilla_ejercicios e JOIN plantilla_bloques b ON b.id = e.bloque_id
                  WHERE b.plantilla_id = p.id) AS n_ejercicios
         FROM plantillas p WHERE p.profe_id = ? ORDER BY p.actualizado DESC, p.id DESC`
      ).bind(sesion.id).all();
      return json(results);
    }
    // Crear (vacía, o completa desde una foto: "Guardar como plantilla")
    if (seg.length === 1 && method === "POST") {
      const plId = await crearPlantillaDesdeFoto(env, sesion.id, body);
      return json(await armarPlantilla(plId, env), 201);
    }
    const plId = Number(seg[1]);
    if (!plId || !(await plantillaEsDelProfe(plId, sesion.id, env))) return json({ error: "No autorizado" }, 403);

    if (seg.length === 2 && method === "GET") return json(await armarPlantilla(plId, env));
    if (seg.length === 2 && method === "PUT") {
      const nombre = txt(body.nombre, 120);
      if (!nombre) return json({ error: "Poné un nombre" }, 400);
      await env.DB.prepare("UPDATE plantillas SET nombre = ?, etiqueta = ?, notas = ?, actualizado = datetime('now') WHERE id = ?")
        .bind(nombre, txt(body.etiqueta, 40), txt(body.notas, 2000), plId).run();
      return json({ ok: true });
    }
    if (seg.length === 2 && method === "DELETE") {
      // Borrado explícito de hijos (por si la base no tiene las FK activas). Lo YA asignado
      // a alumnos no se toca: son copias independientes.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM plantilla_ejercicios WHERE bloque_id IN (SELECT id FROM plantilla_bloques WHERE plantilla_id = ?)").bind(plId),
        env.DB.prepare("DELETE FROM plantilla_bloques WHERE plantilla_id = ?").bind(plId),
        env.DB.prepare("DELETE FROM plantillas WHERE id = ?").bind(plId),
      ]);
      return json({ ok: true });
    }
    // Duplicar una plantilla (para armar variantes sin arrancar de cero)
    if (seg.length === 3 && seg[2] === "duplicar" && method === "POST") {
      const pl = await armarPlantilla(plId, env);
      const foto = {
        nombre: txt(body.nombre, 120) || (pl.nombre + " (copia)"), etiqueta: pl.etiqueta, notas: pl.notas,
        bloques: pl.bloques.map((b) => ({ nombre: b.nombre, pausa: b.pausa, ejercicios: b.ejercicios })),
      };
      const nuevo = await crearPlantillaDesdeFoto(env, sesion.id, foto);
      return json(await armarPlantilla(nuevo, env), 201);
    }
    // ASIGNAR a un alumno: una copia por cada fecha. body: { alumno_id, fechas: [...], nombre? }
    if (seg.length === 3 && seg[2] === "asignar" && method === "POST") {
      const alumnoId = Number(body.alumno_id);
      const okAl = await env.DB.prepare("SELECT 1 FROM alumnos WHERE id = ? AND profe_id = ?").bind(alumnoId, sesion.id).first();
      if (!okAl) return json({ error: "No es tu alumno" }, 403);
      let fechas = Array.isArray(body.fechas) ? body.fechas.map(fechaISO).filter(Boolean) : [];
      fechas = [...new Set(fechas)].slice(0, 24);
      if (!fechas.length) fechas = [null];
      const pl = await armarPlantilla(plId, env);
      const nombre = txt(body.nombre, 120) || pl.nombre;
      const nuevos = [];
      for (const f of fechas) nuevos.push(await plantillaADia(env, pl, alumnoId, f, nombre));
      await env.DB.prepare("UPDATE plantillas SET usos = usos + ? WHERE id = ?").bind(nuevos.length, plId).run();
      return json({ ok: true, dias_ids: nuevos }, 201);
    }
    return null;
  }

  // --- Bloques de plantilla ---
  if (esProfe && seg[0] === "plantilla-bloques") {
    if (seg.length === 1 && method === "POST") {
      const plId = Number(body.plantilla_id);
      if (!plId || !(await plantillaEsDelProfe(plId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
      const nombre = txt(body.nombre, 120);
      if (!nombre) return json({ error: "Poné un nombre" }, 400);
      const r = await env.DB.prepare("INSERT INTO plantilla_bloques (plantilla_id, nombre, orden, pausa) VALUES (?, ?, ?, ?)")
        .bind(plId, nombre, Number(body.orden) || 0, txt(body.pausa, 40)).run();
      await tocarPlantilla(env, plId);
      return json({ id: r.meta.last_row_id }, 201);
    }
    const bId = Number(seg[1]);
    const plId = bId ? await plBloqueEsDelProfe(bId, sesion.id, env) : null;
    if (!plId) return json({ error: "No autorizado" }, 403);
    if (seg.length === 2 && method === "PUT") {
      const nombre = txt(body.nombre, 120);
      if (!nombre) return json({ error: "Poné un nombre" }, 400);
      await env.DB.prepare("UPDATE plantilla_bloques SET nombre = ?, orden = ?, pausa = ? WHERE id = ?")
        .bind(nombre, Number(body.orden) || 0, txt(body.pausa, 40), bId).run();
      await tocarPlantilla(env, plId);
      return json({ ok: true });
    }
    if (seg.length === 2 && method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM plantilla_ejercicios WHERE bloque_id = ?").bind(bId),
        env.DB.prepare("DELETE FROM plantilla_bloques WHERE id = ?").bind(bId),
      ]);
      await tocarPlantilla(env, plId);
      return json({ ok: true });
    }
    return null;
  }

  // --- Ejercicios de plantilla (mismo body que /ejercicios) ---
  if (esProfe && seg[0] === "plantilla-ejercicios") {
    if (seg.length === 1 && method === "POST") {
      const bId = Number(body.bloque_id);
      const plId = bId ? await plBloqueEsDelProfe(bId, sesion.id, env) : null;
      if (!plId) return json({ error: "No autorizado" }, 403);
      const cat = await env.DB.prepare("SELECT 1 FROM catalogo_ejercicios WHERE id = ? AND profe_id = ?")
        .bind(Number(body.catalogo_id), sesion.id).first();
      if (!cat) return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
      const r = await env.DB.prepare("INSERT INTO plantilla_ejercicios (bloque_id, catalogo_id, orden, datos) VALUES (?, ?, ?, ?)")
        .bind(bId, Number(body.catalogo_id), Number(body.orden) || 0, JSON.stringify(normalizarDatosEj(body))).run();
      await tocarPlantilla(env, plId);
      return json({ id: r.meta.last_row_id }, 201);
    }
    const eId = Number(seg[1]);
    const plId = eId ? await plEjercicioEsDelProfe(eId, sesion.id, env) : null;
    if (!plId) return json({ error: "No autorizado" }, 403);
    if (seg.length === 2 && method === "PUT") {
      if (body.catalogo_id != null) {
        const cat = await env.DB.prepare("SELECT 1 FROM catalogo_ejercicios WHERE id = ? AND profe_id = ?")
          .bind(Number(body.catalogo_id), sesion.id).first();
        if (!cat) return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
        await env.DB.prepare("UPDATE plantilla_ejercicios SET catalogo_id = ?, orden = ?, datos = ? WHERE id = ?")
          .bind(Number(body.catalogo_id), Number(body.orden) || 0, JSON.stringify(normalizarDatosEj(body)), eId).run();
      } else {
        await env.DB.prepare("UPDATE plantilla_ejercicios SET orden = ?, datos = ? WHERE id = ?")
          .bind(Number(body.orden) || 0, JSON.stringify(normalizarDatosEj(body)), eId).run();
      }
      await tocarPlantilla(env, plId);
      return json({ ok: true });
    }
    if (seg.length === 2 && method === "DELETE") {
      await env.DB.prepare("DELETE FROM plantilla_ejercicios WHERE id = ?").bind(eId).run();
      await tocarPlantilla(env, plId);
      return json({ ok: true });
    }
    return null;
  }

  // ================= EVALUACIONES (profe) =================
  if (esProfe && seg[0] === "evaluaciones") {
    // Listado: todas las del profe, o filtradas por alumno.  GET /evaluaciones?alumno_id=12
    if (seg.length === 1 && method === "GET") {
      const alumnoId = Number(url.searchParams.get("alumno_id")) || null;
      const stmt = alumnoId
        ? env.DB.prepare(SQL_EVAL + " WHERE ev.profe_id = ? AND ev.alumno_id = ? ORDER BY ev.creado DESC, ev.id DESC").bind(sesion.id, alumnoId)
        : env.DB.prepare(SQL_EVAL + " WHERE ev.profe_id = ? ORDER BY ev.creado DESC, ev.id DESC").bind(sesion.id);
      return json((await stmt.all()).results.map(evalSalida));
    }
    // Pedir (o cargar directo) una evaluación a uno o varios alumnos.
    //   body: { alumno_ids: [..], tipo, instrucciones, video, catalogo_id, fecha_limite,
    //           estado?, resultado?, peso_corporal?, fecha_realizada?, devolucion? }
    if (seg.length === 1 && method === "POST") {
      const tipo = String(body.tipo || "");
      if (!TIPOS_EVAL.includes(tipo)) return json({ error: "Tipo de evaluación no válido" }, 400);
      const ids = [...new Set((Array.isArray(body.alumno_ids) ? body.alumno_ids : [body.alumno_id]).map(Number).filter((n) => n > 0))].slice(0, 200);
      if (!ids.length) return json({ error: "Elegí al menos un alumno" }, 400);
      const ph = ids.map(() => "?").join(",");
      const propios = (await env.DB.prepare(`SELECT id FROM alumnos WHERE profe_id = ? AND id IN (${ph})`).bind(sesion.id, ...ids).all()).results.map((r) => r.id);
      if (propios.length !== ids.length) return json({ error: "Algún alumno no es tuyo" }, 403);
      let catalogoId = body.catalogo_id ? Number(body.catalogo_id) : null;
      if (catalogoId && !(await env.DB.prepare("SELECT 1 FROM catalogo_ejercicios WHERE id = ? AND profe_id = ?").bind(catalogoId, sesion.id).first()))
        return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
      const estado = ESTADOS_EVAL.includes(body.estado) ? body.estado : "pendiente";
      let resultado;
      try { resultado = resultadoJSON(body.resultado === undefined ? null : body.resultado); }
      catch (e) { return json({ error: e.message }, 400); }
      const fechaReal = estado === "pendiente" ? null : (fechaISO(body.fecha_realizada) || new Date().toISOString().slice(0, 10));
      const stmts = propios.map((aid) => env.DB.prepare(
        `INSERT INTO evaluaciones (profe_id, alumno_id, tipo, estado, instrucciones, video_id, catalogo_id, fecha_limite,
                                   fecha_realizada, peso_corporal, resultado, devolucion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(sesion.id, aid, tipo, estado, txt(body.instrucciones, 3000), extraerVideoId(body.video), catalogoId,
             fechaISO(body.fecha_limite), fechaReal, numONull(body.peso_corporal), resultado, txt(body.devolucion, 3000)));
      const res = await env.DB.batch(stmts);
      return json({ ok: true, ids: res.map((r) => r.meta.last_row_id) }, 201);
    }
    const evId = Number(seg[1]);
    const ev = evId ? await env.DB.prepare("SELECT * FROM evaluaciones WHERE id = ? AND profe_id = ?").bind(evId, sesion.id).first() : null;
    if (!ev) return json({ error: "No autorizado" }, 403);
    if (seg.length === 2 && method === "GET") {
      const r = await env.DB.prepare(SQL_EVAL + " WHERE ev.id = ?").bind(evId).first();
      return json(evalSalida(r));
    }
    // Editar / revisar. Solo pisa los campos que vienen en el body.
    if (seg.length === 2 && method === "PUT") {
      const set = [], vals = [];
      const campo = (col, val) => { set.push(col + " = ?"); vals.push(val); };
      if (body.instrucciones !== undefined) campo("instrucciones", txt(body.instrucciones, 3000));
      if (body.video !== undefined) campo("video_id", extraerVideoId(body.video));
      if (body.catalogo_id !== undefined) {
        const cid = body.catalogo_id ? Number(body.catalogo_id) : null;
        if (cid && !(await env.DB.prepare("SELECT 1 FROM catalogo_ejercicios WHERE id = ? AND profe_id = ?").bind(cid, sesion.id).first()))
          return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
        campo("catalogo_id", cid);
      }
      if (body.fecha_limite !== undefined) campo("fecha_limite", fechaISO(body.fecha_limite));
      if (body.fecha_realizada !== undefined) campo("fecha_realizada", fechaISO(body.fecha_realizada));
      if (body.peso_corporal !== undefined) campo("peso_corporal", numONull(body.peso_corporal));
      if (body.resultado !== undefined) {
        try { campo("resultado", resultadoJSON(body.resultado)); } catch (e) { return json({ error: e.message }, 400); }
      }
      if (body.devolucion !== undefined) campo("devolucion", txt(body.devolucion, 3000));
      if (body.estado !== undefined) {
        if (!ESTADOS_EVAL.includes(body.estado)) return json({ error: "Estado no válido" }, 400);
        campo("estado", body.estado);
        if (body.estado !== "pendiente" && !ev.fecha_realizada && body.fecha_realizada === undefined)
          campo("fecha_realizada", new Date().toISOString().slice(0, 10));
      }
      if (!set.length) return json({ ok: true });
      set.push("actualizado = datetime('now')");
      await env.DB.prepare(`UPDATE evaluaciones SET ${set.join(", ")} WHERE id = ?`).bind(...vals, evId).run();
      const r = await env.DB.prepare(SQL_EVAL + " WHERE ev.id = ?").bind(evId).first();
      return json(evalSalida(r));
    }
    if (seg.length === 2 && method === "DELETE") {
      await env.DB.prepare("DELETE FROM evaluaciones WHERE id = ?").bind(evId).run();
      return json({ ok: true });
    }
    return null;
  }

  // ================= EVALUACIONES (alumno) =================
  if (esAlumno && seg[0] === "mis-evaluaciones") {
    if (seg.length === 1 && method === "GET") {
      const { results } = await env.DB.prepare(SQL_EVAL + " WHERE ev.alumno_id = ? ORDER BY ev.creado DESC, ev.id DESC")
        .bind(sesion.id).all();
      return json(results.map(evalSalida));
    }
    // Cargar / corregir su resultado. Una vez revisada por el profe, queda cerrada.
    if (seg.length === 2 && method === "PUT") {
      const evId = Number(seg[1]);
      const ev = await env.DB.prepare("SELECT id, estado FROM evaluaciones WHERE id = ? AND alumno_id = ?").bind(evId, sesion.id).first();
      if (!ev) return json({ error: "Esa evaluación no es tuya" }, 403);
      if (ev.estado === "revisada") return json({ error: "Tu profe ya la revisó. Si querés corregir algo, escribile." }, 409);
      let resultado;
      try { resultado = resultadoJSON(body.resultado === undefined ? null : body.resultado); }
      catch (e) { return json({ error: e.message }, 400); }
      const video = body.video_alumno ? linkOk(body.video_alumno) : null;
      if (body.video_alumno && !video) return json({ error: "Pegá un link válido (que empiece con http)" }, 400);
      await env.DB.prepare(
        `UPDATE evaluaciones SET estado = 'realizada', resultado = ?, peso_corporal = ?, video_alumno = ?, comentario = ?,
                fecha_realizada = ?, actualizado = datetime('now') WHERE id = ?`
      ).bind(resultado, numONull(body.peso_corporal), video, txt(body.comentario, 2000),
             fechaISO(body.fecha_realizada) || new Date().toISOString().slice(0, 10), evId).run();
      const r = await env.DB.prepare(SQL_EVAL + " WHERE ev.id = ?").bind(evId).first();
      return json(evalSalida(r));
    }
    return null;
  }

  return null;
}

// ============================================================
//  ROUTER
// ============================================================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const seg = path.split("/").filter(Boolean);

    try {
      // ================= PÚBLICO =================
      if (path === "/registro/profe" && method === "POST") {
        const { nombre, email, password } = await request.json();
        if (!nombre || !emailOk(email) || !password)
          return json({ error: "Datos incompletos o email inválido" }, 400);
        if (password.length < 8)
          return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
        if (await emailEnUso(email, env))
          return json({ error: "Ese email ya está registrado" }, 409);
        const { hash, salt } = await hashPassword(password);
        const codigoInv = genCodigo("INV");
        const r = await env.DB.prepare(
          `INSERT INTO profesores (nombre, email, password_hash, password_salt, codigo_invitacion)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(nombre, email, hash, salt, codigoInv).run();
        const token = await crearSesion("profe", r.meta.last_row_id, env);
        return json({ token, rol: "profe", id: r.meta.last_row_id, codigo_invitacion: codigoInv }, 201);
      }

      if (path === "/registro/alumno" && method === "POST") {
        const { nombre, email, password, codigo_invitacion, fecha_nac, objetivo, observaciones } =
          await request.json();
        if (!nombre || !emailOk(email) || !password || !codigo_invitacion)
          return json({ error: "Datos incompletos o email inválido" }, 400);
        if (password.length < 8)
          return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);

        // La invitación es de un solo uso
        const inv = await env.DB.prepare("SELECT id, profe_id, usada FROM invitaciones WHERE codigo = ?")
          .bind(codigo_invitacion).first();
        if (!inv) return json({ error: "Link de invitación inválido" }, 400);
        if (inv.usada) return json({ error: "Este link de invitación ya fue usado" }, 409);
        if (await emailEnUso(email, env)) return json({ error: "Ese email ya está registrado" }, 409);

        const { hash, salt } = await hashPassword(password);
        const r = await env.DB.prepare(
          `INSERT INTO alumnos (profe_id, nombre, email, password_hash, password_salt, fecha_nac, objetivo, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(inv.profe_id, nombre, email, hash, salt, fecha_nac || null, objetivo || null, observaciones || null).run();

        // Quemar la invitación: no la puede usar nadie más
        await env.DB.prepare("UPDATE invitaciones SET usada = 1, alumno_id = ? WHERE id = ?")
          .bind(r.meta.last_row_id, inv.id).run();

        const token = await crearSesion("alumno", r.meta.last_row_id, env);
        return json({ token, rol: "alumno", id: r.meta.last_row_id }, 201);
      }

      if (path === "/login" && method === "POST") {
        const { email, password } = await request.json();
        if (!emailOk(email) || !password) return json({ error: "Datos incompletos" }, 400);
        let rol = "profe";
        let user = await env.DB.prepare("SELECT id, password_hash, password_salt FROM profesores WHERE email = ?")
          .bind(email).first();
        if (!user) {
          rol = "alumno";
          user = await env.DB.prepare("SELECT id, password_hash, password_salt FROM alumnos WHERE email = ?")
            .bind(email).first();
        }
        if (!user) return json({ error: "Email o contraseña incorrectos" }, 401);
        if (!(await verifyPassword(password, user.password_salt, user.password_hash)))
          return json({ error: "Email o contraseña incorrectos" }, 401);
        const token = await crearSesion(rol, user.id, env);
        return json({ token, rol, id: user.id });
      }

      // Login / registro con Google. body: { credential, codigo_invitacion?, modo? }
      //   - Mail que ya existe (profe o alumno): entra.
      //   - Mail nuevo + código de invitación: se registra como alumno de ese profe.
      //   - Mail nuevo + modo "registro_profe": se crea la cuenta de profe (arranca en pausa, igual que el registro común).
      //   - Mail nuevo sin nada de eso: no creamos nada (así un alumno no termina siendo profe por error).
      //  A las cuentas creadas por Google les ponemos una contraseña aleatoria que nadie conoce:
      //  siguen entrando con Google, y si algún día la quieren, se la resetea el profe/admin.
      if (path === "/auth/google" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        let g;
        try { g = await verificarTokenGoogle(body.credential, env); }
        catch (e) { return json({ error: e.message }, 401); }

        const profe = await env.DB.prepare("SELECT id FROM profesores WHERE lower(email) = ?").bind(g.email).first();
        if (profe) return json({ token: await crearSesion("profe", profe.id, env), rol: "profe", id: profe.id });
        const alumno = await env.DB.prepare("SELECT id FROM alumnos WHERE lower(email) = ?").bind(g.email).first();
        if (alumno) return json({ token: await crearSesion("alumno", alumno.id, env), rol: "alumno", id: alumno.id });

        const { hash, salt } = await hashPassword(genToken());   // clave aleatoria e inutilizable

        if (body.codigo_invitacion) {
          const inv = await env.DB.prepare("SELECT id, profe_id, usada FROM invitaciones WHERE codigo = ?")
            .bind(body.codigo_invitacion).first();
          if (!inv) return json({ error: "Link de invitación inválido" }, 400);
          if (inv.usada) return json({ error: "Este link de invitación ya fue usado" }, 409);
          const r = await env.DB.prepare(
            `INSERT INTO alumnos (profe_id, nombre, email, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)`
          ).bind(inv.profe_id, g.nombre, g.email, hash, salt).run();
          await env.DB.prepare("UPDATE invitaciones SET usada = 1, alumno_id = ? WHERE id = ?").bind(r.meta.last_row_id, inv.id).run();
          return json({ token: await crearSesion("alumno", r.meta.last_row_id, env), rol: "alumno", id: r.meta.last_row_id }, 201);
        }

        if (body.modo === "registro_profe") {
          const r = await env.DB.prepare(
            `INSERT INTO profesores (nombre, email, password_hash, password_salt, codigo_invitacion) VALUES (?, ?, ?, ?, ?)`
          ).bind(g.nombre, g.email, hash, salt, genCodigo("INV")).run();
          return json({ token: await crearSesion("profe", r.meta.last_row_id, env), rol: "profe", id: r.meta.last_row_id }, 201);
        }

        return json({ error: "No hay ninguna cuenta con " + g.email + ". Si sos alumno, entrá con el link que te pasó tu profe; si sos profe, tocá \"Crear cuenta\"." }, 404);
      }

      // Olvidé mi contraseña (público). No manda mails: deja un PEDIDO que ve el admin
      // (si es un profe) o su profe (si es un alumno), que le resetea la clave con un toque.
      // Responde SIEMPRE lo mismo, exista o no el mail, para no revelar quién está registrado.
      // INSERT OR IGNORE + PK (rol, usuario_id): un solo pedido pendiente por persona, no se puede spamear.
      if (path === "/olvide-password" && method === "POST") {
        const { email } = await request.json().catch(() => ({}));
        if (!emailOk(email)) return json({ error: "Poné un email válido" }, 400);
        let rol = "profe";
        let u = await env.DB.prepare("SELECT id FROM profesores WHERE lower(email) = lower(?) AND borrado = 0")
          .bind(email).first();
        if (!u) {
          rol = "alumno";
          u = await env.DB.prepare("SELECT id FROM alumnos WHERE lower(email) = lower(?)").bind(email).first();
        }
        if (u) {
          await env.DB.prepare("INSERT OR IGNORE INTO pedidos_reset (rol, usuario_id) VALUES (?, ?)")
            .bind(rol, u.id).run();
        }
        return json({ ok: true });
      }

      // ================= REQUIERE TOKEN =================
      const sesion = await resolverSesion(request, env);
      if (!sesion) return json({ error: "No autorizado" }, 401);
      await asegurarEsquema(env);   // agrega columnas faltantes, una sola vez por instancia
      const esProfe = sesion.rol === "profe";
      const esAlumno = sesion.rol === "alumno";

      // Estado del profe (habilitado / admin) para el control de acceso.
      // Si la migración de admin todavía no corrió, degradamos sin romper.
      let perfilProfe = null;
      if (esProfe) {
        try {
          perfilProfe = await env.DB.prepare(
            "SELECT habilitado, es_admin FROM profesores WHERE id = ?").bind(sesion.id).first();
        } catch { perfilProfe = { habilitado: 1, es_admin: 0 }; }
      }
      const esAdmin = !!(perfilProfe && perfilProfe.es_admin);
      const profeHabilitado = !perfilProfe || perfilProfe.habilitado !== 0;

      // Profe deshabilitado (y no admin): solo puede consultar /yo y salir.
      if (esProfe && !esAdmin && !profeHabilitado && path !== "/yo" && path !== "/logout" && path !== "/mi-password") {
        return json({ error: "Tu cuenta está deshabilitada. Escribile al administrador para activarla." }, 403);
      }

      // Estado del profe del alumno: si su profe está en pausa (deshabilitado),
      // el alumno también queda en pausa. Borrar un profe ya deja habilitado = 0,
      // así que con chequear `habilitado` alcanza para cubrir ambos casos.
      // Ante un error de lectura degradamos sin bloquear (fail-open), igual que arriba.
      let profeDelAlumnoHabilitado = true;
      if (esAlumno) {
        try {
          const pa = await env.DB.prepare(
            "SELECT p.habilitado FROM alumnos a JOIN profesores p ON p.id = a.profe_id WHERE a.id = ?"
          ).bind(sesion.id).first();
          if (pa) profeDelAlumnoHabilitado = pa.habilitado !== 0;
        } catch { profeDelAlumnoHabilitado = true; }
      }

      // Alumno cuyo profe está en pausa: solo puede consultar /yo y salir.
      if (esAlumno && !profeDelAlumnoHabilitado && path !== "/yo" && path !== "/logout" && path !== "/mi-password") {
        return json({ error: "Tu profe está en pausa por el momento. Volvé a intentar más tarde." }, 403);
      }

      if (path === "/yo" && method === "GET") {
        if (esProfe) {
          const p = await env.DB.prepare(
            "SELECT id, nombre, email, codigo_invitacion, debe_cambiar FROM profesores WHERE id = ?").bind(sesion.id).first();
          // Pedidos de "olvidé mi contraseña" que le tocan atender: los de sus alumnos
          // y, si es admin, también los de los profes.
          const pa = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM pedidos_reset pr JOIN alumnos a ON a.id = pr.usuario_id
             WHERE pr.rol = 'alumno' AND a.profe_id = ?`).bind(sesion.id).first();
          let profesPend = 0;
          if (esAdmin) {
            const pp = await env.DB.prepare(
              `SELECT COUNT(*) AS n FROM pedidos_reset pr JOIN profesores x ON x.id = pr.usuario_id
               WHERE pr.rol = 'profe' AND x.borrado = 0`).first();
            profesPend = pp ? pp.n : 0;
          }
          return json({ rol: "profe", ...p, habilitado: profeHabilitado ? 1 : 0, es_admin: esAdmin ? 1 : 0,
                        pedidos_reset: { alumnos: pa ? pa.n : 0, profes: profesPend } });
        } else {
          const a = await env.DB.prepare(
            `SELECT a.id, a.nombre, a.email, a.objetivo, a.observaciones, a.profe_id, a.fecha_nac, a.foto, a.debe_cambiar,
                    p.nombre AS profe_nombre
             FROM alumnos a LEFT JOIN profesores p ON p.id = a.profe_id
             WHERE a.id = ?`).bind(sesion.id).first();
          return json({ rol: "alumno", ...a, profe_en_pausa: profeDelAlumnoHabilitado ? 0 : 1 });
        }
      }

      if (path === "/logout" && method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(token).run();
        return json({ ok: true });
      }

      // Cambiar mi propia contraseña (profe o alumno).
      // Si viene de un reseteo (debe_cambiar = 1) no pedimos la actual: el token ya prueba
      // que entró con la clave temporal, y si cierra y reabre la app no la tenemos en memoria.
      if (path === "/mi-password" && method === "PUT") {
        const { actual, nueva } = await request.json().catch(() => ({}));
        if (!nueva || String(nueva).length < 8)
          return json({ error: "La contraseña nueva necesita 8 caracteres o más" }, 400);
        const tabla = esProfe ? "profesores" : "alumnos";   // nombre fijo, nunca viene del cliente
        const u = await env.DB.prepare(
          `SELECT password_hash, password_salt, debe_cambiar FROM ${tabla} WHERE id = ?`).bind(sesion.id).first();
        if (!u) return json({ error: "Usuario no encontrado" }, 404);
        if (!u.debe_cambiar) {
          if (!actual || !(await verifyPassword(actual, u.password_salt, u.password_hash)))
            return json({ error: "La contraseña actual no es correcta" }, 400);
        }
        const { hash, salt } = await hashPassword(nueva);
        await env.DB.prepare(
          `UPDATE ${tabla} SET password_hash = ?, password_salt = ?, debe_cambiar = 0 WHERE id = ?`)
          .bind(hash, salt, sesion.id).run();
        // Cerramos las OTRAS sesiones (otros celulares); la de este queda viva.
        const tokenActual = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await env.DB.prepare("DELETE FROM sesiones WHERE rol = ? AND usuario_id = ? AND token <> ?")
          .bind(sesion.rol, sesion.id, tokenActual).run();
        await env.DB.prepare("DELETE FROM pedidos_reset WHERE rol = ? AND usuario_id = ?")
          .bind(sesion.rol, sesion.id).run();
        return json({ ok: true });
      }

      // ================= PROFE =================
      // Generar una invitación de un solo uso
      if (path === "/invitaciones" && method === "POST" && esProfe) {
        const { nota } = await request.json().catch(() => ({}));
        const codigo = genCodigo("INV");
        const r = await env.DB.prepare("INSERT INTO invitaciones (profe_id, codigo, nota) VALUES (?, ?, ?)")
          .bind(sesion.id, codigo, nota || null).run();
        return json({ id: r.meta.last_row_id, codigo }, 201);
      }
      // Listar invitaciones del profe (pendientes primero)
      if (path === "/invitaciones" && method === "GET" && esProfe) {
        const { results } = await env.DB.prepare(
          "SELECT id, codigo, usada, nota, creada FROM invitaciones WHERE profe_id = ? ORDER BY usada, creada DESC"
        ).bind(sesion.id).all();
        return json(results);
      }
      // Cancelar una invitación no usada
      if (seg[0] === "invitaciones" && seg.length === 2 && method === "DELETE" && esProfe) {
        const invId = Number(seg[1]);
        const inv = await env.DB.prepare("SELECT profe_id, usada FROM invitaciones WHERE id = ?").bind(invId).first();
        if (!inv || inv.profe_id !== sesion.id) return json({ error: "No autorizado" }, 403);
        if (inv.usada) return json({ error: "Esa invitación ya fue usada" }, 409);
        await env.DB.prepare("DELETE FROM invitaciones WHERE id = ?").bind(invId).run();
        return json({ ok: true });
      }

      // --- CATÁLOGO (la biblioteca del profe) ---
      // Crear
      if (path === "/catalogo" && method === "POST" && esProfe) {
        const { nombre, material, video, descripcion } = await request.json();
        if (!nombre) return json({ error: "Falta el nombre" }, 400);
        const videoId = extraerVideoId(video);
        const r = await env.DB.prepare(
          `INSERT INTO catalogo_ejercicios (profe_id, nombre, material, video_id, descripcion)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(sesion.id, nombre, material || null, videoId, descripcion || null).run();
        return json({ id: r.meta.last_row_id, video_id: videoId }, 201);
      }
      // Buscar / listar   GET /catalogo?q=press
      if (path === "/catalogo" && method === "GET" && esProfe) {
        const q = (url.searchParams.get("q") || "").trim();
        const stmt = q
          ? env.DB.prepare(
              `SELECT id, nombre, material, video_id, descripcion FROM catalogo_ejercicios
               WHERE profe_id = ? AND nombre LIKE ? ORDER BY nombre`
            ).bind(sesion.id, `%${q}%`)
          : env.DB.prepare(
              `SELECT id, nombre, material, video_id, descripcion FROM catalogo_ejercicios
               WHERE profe_id = ? ORDER BY nombre`
            ).bind(sesion.id);
        const { results } = await stmt.all();
        return json(results);
      }
      // Editar
      if (seg[0] === "catalogo" && seg.length === 2 && method === "PUT" && esProfe) {
        const catId = Number(seg[1]);
        if (!(await catalogoEsDelProfe(catId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const { nombre, material, video, descripcion } = await request.json();
        const videoId = extraerVideoId(video);
        await env.DB.prepare(
          `UPDATE catalogo_ejercicios SET nombre = ?, material = ?, video_id = ?, descripcion = ? WHERE id = ?`
        ).bind(nombre, material || null, videoId, descripcion || null, catId).run();
        return json({ ok: true, video_id: videoId });
      }
      // Borrar
      if (seg[0] === "catalogo" && seg.length === 2 && method === "DELETE" && esProfe) {
        const catId = Number(seg[1]);
        if (!(await catalogoEsDelProfe(catId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        await env.DB.prepare("DELETE FROM catalogo_ejercicios WHERE id = ?").bind(catId).run();
        return json({ ok: true });
      }

      // --- ALUMNOS ---
      if (path === "/alumnos" && method === "GET" && esProfe) {
        const { results } = await env.DB.prepare(
          `SELECT id, nombre, email, fecha_nac, objetivo, creado,
                  EXISTS (SELECT 1 FROM pedidos_reset pr WHERE pr.rol = 'alumno' AND pr.usuario_id = alumnos.id) AS pide_reset
           FROM alumnos WHERE profe_id = ? ORDER BY nombre`
        ).bind(sesion.id).all();
        return json(results);
      }
      if (seg[0] === "alumnos" && seg.length === 2 && method === "GET" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const alumno = await env.DB.prepare(
          "SELECT id, nombre, email, fecha_nac, objetivo, observaciones FROM alumnos WHERE id = ?"
        ).bind(alumnoId).first();
        const desde = url.searchParams.get("desde"), hasta = url.searchParams.get("hasta");
        const okF = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
        alumno.dias = await armarRutina(alumnoId, env, true, okF(desde) && okF(hasta) ? { desde, hasta } : null);
        return json(alumno);
      }
      // Borrar un alumno (y toda su rutina/historial). Borrado explícito en orden,
      // sin depender del ON DELETE CASCADE, para no dejar nada huérfano.
      if (seg[0] === "alumnos" && seg.length === 2 && method === "DELETE" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM cargas WHERE alumno_id = ?").bind(alumnoId),
          env.DB.prepare("DELETE FROM ejercicios WHERE bloque_id IN (SELECT b.id FROM bloques b JOIN dias d ON d.id = b.dia_id WHERE d.alumno_id = ?)").bind(alumnoId),
          env.DB.prepare("DELETE FROM bloques WHERE dia_id IN (SELECT id FROM dias WHERE alumno_id = ?)").bind(alumnoId),
          env.DB.prepare("DELETE FROM dias WHERE alumno_id = ?").bind(alumnoId),
          env.DB.prepare("DELETE FROM sesiones WHERE rol = 'alumno' AND usuario_id = ?").bind(alumnoId),
          env.DB.prepare("DELETE FROM alumnos WHERE id = ?").bind(alumnoId),
        ]);
        return json({ ok: true });
      }
      if (seg[0] === "alumnos" && seg.length === 3 && seg[2] === "cargas" && method === "GET" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        let results;
        try {
          results = (await env.DB.prepare(
            `SELECT c.id, c.ejercicio_id, e.catalogo_id, ce.nombre AS ejercicio, c.fecha, c.serie, c.peso, c.reps_hechas, c.rpe, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(alumnoId).all()).results;
        } catch (e) {
          results = (await env.DB.prepare(
            `SELECT c.id, c.ejercicio_id, e.catalogo_id, ce.nombre AS ejercicio, c.fecha, c.peso, c.reps_hechas, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(alumnoId).all()).results;
          results.forEach((r) => { r.serie = null; r.rpe = null; });
        }
        return json(results);
      }

      // SEGUIMIENTO ("diario"): agrupa las cargas del alumno por día calendario, con el
      // esfuerzo (rpe) por ejercicio y la nota del día. Lo consume el modal "Seguimiento"
      // del profe (botón de la planilla). Devuelve { dias: [...] } del día MÁS RECIENTE al
      // más viejo — el front asume ese orden y no reordena.
      if (seg[0] === "alumnos" && seg.length === 3 && seg[2] === "diario" && method === "GET" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        let rows;
        try {
          rows = (await env.DB.prepare(
            `SELECT c.ejercicio_id, c.fecha, c.rpe, c.notas,
                    ce.nombre AS ejercicio, d.nombre AS dia_nombre,
                    b.orden AS bl_orden, e.orden AS ej_orden
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             JOIN bloques b ON b.id = e.bloque_id
             JOIN dias d ON d.id = b.dia_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(alumnoId).all()).results;
        } catch (e) {
          // Base sin columna `rpe` (migración no corrida): la misma consulta pero sin rpe.
          rows = (await env.DB.prepare(
            `SELECT c.ejercicio_id, c.fecha, c.notas,
                    ce.nombre AS ejercicio, d.nombre AS dia_nombre,
                    b.orden AS bl_orden, e.orden AS ej_orden
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             JOIN bloques b ON b.id = e.bloque_id
             JOIN dias d ON d.id = b.dia_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(alumnoId).all()).results;
          rows.forEach((r) => { r.rpe = null; });
        }
        // Agrupo por día. rows viene DESC por fecha, así que el orden de inserción del Map
        // ya deja los días del más reciente al más viejo (y la 1ra nota vista es la más nueva).
        const porDia = new Map();
        for (const r of rows) {
          const dia = String(r.fecha).slice(0, 10);
          let g = porDia.get(dia);
          if (!g) { g = { fecha: r.fecha, nombre: r.dia_nombre || "", nota: "", ej: new Map() }; porDia.set(dia, g); }
          if (!g.nombre && r.dia_nombre) g.nombre = r.dia_nombre;
          if (!g.nota && r.notas && String(r.notas).trim()) g.nota = String(r.notas).trim();
          let x = g.ej.get(r.ejercicio_id);
          if (!x) {
            // Dedup por asignación; el esfuerzo es "uno por ejercicio": tomo el primer rpe no nulo.
            x = { nombre: r.ejercicio || "Ejercicio", rpe: (r.rpe != null ? r.rpe : null),
                  _ord: (Number(r.bl_orden) || 0) * 1000 + (Number(r.ej_orden) || 0) };
            g.ej.set(r.ejercicio_id, x);
          } else if (x.rpe == null && r.rpe != null) {
            x.rpe = r.rpe;
          }
        }
        const dias = [...porDia.values()].map((g) => ({
          fecha: g.fecha,
          nombre: g.nombre,
          nota: g.nota,
          // Ejercicios en el orden de la rutina (bloque, luego ejercicio), no en el que se cargaron.
          ejercicios: [...g.ej.values()].sort((a, b) => a._ord - b._ord).map((x) => ({ nombre: x.nombre, rpe: x.rpe })),
        }));
        return json({ dias });
      }
      if (seg[0] === "alumnos" && seg.length === 3 && seg[2] === "reset-password" && method === "POST" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const nueva = genClaveTemp();
        const { hash, salt } = await hashPassword(nueva);
        await env.DB.prepare("UPDATE alumnos SET password_hash = ?, password_salt = ?, debe_cambiar = 1 WHERE id = ?")
          .bind(hash, salt, alumnoId).run();
        await env.DB.prepare("DELETE FROM pedidos_reset WHERE rol = 'alumno' AND usuario_id = ?").bind(alumnoId).run();
        // Cerrar sus sesiones: la clave vieja deja de servir en todos lados
        await env.DB.prepare("DELETE FROM sesiones WHERE rol = 'alumno' AND usuario_id = ?").bind(alumnoId).run();
        return json({ password: nueva });
      }

      // --- DÍAS ---
      if (path === "/dias" && method === "POST" && esProfe) {
        const { alumno_id, nombre, orden, fecha, es_molde } = await request.json();
        if (!(await alumnoEsDelProfe(alumno_id, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const molde = es_molde ? 1 : 0;
        const fechaFinal = molde ? null : (fecha || null);  // un molde no lleva fecha
        let r;
        try {
          r = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha, es_molde) VALUES (?, ?, ?, ?, ?)")
            .bind(alumno_id, nombre, orden || 0, fechaFinal, molde).run();
        } catch (e) {
          // Migración de es_molde sin correr: intentamos al menos con fecha.
          try {
            r = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha) VALUES (?, ?, ?, ?)")
              .bind(alumno_id, nombre, orden || 0, fechaFinal).run();
          } catch (e2) {
            // Migración de `fecha` tampoco: guardamos el día igual (sin fecha).
            r = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden) VALUES (?, ?, ?)")
              .bind(alumno_id, nombre, orden || 0).run();
          }
        }
        return json({ id: r.meta.last_row_id }, 201);
      }

      // Duplicar un día dentro del MISMO alumno.
      //   body: { fechas: ["YYYY-MM-DD", ...], nombre?, como_molde? }
      //   - como_molde=1  -> la copia nace en el cajón (es_molde=1, sin fecha), ignora `fechas`.
      //   - como_molde=0  -> una copia por cada fecha (o una sin fecha si no mandan `fechas`).
      //   NO copia las cargas: clona la prescripción (bloques + ejercicios + series_plan), no el historial.
      if (seg[0] === "dias" && seg.length === 3 && seg[2] === "duplicar" && method === "POST" && esProfe) {
        const diaId = Number(seg[1]);
        if (!(await diaEsDelProfe(diaId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const body = await request.json().catch(() => ({}));
        const comoMolde = body.como_molde ? 1 : 0;

        const origen = await env.DB.prepare("SELECT alumno_id, nombre FROM dias WHERE id = ?").bind(diaId).first();
        if (!origen) return json({ error: "Día no encontrado" }, 404);

        const bloques = (await env.DB.prepare(
          "SELECT id, nombre, orden, pausa FROM bloques WHERE dia_id = ? ORDER BY orden"
        ).bind(diaId).all()).results;
        const bloqueIds = bloques.map((b) => b.id);

        let ejercicios = [], plan = {};
        if (bloqueIds.length) {
          const ph = bloqueIds.map(() => "?").join(",");
          try {
            ejercicios = (await env.DB.prepare(
              `SELECT id, bloque_id, catalogo_id, orden, series, reps, pausa, notas, registrar_carga
               FROM ejercicios WHERE bloque_id IN (${ph}) ORDER BY orden`
            ).bind(...bloqueIds).all()).results;
          } catch (e) {
            ejercicios = (await env.DB.prepare(
              `SELECT id, bloque_id, catalogo_id, orden, series, reps, pausa, notas
               FROM ejercicios WHERE bloque_id IN (${ph}) ORDER BY orden`
            ).bind(...bloqueIds).all()).results;
          }
          const ejIds = ejercicios.map((e) => e.id);
          if (ejIds.length) {
            try {
              const ph2 = ejIds.map(() => "?").join(",");
              let sp;
              try {
                sp = (await env.DB.prepare(
                  `SELECT ejercicio_id, numero, reps, pausa, peso, rpe FROM series_plan WHERE ejercicio_id IN (${ph2}) ORDER BY numero`
                ).bind(...ejIds).all()).results;
              } catch (e2) {
                sp = (await env.DB.prepare(
                  `SELECT ejercicio_id, numero, reps, pausa FROM series_plan WHERE ejercicio_id IN (${ph2}) ORDER BY numero`
                ).bind(...ejIds).all()).results;
              }
              for (const s of sp) (plan[s.ejercicio_id] = plan[s.ejercicio_id] || []).push(s);
            } catch (e) { plan = {}; }  // migración de series_plan sin correr: degradamos
          }
        }

        // Qué fechas: un molde no lleva fecha; si no, las que manden (o una sin fecha).
        // Ordenadas, porque la semana de la progresión sale de la posición de cada fecha.
        const fechasOk = Array.isArray(body.fechas) ? body.fechas.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f || "")).sort() : [];
        const fechas = comoMolde ? [null] : (fechasOk.length ? fechasOk.slice(0, 60) : [null]);
        const nombre = body.nombre || origen.nombre;
        const nuevos = [];

        // Progresión semanal del peso objetivo ("Armar mes" / "Usar sesión" por varias semanas).
        //   body.progresion = { peso: { incremento: 2.5 }, deload?: { factor: 0.9 } }
        //   Semana k (0, 1, 2...) = peso base + k × incremento, redondeado a 0,5 kg.
        //   Con deload, la última semana es el 90% de la semana anterior.
        //   Solo toca las series que tienen peso objetivo cargado.
        const prog = !comoMolde && fechas.length > 1 && body.progresion && body.progresion.peso ? body.progresion : null;
        const inc = prog ? Number(prog.peso.incremento) || 0 : 0;
        const factorDeload = prog && prog.deload ? Number(prog.deload.factor) || 0.9 : null;
        const pesoSemana = (base, k, total) => {
          if (base == null || base === "" || isNaN(Number(base))) return base == null || base === "" ? null : base;
          const b = Number(base);
          if (!prog) return b;
          if (factorDeload && total > 1 && k === total - 1) return redondear05((b + (k - 1) * inc) * factorDeload);
          return redondear05(b + k * inc);
        };

        // Insertamos por lotes (batch) para minimizar los viajes a la base:
        // 1 día + 1 batch de bloques + 1 batch de ejercicios + 1 batch de series, por fecha.
        for (let k = 0; k < fechas.length; k++) {
          const fecha = fechas[k];
          let rd;
          try {
            // El molde recuerda de qué día salió (para el tilde "guardado en el cajón").
            rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha, es_molde, origen_dia_id) VALUES (?, ?, ?, ?, ?, ?)")
              .bind(origen.alumno_id, nombre, 0, fecha || null, comoMolde, comoMolde ? diaId : null).run();
          } catch (e0) { try {
            rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha, es_molde) VALUES (?, ?, ?, ?, ?)")
              .bind(origen.alumno_id, nombre, 0, fecha || null, comoMolde).run();
          } catch (e) {
            rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha) VALUES (?, ?, ?, ?)")
              .bind(origen.alumno_id, nombre, 0, fecha || null).run();
          } }
          const nuevoDia = rd.meta.last_row_id;

          // Bloques en un solo batch; guardamos el mapeo viejo->nuevo para los hijos.
          const mapaBloque = {};
          if (bloques.length) {
            const stmtsB = bloques.map((b) =>
              env.DB.prepare("INSERT INTO bloques (dia_id, nombre, orden, pausa) VALUES (?, ?, ?, ?)")
                .bind(nuevoDia, b.nombre, b.orden, b.pausa || null));
            const resB = await env.DB.batch(stmtsB);
            bloques.forEach((b, i) => { mapaBloque[b.id] = resB[i].meta.last_row_id; });
          }

          // Ejercicios de todos los bloques en un solo batch.
          const mapaEj = {};
          const ejList = ejercicios.filter((e) => mapaBloque[e.bloque_id]);
          if (ejList.length) {
            let resE;
            try {
              resE = await env.DB.batch(ejList.map((e) =>
                env.DB.prepare(
                  "INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas, registrar_carga) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                ).bind(mapaBloque[e.bloque_id], e.catalogo_id, e.orden, e.series, e.reps, e.pausa, e.notas, e.registrar_carga === 0 ? 0 : 1)));
            } catch (e1) {
              resE = await env.DB.batch(ejList.map((e) =>
                env.DB.prepare(
                  "INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas) VALUES (?, ?, ?, ?, ?, ?, ?)"
                ).bind(mapaBloque[e.bloque_id], e.catalogo_id, e.orden, e.series, e.reps, e.pausa, e.notas)));
            }
            ejList.forEach((e, i) => { mapaEj[e.id] = resE[i].meta.last_row_id; });
          }

          // Series planificadas en un solo batch (degradamos si la tabla no existe).
          const filasS = [];
          for (const viejoId in plan) {
            const nuevoEjId = mapaEj[viejoId];
            if (!nuevoEjId) continue;
            for (const s of plan[viejoId]) filasS.push({ ej: nuevoEjId, s });
          }
          if (filasS.length) {
            try {
              await env.DB.batch(filasS.map(({ ej, s }) => env.DB.prepare(
                "INSERT INTO series_plan (ejercicio_id, numero, reps, pausa, peso, rpe) VALUES (?, ?, ?, ?, ?, ?)"
              ).bind(ej, s.numero, s.reps || null, s.pausa || null, pesoSemana(s.peso, k, fechas.length), s.rpe != null ? s.rpe : null)));
            } catch (e) {
              try {
                await env.DB.batch(filasS.map(({ ej, s }) => env.DB.prepare(
                  "INSERT INTO series_plan (ejercicio_id, numero, reps, pausa) VALUES (?, ?, ?, ?)"
                ).bind(ej, s.numero, s.reps || null, s.pausa || null)));
              } catch (e2) {}
            }
          }

          nuevos.push(nuevoDia);
        }
        // Devolvemos los días YA armados (con bloques/ejercicios) para que el cliente
        // no tenga que volver a pedir la rutina: un solo viaje a la red.
        const todos = await armarRutina(origen.alumno_id, env, true);
        const nuevosCompletos = todos.filter((d) => nuevos.includes(d.id));
        return json({ ok: true, dias: nuevosCompletos }, 201);
      }
      if (seg[0] === "dias" && seg.length === 2 && method === "PUT" && esProfe) {
        const diaId = Number(seg[1]);
        if (!(await diaEsDelProfe(diaId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const { nombre, orden, fecha } = await request.json();
        try {
          await env.DB.prepare("UPDATE dias SET nombre = ?, orden = ?, fecha = ? WHERE id = ?")
            .bind(nombre, orden || 0, fecha || null, diaId).run();
        } catch (e) {
          await env.DB.prepare("UPDATE dias SET nombre = ?, orden = ? WHERE id = ?")
            .bind(nombre, orden || 0, diaId).run();
        }
        return json({ ok: true });
      }
      if (seg[0] === "dias" && seg.length === 2 && method === "DELETE" && esProfe) {
        const diaId = Number(seg[1]);
        if (!(await diaEsDelProfe(diaId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        let info = null;
        try { info = await env.DB.prepare("SELECT es_molde, origen_dia_id FROM dias WHERE id = ?").bind(diaId).first(); } catch (e) {}
        await env.DB.prepare("DELETE FROM dias WHERE id = ?").bind(diaId).run();
        // Si era un molde (sesión del cajón), le contamos al front si el día del que salió
        // se quedó sin ninguna copia guardada, para que destilde el ícono del cajón.
        if (info && Number(info.es_molde) && info.origen_dia_id != null) {
          const quedan = await env.DB.prepare("SELECT COUNT(*) AS n FROM dias WHERE es_molde = 1 AND origen_dia_id = ?")
            .bind(info.origen_dia_id).first();
          return json({ ok: true, origen: { id: info.origen_dia_id, guardado_cajon: quedan && quedan.n > 0 ? 1 : 0 } });
        }
        return json({ ok: true });
      }

      // --- BLOQUES ---
      if (path === "/bloques" && method === "POST" && esProfe) {
        const { dia_id, nombre, orden, pausa } = await request.json();
        if (!(await diaEsDelProfe(dia_id, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const r = await env.DB.prepare("INSERT INTO bloques (dia_id, nombre, orden, pausa) VALUES (?, ?, ?, ?)")
          .bind(dia_id, nombre, orden || 0, pausa || null).run();
        return json({ id: r.meta.last_row_id }, 201);
      }
      if (seg[0] === "bloques" && seg.length === 2 && method === "PUT" && esProfe) {
        const bloqueId = Number(seg[1]);
        if (!(await bloqueEsDelProfe(bloqueId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const { nombre, orden, pausa } = await request.json();
        await env.DB.prepare("UPDATE bloques SET nombre = ?, orden = ?, pausa = ? WHERE id = ?")
          .bind(nombre, orden || 0, pausa || null, bloqueId).run();
        return json({ ok: true });
      }
      if (seg[0] === "bloques" && seg.length === 2 && method === "DELETE" && esProfe) {
        const bloqueId = Number(seg[1]);
        if (!(await bloqueEsDelProfe(bloqueId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        await env.DB.prepare("DELETE FROM bloques WHERE id = ?").bind(bloqueId).run();
        return json({ ok: true });
      }

      // --- EJERCICIOS (asignar del catálogo a un bloque) ---
      if (path === "/ejercicios" && method === "POST" && esProfe) {
        const body = await request.json();
        const { bloque_id, catalogo_id, notas, orden } = body;
        if (!(await bloqueEsDelProfe(bloque_id, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        if (!(await catalogoEsDelProfe(catalogo_id, sesion.id, env)))
          return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
        // Prescripción por serie (nuevo) + resumen legacy (compat/degradación)
        const plan = Array.isArray(body.series_plan) ? body.series_plan : null;
        const series = plan ? plan.length : (body.series || null);
        const reps = plan && plan[0] ? (plan[0].reps || null) : (body.reps || null);
        const pausa = plan && plan[0] ? (plan[0].pausa || null) : (body.pausa || null);
        const regCarga = (body.registrar_carga === 0 || body.registrar_carga === false || body.registrar_carga === "0") ? 0 : 1;
        let r;
        try {
          r = await env.DB.prepare(
            `INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas, registrar_carga)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(bloque_id, catalogo_id, orden || 0, series, reps, pausa, notas || null, regCarga).run();
        } catch (e) {
          r = await env.DB.prepare(
            `INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(bloque_id, catalogo_id, orden || 0, series, reps, pausa, notas || null).run();
        }
        const ejId = r.meta.last_row_id;
        if (plan) await guardarSeriesPlan(env, ejId, plan);
        return json({ id: ejId }, 201);
      }
      if (seg[0] === "ejercicios" && seg.length === 2 && method === "PUT" && esProfe) {
        const ejId = Number(seg[1]);
        if (!(await ejercicioEsDelProfe(ejId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const body = await request.json();
        const { notas, orden, catalogo_id } = body;
        const plan = Array.isArray(body.series_plan) ? body.series_plan : null;
        const series = plan ? plan.length : (body.series || null);
        const reps = plan && plan[0] ? (plan[0].reps || null) : (body.reps || null);
        const pausa = plan && plan[0] ? (plan[0].pausa || null) : (body.pausa || null);
        if (catalogo_id != null) {
          // Cambio de ejercicio base: validar que el nuevo catálogo sea del profe
          if (!(await catalogoEsDelProfe(catalogo_id, sesion.id, env)))
            return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
          await env.DB.prepare(
            "UPDATE ejercicios SET catalogo_id = ?, series = ?, reps = ?, pausa = ?, notas = ?, orden = ? WHERE id = ?"
          ).bind(catalogo_id, series, reps, pausa, notas || null, orden || 0, ejId).run();
        } else {
          await env.DB.prepare(
            "UPDATE ejercicios SET series = ?, reps = ?, pausa = ?, notas = ?, orden = ? WHERE id = ?"
          ).bind(series, reps, pausa, notas || null, orden || 0, ejId).run();
        }
        if (plan) await guardarSeriesPlan(env, ejId, plan);
        if (body.registrar_carga !== undefined) {
          const regCarga = (body.registrar_carga === 0 || body.registrar_carga === false || body.registrar_carga === "0") ? 0 : 1;
          try { await env.DB.prepare("UPDATE ejercicios SET registrar_carga = ? WHERE id = ?").bind(regCarga, ejId).run(); } catch (e) {}
        }
        return json({ ok: true });
      }
      if (seg[0] === "ejercicios" && seg.length === 2 && method === "DELETE" && esProfe) {
        const ejId = Number(seg[1]);
        if (!(await ejercicioEsDelProfe(ejId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        await env.DB.prepare("DELETE FROM ejercicios WHERE id = ?").bind(ejId).run();
        return json({ ok: true });
      }

      // ================= ALUMNO =================
      if (path === "/mi-rutina" && method === "GET" && esAlumno) {
        const dias = await armarRutina(sesion.id, env, false);  // sin moldes
        return json({ alumno_id: sesion.id, dias });
      }
      if (path === "/cargas" && method === "POST" && esAlumno) {
        const body = await request.json();
        const ejercicio_id = body.ejercicio_id;
        if (!(await ejercicioEsDelAlumno(ejercicio_id, sesion.id, env)))
          return json({ error: "Ese ejercicio no es de tu rutina" }, 403);
        const sets = Array.isArray(body.sets) ? body.sets : null;
        // Timestamp compartido para toda la tanda (agrupa las series de una misma carga)
        const fecha = new Date().toISOString().slice(0, 19).replace("T", " ");
        if (sets) {
          try {
            // Reemplazo la tanda de HOY de este ejercicio (evita duplicar si re-guarda el mismo día)
            const hoy = fecha.slice(0, 10);
            await env.DB.prepare(
              "DELETE FROM cargas WHERE ejercicio_id = ? AND alumno_id = ? AND substr(fecha,1,10) = ?"
            ).bind(ejercicio_id, sesion.id, hoy).run();
            const stmts = sets.map((s) => env.DB.prepare(
              `INSERT INTO cargas (ejercicio_id, alumno_id, fecha, serie, peso, reps_hechas, rpe, completado, notas)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(ejercicio_id, sesion.id, fecha, s.serie ?? null, s.peso ?? null, s.reps_hechas || null, s.rpe ?? null, s.completado ? 1 : 0, s.notas || null));
            if (stmts.length) await env.DB.batch(stmts);
            return json({ ok: true, n: stmts.length }, 201);
          } catch (e) {
            // La columna `serie` no existe (migración sin correr): caigo a legacy.
          }
        }
        // Legacy: una sola carga por ejercicio
        const r = await env.DB.prepare(
          `INSERT INTO cargas (ejercicio_id, alumno_id, peso, reps_hechas, completado, notas)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(ejercicio_id, sesion.id, body.peso ?? null, body.reps_hechas || null, body.completado ? 1 : 0, body.notas || null).run();
        return json({ id: r.meta.last_row_id }, 201);
      }
      if (path === "/mis-cargas" && method === "GET" && esAlumno) {
        let results;
        try {
          results = (await env.DB.prepare(
            `SELECT c.id, c.ejercicio_id, e.catalogo_id, ce.nombre AS ejercicio, c.fecha, c.serie, c.peso, c.reps_hechas, c.rpe, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(sesion.id).all()).results;
        } catch (e) {
          results = (await env.DB.prepare(
            `SELECT c.id, c.ejercicio_id, e.catalogo_id, ce.nombre AS ejercicio, c.fecha, c.peso, c.reps_hechas, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(sesion.id).all()).results;
          results.forEach((r) => { r.serie = null; r.rpe = null; });
        }
        return json(results);
      }

      // ------------------------------------------------------------
      //  MEJORES MARCAS del alumno (peso máx por ejercicio del catálogo)
      // ------------------------------------------------------------
      //  Fuente de verdad de "Tu mejor marca anterior". Es el MAX(peso) REAL
      //  del historial, no un valor que solo sabe subir: por eso, si el alumno
      //  corrige un peso cargado de más (o lo pone en cero), la marca BAJA sola.
      //  El filtro `peso > 0` evita que un ejercicio sin peso (o un cero cargado
      //  sin querer) genere una marca fantasma. Agrupa por catalogo_id para que
      //  la marca sea del EJERCICIO, no de la asignación puntual en una rutina.
      if (path === "/mis-mejores-marcas" && method === "GET" && esAlumno) {
        const { results } = await env.DB.prepare(
          `SELECT e.catalogo_id, MAX(c.peso) AS peso
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
            WHERE c.alumno_id = ? AND c.peso IS NOT NULL AND c.peso > 0
            GROUP BY e.catalogo_id`
        ).bind(sesion.id).all();
        return json(results);
      }

      // Nota del alumno para el entrenador (una por día de entrenamiento).
      if (seg[0] === "mi-dia" && seg.length === 3 && seg[2] === "nota" && method === "PUT" && esAlumno) {
        const diaId = Number(seg[1]);
        if (!(await diaEsDelAlumno(diaId, sesion.id, env))) return json({ error: "Ese día no es de tu rutina" }, 403);
        const body = await request.json().catch(() => ({}));
        const nota = body.nota ? String(body.nota).slice(0, 2000) : null;
        try {
          await env.DB.prepare("UPDATE dias SET nota_alumno = ? WHERE id = ?").bind(nota, diaId).run();
        } catch (e) {
          return json({ error: "No se pudo guardar la nota (¿falta correr la migración de nota_alumno?)", detalle: String(e) }, 500);
        }
        return json({ ok: true });
      }

      // Foto de perfil del alumno (data URL base64, ya comprimida en el cliente)
      if (path === "/mi-perfil" && method === "PUT" && esAlumno) {
        const body = await request.json();
        // Foto (opcional)
        if (body.foto !== undefined) {
          const foto = body.foto;
          if (foto != null) {
            if (typeof foto !== "string" || foto.length > 400000)  // ~300 KB: cortamos por las dudas
              return json({ error: "La foto es demasiado grande. Probá con otra." }, 400);
            if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(foto))
              return json({ error: "Formato de imagen no válido." }, 400);
          }
          await env.DB.prepare("UPDATE alumnos SET foto = ? WHERE id = ?").bind(foto || null, sesion.id).run();
        }
        // Objetivo (opcional, validado contra la lista)
        if (body.objetivo !== undefined) {
          const OBJ = ["Fuerza máxima", "Hipertrofia", "Recomposición corporal", "Rendimiento deportivo", "Otro"];
          const obj = body.objetivo || null;
          if (obj !== null && !OBJ.includes(obj)) return json({ error: "Objetivo no válido" }, 400);
          await env.DB.prepare("UPDATE alumnos SET objetivo = ? WHERE id = ?").bind(obj, sesion.id).run();
        }
        // Nombre (opcional, no puede quedar vacío)
        if (body.nombre !== undefined) {
          const nom = String(body.nombre || "").trim().slice(0, 80);
          if (!nom) return json({ error: "El nombre no puede quedar vacío" }, 400);
          await env.DB.prepare("UPDATE alumnos SET nombre = ? WHERE id = ?").bind(nom, sesion.id).run();
        }
        // Fecha de nacimiento (opcional, YYYY-MM-DD o vacío)
        if (body.fecha_nac !== undefined) {
          const f = body.fecha_nac ? String(body.fecha_nac) : null;
          if (f !== null && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return json({ error: "Fecha de nacimiento no válida" }, 400);
          await env.DB.prepare("UPDATE alumnos SET fecha_nac = ? WHERE id = ?").bind(f, sesion.id).run();
        }
        // Observaciones (opcional)
        if (body.observaciones !== undefined) {
          const obs = body.observaciones ? String(body.observaciones).slice(0, 2000) : null;
          await env.DB.prepare("UPDATE alumnos SET observaciones = ? WHERE id = ?").bind(obs, sesion.id).run();
        }
        return json({ ok: true });
      }

      // ================= PLANIFICACIONES + EVALUACIONES (bloque nuevo) =================
      const rNueva = await rutasPlanEval(request, env, url, path, method, seg, sesion, esProfe, esAlumno);
      if (rNueva) return rNueva;

      // ================= ADMIN (creador de la plataforma) =================
      // Cualquier ruta /admin/* exige es_admin.
      if (seg[0] === "admin" && !esAdmin) return json({ error: "No autorizado" }, 403);

      // Resetear la contraseña de un profe (solo admin)
      if (seg[0] === "admin" && seg[1] === "profesores" && seg.length === 4 && seg[3] === "reset-password" && method === "POST" && esAdmin) {
        const pid = Number(seg[2]);
        const target = await env.DB.prepare("SELECT es_admin FROM profesores WHERE id = ? AND borrado = 0").bind(pid).first();
        if (!target) return json({ error: "Profe no encontrado" }, 404);
        if (target.es_admin) return json({ error: "A un admin no se le resetea: cambiala desde \"Cambiar contraseña\"." }, 400);
        const nueva = genClaveTemp();
        const { hash, salt } = await hashPassword(nueva);
        await env.DB.prepare("UPDATE profesores SET password_hash = ?, password_salt = ?, debe_cambiar = 1 WHERE id = ?")
          .bind(hash, salt, pid).run();
        await env.DB.prepare("DELETE FROM pedidos_reset WHERE rol = 'profe' AND usuario_id = ?").bind(pid).run();
        await env.DB.prepare("DELETE FROM sesiones WHERE rol = 'profe' AND usuario_id = ?").bind(pid).run();
        return json({ password: nueva });
      }

      if (path === "/admin/profesores" && method === "GET" && esAdmin) {
        const { results } = await env.DB.prepare(
          `SELECT p.id, p.nombre, p.email, p.habilitado, p.es_admin, p.creado,
                  (SELECT COUNT(*) FROM alumnos a WHERE a.profe_id = p.id) AS alumnos,
                  EXISTS (SELECT 1 FROM pedidos_reset pr WHERE pr.rol = 'profe' AND pr.usuario_id = p.id) AS pide_reset
           FROM profesores p
           WHERE p.borrado = 0
           ORDER BY p.es_admin DESC, p.creado DESC`
        ).all();
        return json({ profesores: results });
      }

      if (seg[0] === "admin" && seg[1] === "profesores" && seg.length === 3 && method === "PUT" && esAdmin) {
        const pid = Number(seg[2]);
        const { habilitado } = await request.json();
        if (pid === sesion.id) return json({ error: "No podés deshabilitarte a vos mismo." }, 400);
        const target = await env.DB.prepare("SELECT es_admin FROM profesores WHERE id = ?").bind(pid).first();
        if (!target) return json({ error: "Profe no encontrado" }, 404);
        if (target.es_admin) return json({ error: "No podés deshabilitar a otro administrador." }, 400);
        await env.DB.prepare("UPDATE profesores SET habilitado = ? WHERE id = ?").bind(habilitado ? 1 : 0, pid).run();
        return json({ ok: true });
      }

      // Borrado lógico de un profe: se oculta y queda deshabilitado, sin destruir datos.
      if (seg[0] === "admin" && seg[1] === "profesores" && seg.length === 3 && method === "DELETE" && esAdmin) {
        const pid = Number(seg[2]);
        if (pid === sesion.id) return json({ error: "No podés borrarte a vos mismo." }, 400);
        const target = await env.DB.prepare("SELECT es_admin FROM profesores WHERE id = ?").bind(pid).first();
        if (!target) return json({ error: "Profe no encontrado" }, 404);
        if (target.es_admin) return json({ error: "No podés borrar a otro administrador." }, 400);
        await env.DB.prepare("UPDATE profesores SET borrado = 1, habilitado = 0 WHERE id = ?").bind(pid).run();
        return json({ ok: true });
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error del servidor", detalle: String(err) }, 500);
    }
  },
};
