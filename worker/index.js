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

// Rutina anidada: días -> bloques -> ejercicios (con datos del catálogo)
//   incluirMoldes = true  -> trae TODO (para el profe: rutina real + cajón de sesiones)
//   incluirMoldes = false -> excluye los moldes (para el alumno: nunca ve la biblioteca del profe)
async function armarRutina(alumnoId, env, incluirMoldes = true) {
  const qDias = "SELECT id, nombre, orden, fecha, es_molde FROM dias WHERE alumno_id = ? ORDER BY (fecha IS NULL), fecha, orden";
  const qBloques = `SELECT b.id, b.dia_id, b.nombre, b.orden, b.pausa
     FROM bloques b JOIN dias d ON d.id = b.dia_id
     WHERE d.alumno_id = ? ORDER BY b.orden`;
  const qEjercicios = `SELECT e.id, e.bloque_id, e.orden, e.series, e.reps, e.pausa, e.notas, e.catalogo_id,
            c.nombre, c.material, c.video_id
     FROM ejercicios e
     JOIN catalogo_ejercicios c ON c.id = e.catalogo_id
     JOIN bloques b ON b.id = e.bloque_id
     JOIN dias d ON d.id = b.dia_id
     WHERE d.alumno_id = ? ORDER BY e.orden`;
  const qSeries = `SELECT sp.ejercicio_id, sp.numero, sp.reps, sp.pausa
       FROM series_plan sp
       JOIN ejercicios e ON e.id = sp.ejercicio_id
       JOIN bloques b ON b.id = e.bloque_id
       JOIN dias d ON d.id = b.dia_id
       WHERE d.alumno_id = ? ORDER BY sp.ejercicio_id, sp.numero`;

  let dias, bloques, ejercicios, spRows;
  try {
    // Las 4 lecturas en un SOLO viaje a la base (batch). Es lo que hace que abrir
    // la rutina sea rápido en vez de sumar 4 idas y vueltas.
    const res = await env.DB.batch([
      env.DB.prepare(qDias).bind(alumnoId),
      env.DB.prepare(qBloques).bind(alumnoId),
      env.DB.prepare(qEjercicios).bind(alumnoId),
      env.DB.prepare(qSeries).bind(alumnoId),
    ]);
    dias = res[0].results; bloques = res[1].results;
    ejercicios = res[2].results; spRows = res[3].results;
  } catch (e) {
    // Fallback (alguna migración no corrió): vamos query por query, degradando sin romper.
    try {
      dias = (await env.DB.prepare(qDias).bind(alumnoId).all()).results;
    } catch (e1) {
      try {
        dias = (await env.DB.prepare("SELECT id, nombre, orden, fecha FROM dias WHERE alumno_id = ? ORDER BY (fecha IS NULL), fecha, orden").bind(alumnoId).all()).results;
      } catch (e2) {
        dias = (await env.DB.prepare("SELECT id, nombre, orden FROM dias WHERE alumno_id = ? ORDER BY orden").bind(alumnoId).all()).results;
        for (const d of dias) d.fecha = null;
      }
      for (const d of dias) d.es_molde = 0;
    }
    bloques = (await env.DB.prepare(qBloques).bind(alumnoId).all()).results;
    ejercicios = (await env.DB.prepare(qEjercicios).bind(alumnoId).all()).results;
    try { spRows = (await env.DB.prepare(qSeries).bind(alumnoId).all()).results; }
    catch (e3) { spRows = []; }
  }

  // El alumno nunca ve los moldes. Filtramos acá: los bloques/ejercicios se
  // ensamblan por dia_id contra este array ya filtrado, así que los del molde se descartan solos.
  if (!incluirMoldes) dias = dias.filter((d) => !Number(d.es_molde));

  const planPorEj = {};
  for (const r of (spRows || [])) (planPorEj[r.ejercicio_id] = planPorEj[r.ejercicio_id] || []).push({ numero: r.numero, reps: r.reps, pausa: r.pausa });
  for (const e of ejercicios) e.series_plan = planPorEj[e.id] || [];

  for (const b of bloques) b.ejercicios = ejercicios.filter((e) => e.bloque_id === b.id);
  for (const d of dias) d.bloques = bloques.filter((b) => b.dia_id === d.id);
  return dias;
}

// Reemplaza la prescripción por serie de un ejercicio. Degrada sin romper
// si la tabla series_plan todavía no existe (migración sin correr).
async function guardarSeriesPlan(env, ejId, plan) {
  if (!Array.isArray(plan)) return false;
  try {
    await env.DB.prepare("DELETE FROM series_plan WHERE ejercicio_id = ?").bind(ejId).run();
    const stmts = plan.map((s, i) =>
      env.DB.prepare("INSERT INTO series_plan (ejercicio_id, numero, reps, pausa) VALUES (?, ?, ?, ?)")
        .bind(ejId, s.numero ?? (i + 1), s.reps || null, s.pausa || null));
    if (stmts.length) await env.DB.batch(stmts);
    return true;
  } catch (e) { return false; }
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

      // ================= REQUIERE TOKEN =================
      const sesion = await resolverSesion(request, env);
      if (!sesion) return json({ error: "No autorizado" }, 401);
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
      if (esProfe && !esAdmin && !profeHabilitado && path !== "/yo" && path !== "/logout") {
        return json({ error: "Tu cuenta está deshabilitada. Escribile al administrador para activarla." }, 403);
      }

      if (path === "/yo" && method === "GET") {
        if (esProfe) {
          const p = await env.DB.prepare(
            "SELECT id, nombre, email, codigo_invitacion FROM profesores WHERE id = ?").bind(sesion.id).first();
          return json({ rol: "profe", ...p, habilitado: profeHabilitado ? 1 : 0, es_admin: esAdmin ? 1 : 0 });
        } else {
          const a = await env.DB.prepare(
            `SELECT a.id, a.nombre, a.email, a.objetivo, a.observaciones, a.profe_id, a.fecha_nac, a.foto,
                    p.nombre AS profe_nombre
             FROM alumnos a LEFT JOIN profesores p ON p.id = a.profe_id
             WHERE a.id = ?`).bind(sesion.id).first();
          return json({ rol: "alumno", ...a });
        }
      }

      if (path === "/logout" && method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(token).run();
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
          "SELECT id, nombre, email, fecha_nac, objetivo, creado FROM alumnos WHERE profe_id = ? ORDER BY nombre"
        ).bind(sesion.id).all();
        return json(results);
      }
      if (seg[0] === "alumnos" && seg.length === 2 && method === "GET" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const alumno = await env.DB.prepare(
          "SELECT id, nombre, email, fecha_nac, objetivo, observaciones FROM alumnos WHERE id = ?"
        ).bind(alumnoId).first();
        alumno.dias = await armarRutina(alumnoId, env);
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
            `SELECT c.id, c.ejercicio_id, ce.nombre AS ejercicio, c.fecha, c.serie, c.peso, c.reps_hechas, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(alumnoId).all()).results;
        } catch (e) {
          results = (await env.DB.prepare(
            `SELECT c.id, c.ejercicio_id, ce.nombre AS ejercicio, c.fecha, c.peso, c.reps_hechas, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(alumnoId).all()).results;
          results.forEach((r) => (r.serie = null));
        }
        return json(results);
      }

      // Resetear la contraseña de un alumno: genera una nueva y la devuelve al profe
      if (seg[0] === "alumnos" && seg.length === 3 && seg[2] === "reset-password" && method === "POST" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const nueva = genClaveTemp();
        const { hash, salt } = await hashPassword(nueva);
        await env.DB.prepare("UPDATE alumnos SET password_hash = ?, password_salt = ? WHERE id = ?")
          .bind(hash, salt, alumnoId).run();
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
          ejercicios = (await env.DB.prepare(
            `SELECT id, bloque_id, catalogo_id, orden, series, reps, pausa, notas
             FROM ejercicios WHERE bloque_id IN (${ph}) ORDER BY orden`
          ).bind(...bloqueIds).all()).results;
          const ejIds = ejercicios.map((e) => e.id);
          if (ejIds.length) {
            try {
              const ph2 = ejIds.map(() => "?").join(",");
              const sp = (await env.DB.prepare(
                `SELECT ejercicio_id, numero, reps, pausa FROM series_plan WHERE ejercicio_id IN (${ph2}) ORDER BY numero`
              ).bind(...ejIds).all()).results;
              for (const s of sp) (plan[s.ejercicio_id] = plan[s.ejercicio_id] || []).push(s);
            } catch (e) { plan = {}; }  // migración de series_plan sin correr: degradamos
          }
        }

        // Qué fechas: un molde no lleva fecha; si no, las que manden (o una sin fecha).
        const fechas = comoMolde ? [null] : (Array.isArray(body.fechas) && body.fechas.length ? body.fechas : [null]);
        const nombre = body.nombre || origen.nombre;
        const nuevos = [];

        // Insertamos por lotes (batch) para minimizar los viajes a la base:
        // 1 día + 1 batch de bloques + 1 batch de ejercicios + 1 batch de series, por fecha.
        for (const fecha of fechas) {
          let rd;
          try {
            rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha, es_molde) VALUES (?, ?, ?, ?, ?)")
              .bind(origen.alumno_id, nombre, 0, fecha || null, comoMolde).run();
          } catch (e) {
            rd = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden, fecha) VALUES (?, ?, ?, ?)")
              .bind(origen.alumno_id, nombre, 0, fecha || null).run();
          }
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
            const stmtsE = ejList.map((e) =>
              env.DB.prepare(
                "INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas) VALUES (?, ?, ?, ?, ?, ?, ?)"
              ).bind(mapaBloque[e.bloque_id], e.catalogo_id, e.orden, e.series, e.reps, e.pausa, e.notas));
            const resE = await env.DB.batch(stmtsE);
            ejList.forEach((e, i) => { mapaEj[e.id] = resE[i].meta.last_row_id; });
          }

          // Series planificadas en un solo batch (degradamos si la tabla no existe).
          const stmtsS = [];
          for (const viejoId in plan) {
            const nuevoEjId = mapaEj[viejoId];
            if (!nuevoEjId) continue;
            for (const s of plan[viejoId]) {
              stmtsS.push(env.DB.prepare(
                "INSERT INTO series_plan (ejercicio_id, numero, reps, pausa) VALUES (?, ?, ?, ?)"
              ).bind(nuevoEjId, s.numero, s.reps || null, s.pausa || null));
            }
          }
          if (stmtsS.length) { try { await env.DB.batch(stmtsS); } catch (e) {} }

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
        await env.DB.prepare("DELETE FROM dias WHERE id = ?").bind(diaId).run();
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
        const r = await env.DB.prepare(
          `INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(bloque_id, catalogo_id, orden || 0, series, reps, pausa, notas || null).run();
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
              `INSERT INTO cargas (ejercicio_id, alumno_id, fecha, serie, peso, reps_hechas, completado, notas)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(ejercicio_id, sesion.id, fecha, s.serie ?? null, s.peso ?? null, s.reps_hechas || null, s.completado ? 1 : 0, s.notas || null));
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
            `SELECT c.id, c.ejercicio_id, ce.nombre AS ejercicio, c.fecha, c.serie, c.peso, c.reps_hechas, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(sesion.id).all()).results;
        } catch (e) {
          results = (await env.DB.prepare(
            `SELECT c.id, c.ejercicio_id, ce.nombre AS ejercicio, c.fecha, c.peso, c.reps_hechas, c.completado, c.notas
             FROM cargas c
             JOIN ejercicios e ON e.id = c.ejercicio_id
             JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
             WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
          ).bind(sesion.id).all()).results;
          results.forEach((r) => (r.serie = null));
        }
        return json(results);
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
        // Observaciones (opcional)
        if (body.observaciones !== undefined) {
          const obs = body.observaciones ? String(body.observaciones).slice(0, 2000) : null;
          await env.DB.prepare("UPDATE alumnos SET observaciones = ? WHERE id = ?").bind(obs, sesion.id).run();
        }
        return json({ ok: true });
      }

      // ================= ADMIN (creador de la plataforma) =================
      // Cualquier ruta /admin/* exige es_admin.
      if (seg[0] === "admin" && !esAdmin) return json({ error: "No autorizado" }, 403);

      // Resetear la contraseña de un profe (solo admin)
      if (seg[0] === "admin" && seg[1] === "profesores" && seg.length === 4 && seg[3] === "reset-password" && method === "POST" && esAdmin) {
        const pid = Number(seg[2]);
        const nueva = genClaveTemp();
        const { hash, salt } = await hashPassword(nueva);
        await env.DB.prepare("UPDATE profesores SET password_hash = ?, password_salt = ? WHERE id = ?")
          .bind(hash, salt, pid).run();
        await env.DB.prepare("DELETE FROM sesiones WHERE rol = 'profe' AND usuario_id = ?").bind(pid).run();
        return json({ password: nueva });
      }

      if (path === "/admin/profesores" && method === "GET" && esAdmin) {
        const { results } = await env.DB.prepare(
          `SELECT p.id, p.nombre, p.email, p.habilitado, p.es_admin, p.creado,
                  (SELECT COUNT(*) FROM alumnos a WHERE a.profe_id = p.id) AS alumnos
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
