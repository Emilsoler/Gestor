// Venta de mostrador del panel máster (docs/agencias/master/): guarda en la carpeta privada `solicitudes` los documentos
// (opcionales) de un crédito que la Mutual aprobó sin agencia (public.mostrador_aprobar). Un archivo por pedido, en un
// formulario (multipart) con `id` y `archivo`. Solo PDF o JPEG de hasta 10 MB, mirando los primeros bytes.
//
// Permisos: la sesión de la persona (`panel_acceso`: miembro o cuenta máster) y la solicitud se lee con esa sesión. La
// carpeta no tiene políticas: se escribe con la clave de servicio. Para verlos se usa la función `agencias`.
// En los registros no queda ningún dato del cliente.
const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const CLAVE_SERVICIO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());
const MOSTRADOR = '00000000-0000-0000-0000-000000000000';
const MAX_BYTES = 10 * 1024 * 1024;

function clavePublica() {
  try {
    const claves = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    if (claves.default) return String(claves.default);
  } catch { /* formato viejo: abajo */ }
  return Deno.env.get('SUPABASE_ANON_KEY') || '';
}

function cabeceras(req: Request): Record<string, string> {
  const origen = req.headers.get('origin') || '';
  return {
    ...(ORIGENES.includes(origen) ? { 'access-control-allow-origin': origen, vary: 'origin' } : {}),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-max-age': '600',
  };
}

const responder = (cuerpo: unknown, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const falla = (error: string, mensaje: string, status: number, cors: Record<string, string>) => responder({ error, mensaje }, status, cors);

/** PDF o JPEG según los primeros bytes (el nombre y el tipo que dice el navegador no cuentan). */
function tipoDe(b: Uint8Array) {
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { tipo: 'application/pdf', ext: 'pdf' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { tipo: 'image/jpeg', ext: 'jpg' };
  return null;
}

const conClave = { apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}` };
const objeto = (ruta: string) => `${URL_BASE}/storage/v1/object/solicitudes${ruta}`;

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return falla('metodo', 'Solo POST.', 405, cors);
  try {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return falla('sin_sesion', 'Falta iniciar sesión.', 401, cors);
    const sesion = { apikey: clavePublica(), authorization: `Bearer ${jwt}`, accept: 'application/json', 'content-type': 'application/json' };
    const a = await fetch(`${URL_BASE}/rest/v1/rpc/panel_acceso`, { method: 'POST', headers: sesion, body: '{}' });
    if (a.status === 401) return falla('sin_sesion', 'La sesión venció: volvé a ingresar.', 401, cors);
    const acceso = await a.json().catch(() => null);
    if (a.status === 403 || (a.ok && !acceso?.autorizado)) return falla('sin_acceso', 'Esta cuenta no está autorizada.', 403, cors);
    if (!a.ok) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
    if (acceso.clave_temporal) return falla('clave_temporal', 'Antes de seguir, elegí tu contraseña definitiva.', 403, cors);

    let form: FormData;
    try { form = await req.formData(); } catch { return falla('pedido', 'El archivo no se pudo leer. Probá de nuevo.', 400, cors); }
    const id = String(form.get('id') || ''), f = form.get('archivo');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !(f instanceof File)) return falla('pedido', 'Falta el archivo.', 400, cors);
    const nombre = String(f.name || 'archivo').replace(/[\\/\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'archivo';
    if (!f.size) return falla('vacio', `«${nombre}» está vacío.`, 400, cors);
    if (f.size > MAX_BYTES) return falla('tamano', `«${nombre}» pesa más de 10 MB. Mandalo más liviano.`, 413, cors);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const t = tipoDe(bytes);
    if (!t) return falla('tipo', `«${nombre}» no es un PDF ni una foto JPG.`, 415, cors);

    const s = await fetch(`${URL_BASE}/rest/v1/solicitudes_credito?id=eq.${id}&agencia_id=eq.${MOSTRADOR}&select=id`, { headers: sesion });
    const filas = s.ok ? await s.json().catch(() => []) : null;
    if (!filas) return falla('base', 'No se pudo leer la solicitud.', 502, cors);
    if (!filas.length) return falla('solicitud', 'No se encontró ese crédito de mostrador.', 404, cors);
    const u = await fetch(`${URL_BASE}/auth/v1/user`, { headers: sesion });
    const uid = u.ok ? String((await u.json())?.id || '') : '';
    if (!uid) return falla('sin_sesion', 'La sesión venció: volvé a ingresar.', 401, cors);

    const path = `${id}/documentacion-${crypto.randomUUID().slice(0, 8)}.${t.ext}`;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const subida = await fetch(objeto(`/${path}`), { method: 'POST', headers: { ...conClave, 'content-type': t.tipo, 'x-upsert': 'false' }, body: bytes });
    if (!subida.ok) return falla('almacen', 'No se pudo guardar el archivo. Probá de nuevo en un momento.', 502, cors);
    const g = await fetch(`${URL_BASE}/rest/v1/rpc/mostrador_archivo`, {
      method: 'POST', headers: { ...conClave, 'content-type': 'application/json' },
      body: JSON.stringify({ p_user: uid, p_id: id, p_archivo: { slot: 'documentacion', nombre, path, tipo: t.tipo, tamano: bytes.length, sha256 } }),
    });
    const r = g.ok ? await g.json().catch(() => null) : null;
    if (!r?.ok) {
      await fetch(`${URL_BASE}/storage/v1/object/solicitudes`, { method: 'DELETE', headers: { ...conClave, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }) }).catch(() => {});
      return falla('base', 'No se pudo anotar el archivo en el crédito.', 502, cors);
    }
    return responder({ ok: true }, 200, cors);
  } catch (e) {
    console.error('mostrador:', (e as Error)?.name);
    return falla('red', 'No se pudo guardar el archivo. Probá de nuevo en un momento.', 502, cors);
  }
}

Deno.serve(manejar);
