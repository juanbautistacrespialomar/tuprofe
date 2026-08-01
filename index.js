// ============================================================
//  COACH APP · Worker (la API que corre en Cloudflare)
// ------------------------------------------------------------
//  Este archivo es el cimiento: maneja el LOGIN por código y
//  resuelve el ROL de quien entra (admin / profe / alumno).
//  Los endpoints de rutinas (días, bloques, ejercicios, cargas)
//  se agregan en el próximo paso sobre esta misma base.
// ============================================================

// --- CORS: durante desarrollo el front puede estar en otro dominio.
//     En producción, si servís el front desde Cloudflare Pages en el
//     mismo dominio, casi ni lo vas a necesitar, pero no molesta.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Helper para responder JSON siempre con los headers de CORS.
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Genera un código tipo "ALU-9F3M" o "PROF-X7K2".
// Sin caracteres confusos (0/O, 1/I) para que sea fácil de dictar.
function genCodigo(prefijo) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return `${prefijo}-${s}`;
}

// ------------------------------------------------------------
//  resolverRol: el corazón del sistema de acceso.
//  Recibe un código y averigua QUIÉN es.
//  Devuelve { rol, id, profeId } o null si el código no existe.
// ------------------------------------------------------------
async function resolverRol(codigo, env) {
  if (!codigo) return null;

  // 1) ¿Es el admin? (el código vive como secret, no en la base)
  if (codigo === env.ADMIN_CODE) {
    return { rol: "admin", id: 0, profeId: null };
  }

  // 2) ¿Es un profe?
  const profe = await env.DB
    .prepare("SELECT id FROM profesores WHERE codigo_acceso = ?")
    .bind(codigo)
    .first();
  if (profe) {
    return { rol: "profe", id: profe.id, profeId: profe.id };
  }

  // 3) ¿Es un alumno?
  const alumno = await env.DB
    .prepare("SELECT id, profe_id FROM alumnos WHERE codigo_acceso = ?")
    .bind(codigo)
    .first();
  if (alumno) {
    return { rol: "alumno", id: alumno.id, profeId: alumno.profe_id };
  }

  // 4) No existe
  return null;
}

// Saca el código del header Authorization ("Bearer PROF-XXXX" o directo).
function codigoDelHeader(request) {
  const h = request.headers.get("Authorization") || "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

// ============================================================
//  ROUTER
// ============================================================
export default {
  async fetch(request, env) {
    // Preflight de CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // --------------------------------------------------------
      //  POST /login  { codigo }
      //  Única ruta pública. Devuelve el rol para que el front
      //  sepa qué vista mostrar.
      // --------------------------------------------------------
      if (path === "/login" && method === "POST") {
        const { codigo } = await request.json();
        const sesion = await resolverRol(codigo, env);
        if (!sesion) return json({ error: "Código inválido" }, 401);
        return json(sesion);
      }

      // --------------------------------------------------------
      //  De acá para abajo, TODO requiere código válido.
      //  Resolvemos el rol una sola vez y lo reusamos.
      // --------------------------------------------------------
      const sesion = await resolverRol(codigoDelHeader(request), env);
      if (!sesion) return json({ error: "No autorizado" }, 401);

      // ========================================================
      //  ADMIN: crear profes
      // ========================================================
      if (path === "/profes" && method === "POST") {
        if (sesion.rol !== "admin") return json({ error: "Solo admin" }, 403);
        const { nombre } = await request.json();
        if (!nombre) return json({ error: "Falta el nombre" }, 400);

        const codigo = genCodigo("PROF");
        const r = await env.DB
          .prepare("INSERT INTO profesores (nombre, codigo_acceso) VALUES (?, ?)")
          .bind(nombre, codigo)
          .run();

        return json({ id: r.meta.last_row_id, nombre, codigo_acceso: codigo }, 201);
      }

      if (path === "/profes" && method === "GET") {
        if (sesion.rol !== "admin") return json({ error: "Solo admin" }, 403);
        const { results } = await env.DB
          .prepare("SELECT id, nombre, codigo_acceso, creado FROM profesores ORDER BY creado DESC")
          .all();
        return json(results);
      }

      // ========================================================
      //  PROFE: gestionar SUS alumnos (aislamiento por profe_id)
      // ========================================================
      if (path === "/alumnos" && method === "GET") {
        if (sesion.rol !== "profe") return json({ error: "Solo profe" }, 403);
        const { results } = await env.DB
          .prepare(`SELECT id, nombre, codigo_acceso, objetivo, creado
                    FROM alumnos WHERE profe_id = ? ORDER BY nombre`)
          .bind(sesion.profeId)               // <- clave del multi-tenant
          .all();
        return json(results);
      }

      if (path === "/alumnos" && method === "POST") {
        if (sesion.rol !== "profe") return json({ error: "Solo profe" }, 403);
        const { nombre, fecha_nac, objetivo, observaciones } = await request.json();
        if (!nombre) return json({ error: "Falta el nombre" }, 400);

        const codigo = genCodigo("ALU");
        const r = await env.DB
          .prepare(`INSERT INTO alumnos (profe_id, nombre, codigo_acceso, fecha_nac, objetivo, observaciones)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(sesion.profeId, nombre, codigo, fecha_nac || null, objetivo || null, observaciones || null)
          .run();

        // Devolvemos el código para que el profe se lo pase al alumno
        return json({ id: r.meta.last_row_id, nombre, codigo_acceso: codigo }, 201);
      }

      // ========================================================
      //  ALUMNO: ver su propia rutina
      //  (por ahora devuelve el esqueleto; los días/bloques/ejercicios
      //   se llenan en el próximo paso)
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
      //  TODO próximo paso:
      //    POST/PUT/DELETE  /dias  /bloques  /ejercicios
      //    POST /cargas   ·  GET /mis-cargas  ·  GET /alumnos/:id/cargas
      // --------------------------------------------------------

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error del servidor", detalle: String(err) }, 500);
    }
  },
};
