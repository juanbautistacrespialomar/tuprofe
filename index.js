// ============================================================
//  tuprofe · Worker (la API que corre en Cloudflare)
// ------------------------------------------------------------
//  Acceso: email + contraseña (hasheada), invitación de alumnos
//  por código del profe, y sesión persistente por token.
//
//  Público (sin token):
//    POST /registro/profe    { nombre, email, password }
//    POST /registro/alumno   { nombre, email, password, codigo_invitacion, ... }
//    POST /login             { email, password }
//
//  Con token (header Authorization: Bearer <token>):
//    GET  /yo                quién soy (para el arranque de la app)
//    POST /logout            cierra la sesión de este dispositivo
//    GET  /mi-invitacion     (profe) su código/link para invitar alumnos
//    GET  /alumnos           (profe) sus alumnos
//    GET  /mi-rutina         (alumno) su rutina
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
//  Helpers de seguridad
// ------------------------------------------------------------

// ArrayBuffer <-> hex
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

// Hashea la contraseña con PBKDF2 (nativo en Workers). Nunca guardamos
// la contraseña; guardamos este hash + su salt. Para verificar, se
// re-hashea con el mismo salt y se compara.
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return { hash: bufToHex(bits), salt: bufToHex(salt) };
}

async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === hashHex;
}

// Token de sesión aleatorio (32 bytes = 64 hex). Se guarda en la base
// y en el celu; mientras exista, la app no vuelve a pedir login.
function genToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// Código de invitación tipo "INV-X7K2" (sin caracteres confusos).
function genCodigo(prefijo) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return `${prefijo}-${s}`;
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");

// ¿Este email ya está usado por algún profe o alumno? (email único global)
async function emailEnUso(email, env) {
  const p = await env.DB.prepare("SELECT 1 FROM profesores WHERE email = ?").bind(email).first();
  if (p) return true;
  const a = await env.DB.prepare("SELECT 1 FROM alumnos WHERE email = ?").bind(email).first();
  return !!a;
}

// Crea una sesión y devuelve el token
async function crearSesion(rol, usuarioId, env) {
  const token = genToken();
  await env.DB
    .prepare("INSERT INTO sesiones (token, rol, usuario_id) VALUES (?, ?, ?)")
    .bind(token, rol, usuarioId)
    .run();
  return token;
}

// Resuelve el token del header a una sesión: { rol, id } o null
async function resolverSesion(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const s = await env.DB
    .prepare("SELECT rol, usuario_id FROM sesiones WHERE token = ?")
    .bind(token)
    .first();
  return s ? { rol: s.rol, id: s.usuario_id } : null;
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

    try {
      // ========================================================
      //  PÚBLICO
      // ========================================================

      // --- Registro de PROFE (abierto) ---
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
        const r = await env.DB
          .prepare(`INSERT INTO profesores (nombre, email, password_hash, password_salt, codigo_invitacion)
                    VALUES (?, ?, ?, ?, ?)`)
          .bind(nombre, email, hash, salt, codigoInv)
          .run();

        const token = await crearSesion("profe", r.meta.last_row_id, env);
        return json({ token, rol: "profe", id: r.meta.last_row_id, codigo_invitacion: codigoInv }, 201);
      }

      // --- Registro de ALUMNO (por link de invitación del profe) ---
      if (path === "/registro/alumno" && method === "POST") {
        const { nombre, email, password, codigo_invitacion, fecha_nac, objetivo, observaciones } =
          await request.json();
        if (!nombre || !emailOk(email) || !password || !codigo_invitacion)
          return json({ error: "Datos incompletos o email inválido" }, 400);
        if (password.length < 8)
          return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);

        // El código de invitación nos dice a qué profe pertenece
        const profe = await env.DB
          .prepare("SELECT id FROM profesores WHERE codigo_invitacion = ?")
          .bind(codigo_invitacion)
          .first();
        if (!profe) return json({ error: "Link de invitación inválido" }, 400);

        if (await emailEnUso(email, env))
          return json({ error: "Ese email ya está registrado" }, 409);

        const { hash, salt } = await hashPassword(password);
        const r = await env.DB
          .prepare(`INSERT INTO alumnos (profe_id, nombre, email, password_hash, password_salt, fecha_nac, objetivo, observaciones)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(profe.id, nombre, email, hash, salt, fecha_nac || null, objetivo || null, observaciones || null)
          .run();

        const token = await crearSesion("alumno", r.meta.last_row_id, env);
        return json({ token, rol: "alumno", id: r.meta.last_row_id }, 201);
      }

      // --- Login (sirve para profe y alumno) ---
      if (path === "/login" && method === "POST") {
        const { email, password } = await request.json();
        if (!emailOk(email) || !password) return json({ error: "Datos incompletos" }, 400);

        // Buscamos primero en profes, después en alumnos
        let rol = "profe";
        let user = await env.DB
          .prepare("SELECT id, password_hash, password_salt FROM profesores WHERE email = ?")
          .bind(email)
          .first();
        if (!user) {
          rol = "alumno";
          user = await env.DB
            .prepare("SELECT id, password_hash, password_salt FROM alumnos WHERE email = ?")
            .bind(email)
            .first();
        }
        if (!user) return json({ error: "Email o contraseña incorrectos" }, 401);

        const ok = await verifyPassword(password, user.password_salt, user.password_hash);
        if (!ok) return json({ error: "Email o contraseña incorrectos" }, 401);

        const token = await crearSesion(rol, user.id, env);
        return json({ token, rol, id: user.id });
      }

      // ========================================================
      //  DE ACÁ EN ADELANTE: requiere token válido
      // ========================================================
      const sesion = await resolverSesion(request, env);
      if (!sesion) return json({ error: "No autorizado" }, 401);

      // --- Quién soy (el front lo llama al abrir con el token guardado) ---
      if (path === "/yo" && method === "GET") {
        if (sesion.rol === "profe") {
          const p = await env.DB
            .prepare("SELECT id, nombre, email, codigo_invitacion FROM profesores WHERE id = ?")
            .bind(sesion.id)
            .first();
          return json({ rol: "profe", ...p });
        } else {
          const a = await env.DB
            .prepare("SELECT id, nombre, email, objetivo, profe_id FROM alumnos WHERE id = ?")
            .bind(sesion.id)
            .first();
          return json({ rol: "alumno", ...a });
        }
      }

      // --- Logout (borra la sesión de este dispositivo) ---
      if (path === "/logout" && method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(token).run();
        return json({ ok: true });
      }

      // ========================================================
      //  PROFE
      // ========================================================
      if (path === "/mi-invitacion" && method === "GET") {
        if (sesion.rol !== "profe") return json({ error: "Solo profe" }, 403);
        const p = await env.DB
          .prepare("SELECT codigo_invitacion FROM profesores WHERE id = ?")
          .bind(sesion.id)
          .first();
        return json({ codigo_invitacion: p.codigo_invitacion });
      }

      if (path === "/alumnos" && method === "GET") {
        if (sesion.rol !== "profe") return json({ error: "Solo profe" }, 403);
        const { results } = await env.DB
          .prepare(`SELECT id, nombre, email, objetivo, creado
                    FROM alumnos WHERE profe_id = ? ORDER BY nombre`)
          .bind(sesion.id)                    // <- multi-tenant: solo SUS alumnos
          .all();
        return json(results);
      }

      // ========================================================
      //  ALUMNO
      // ========================================================
      if (path === "/mi-rutina" && method === "GET") {
        if (sesion.rol !== "alumno") return json({ error: "Solo alumno" }, 403);
        const { results } = await env.DB
          .prepare("SELECT id, nombre, orden FROM dias WHERE alumno_id = ? ORDER BY orden")
          .bind(sesion.id)
          .all();
        return json({ alumno_id: sesion.id, dias: results });
      }

      // --------------------------------------------------------
      //  TODO próximo paso: CRUD de días / bloques / ejercicios / cargas
      // --------------------------------------------------------

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error del servidor", detalle: String(err) }, 500);
    }
  },
};
