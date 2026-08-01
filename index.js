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
async function armarRutina(alumnoId, env) {
  const dias = (await env.DB.prepare(
    "SELECT id, nombre, orden FROM dias WHERE alumno_id = ? ORDER BY orden"
  ).bind(alumnoId).all()).results;

  const bloques = (await env.DB.prepare(
    `SELECT b.id, b.dia_id, b.nombre, b.orden, b.pausa
     FROM bloques b JOIN dias d ON d.id = b.dia_id
     WHERE d.alumno_id = ? ORDER BY b.orden`
  ).bind(alumnoId).all()).results;

  const ejercicios = (await env.DB.prepare(
    `SELECT e.id, e.bloque_id, e.orden, e.series, e.reps, e.pausa, e.notas, e.catalogo_id,
            c.nombre, c.material, c.video_id
     FROM ejercicios e
     JOIN catalogo_ejercicios c ON c.id = e.catalogo_id
     JOIN bloques b ON b.id = e.bloque_id
     JOIN dias d ON d.id = b.dia_id
     WHERE d.alumno_id = ? ORDER BY e.orden`
  ).bind(alumnoId).all()).results;

  for (const b of bloques) b.ejercicios = ejercicios.filter((e) => e.bloque_id === b.id);
  for (const d of dias) d.bloques = bloques.filter((b) => b.dia_id === d.id);
  return dias;
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
        const profe = await env.DB.prepare("SELECT id FROM profesores WHERE codigo_invitacion = ?")
          .bind(codigo_invitacion).first();
        if (!profe) return json({ error: "Link de invitación inválido" }, 400);
        if (await emailEnUso(email, env)) return json({ error: "Ese email ya está registrado" }, 409);
        const { hash, salt } = await hashPassword(password);
        const r = await env.DB.prepare(
          `INSERT INTO alumnos (profe_id, nombre, email, password_hash, password_salt, fecha_nac, objetivo, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(profe.id, nombre, email, hash, salt, fecha_nac || null, objetivo || null, observaciones || null).run();
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

      if (path === "/yo" && method === "GET") {
        if (esProfe) {
          const p = await env.DB.prepare(
            "SELECT id, nombre, email, codigo_invitacion FROM profesores WHERE id = ?").bind(sesion.id).first();
          return json({ rol: "profe", ...p });
        } else {
          const a = await env.DB.prepare(
            "SELECT id, nombre, email, objetivo, profe_id FROM alumnos WHERE id = ?").bind(sesion.id).first();
          return json({ rol: "alumno", ...a });
        }
      }

      if (path === "/logout" && method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(token).run();
        return json({ ok: true });
      }

      // ================= PROFE =================
      if (path === "/mi-invitacion" && method === "GET" && esProfe) {
        const p = await env.DB.prepare("SELECT codigo_invitacion FROM profesores WHERE id = ?")
          .bind(sesion.id).first();
        return json({ codigo_invitacion: p.codigo_invitacion });
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
          "SELECT id, nombre, email, objetivo, creado FROM alumnos WHERE profe_id = ? ORDER BY nombre"
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
      if (seg[0] === "alumnos" && seg.length === 3 && seg[2] === "cargas" && method === "GET" && esProfe) {
        const alumnoId = Number(seg[1]);
        if (!(await alumnoEsDelProfe(alumnoId, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const { results } = await env.DB.prepare(
          `SELECT c.id, c.ejercicio_id, ce.nombre AS ejercicio, c.fecha, c.peso, c.reps_hechas, c.completado, c.notas
           FROM cargas c
           JOIN ejercicios e ON e.id = c.ejercicio_id
           JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
           WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
        ).bind(alumnoId).all();
        return json(results);
      }

      // --- DÍAS ---
      if (path === "/dias" && method === "POST" && esProfe) {
        const { alumno_id, nombre, orden } = await request.json();
        if (!(await alumnoEsDelProfe(alumno_id, sesion.id, env))) return json({ error: "No es tu alumno" }, 403);
        const r = await env.DB.prepare("INSERT INTO dias (alumno_id, nombre, orden) VALUES (?, ?, ?)")
          .bind(alumno_id, nombre, orden || 0).run();
        return json({ id: r.meta.last_row_id }, 201);
      }
      if (seg[0] === "dias" && seg.length === 2 && method === "PUT" && esProfe) {
        const diaId = Number(seg[1]);
        if (!(await diaEsDelProfe(diaId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const { nombre, orden } = await request.json();
        await env.DB.prepare("UPDATE dias SET nombre = ?, orden = ? WHERE id = ?")
          .bind(nombre, orden || 0, diaId).run();
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
        const { bloque_id, catalogo_id, series, reps, pausa, notas, orden } = await request.json();
        if (!(await bloqueEsDelProfe(bloque_id, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        if (!(await catalogoEsDelProfe(catalogo_id, sesion.id, env)))
          return json({ error: "Ese ejercicio no está en tu catálogo" }, 403);
        const r = await env.DB.prepare(
          `INSERT INTO ejercicios (bloque_id, catalogo_id, orden, series, reps, pausa, notas)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(bloque_id, catalogo_id, orden || 0, series || null, reps || null, pausa || null, notas || null).run();
        return json({ id: r.meta.last_row_id }, 201);
      }
      if (seg[0] === "ejercicios" && seg.length === 2 && method === "PUT" && esProfe) {
        const ejId = Number(seg[1]);
        if (!(await ejercicioEsDelProfe(ejId, sesion.id, env))) return json({ error: "No autorizado" }, 403);
        const { series, reps, pausa, notas, orden } = await request.json();
        await env.DB.prepare(
          "UPDATE ejercicios SET series = ?, reps = ?, pausa = ?, notas = ?, orden = ? WHERE id = ?"
        ).bind(series || null, reps || null, pausa || null, notas || null, orden || 0, ejId).run();
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
        const dias = await armarRutina(sesion.id, env);
        return json({ alumno_id: sesion.id, dias });
      }
      if (path === "/cargas" && method === "POST" && esAlumno) {
        const { ejercicio_id, peso, reps_hechas, completado, notas } = await request.json();
        if (!(await ejercicioEsDelAlumno(ejercicio_id, sesion.id, env)))
          return json({ error: "Ese ejercicio no es de tu rutina" }, 403);
        const r = await env.DB.prepare(
          `INSERT INTO cargas (ejercicio_id, alumno_id, peso, reps_hechas, completado, notas)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(ejercicio_id, sesion.id, peso ?? null, reps_hechas || null, completado ? 1 : 0, notas || null).run();
        return json({ id: r.meta.last_row_id }, 201);
      }
      if (path === "/mis-cargas" && method === "GET" && esAlumno) {
        const { results } = await env.DB.prepare(
          `SELECT c.id, c.ejercicio_id, ce.nombre AS ejercicio, c.fecha, c.peso, c.reps_hechas, c.completado, c.notas
           FROM cargas c
           JOIN ejercicios e ON e.id = c.ejercicio_id
           JOIN catalogo_ejercicios ce ON ce.id = e.catalogo_id
           WHERE c.alumno_id = ? ORDER BY c.fecha DESC`
        ).bind(sesion.id).all();
        return json(results);
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error del servidor", detalle: String(err) }, 500);
    }
  },
};
