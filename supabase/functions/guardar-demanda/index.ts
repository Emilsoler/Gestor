// Guardar en Drive los archivos de una demanda (función `guardar-demanda` de Supabase).
//
// Solo para el estudio: «Hacer demanda» de «Nueva causa» manda { carpeta, archivos: [{ nombre, tipo, base64 }] } (los PDF que
// se adjuntaron, el Word y la demanda en PDF con firma). La función se los pasa al «puente» de Drive del estudio (un
// Google Apps Script que vive en la cuenta de Drive de la persona, ver dev/drive-puente.gs): el puente busca la carpeta
// del demandado en «J01. Asociacion Mutual Bell / EN TRÁMITE», la crea si no está y guarda ahí los archivos.
//
// La app es una página web y no puede escribir en Drive por sí sola; por eso el puente. La dirección del puente y su clave
// son secretos de esta función (DRIVE_PUENTE_URL y DRIVE_PUENTE_CLAVE): no están en el repositorio (es público).
// No se guarda nada en la base y en los registros no queda el nombre del demandado ni el contenido de los archivos.
// Permisos: la sesión de la persona (mismas barreras que la app: `mi_acceso`).
const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());
const MAX_ARCHIVOS = 20;
const MAX_BYTES = 40 * 1024 * 1024; // lo que se manda al puente en total (los PDF ya vienen achicados)

function clavePublica() {
  try {
    const claves = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    if (claves.default) return String(claves.default);
  } catch { /* formato viejo: abajo */ }
  return Deno.env.get('SUPABASE_ANON_KEY') || '';
}

function cabeceras(req: Request) {
  const origen = req.headers.get('origin') || '';
  return {
    ...(ORIGENES.includes(origen) ? { 'access-control-allow-origin': origen, vary: 'origin' } : {}),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-max-age': '600',
  };
}

type Cors = Record<string, string>;
const responder = (cuerpo: unknown, status: number, cors: Cors) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });
const falla = (error: string, mensaje: string, status: number, cors: Cors) => responder({ error, mensaje }, status, cors);

async function base(jwt: string, ruta: string, cuerpo?: unknown) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    method: cuerpo === undefined ? 'GET' : 'POST',
    headers: { apikey: clavePublica(), authorization: `Bearer ${jwt}`, accept: 'application/json', 'content-type': 'application/json' },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  const texto = await r.text();
  let datos: any = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* no es JSON */ }
  return { ok: r.ok, status: r.status, datos, codigo: String(datos?.code || '') };
}

/** Un nombre de carpeta o de archivo sin lo que Drive o el sistema no aceptan, y sin pasar de 120 letras. */
export const limpiarNombre = (s: unknown) =>
  String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Los archivos del pedido, controlados: nombre, tipo permitido y base64 sano. */
export function elegirArchivos(lista: unknown) {
  const tipos = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
  const usar: { nombre: string; tipo: string; base64: string }[] = [];
  let bytes = 0;
  for (const a of Array.isArray(lista) ? lista : []) {
    const nombre = limpiarNombre(a?.nombre), tipo = String(a?.tipo ?? ''), b64 = String(a?.base64 ?? '');
    if (!nombre || !tipos.has(tipo) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
    bytes += Math.floor(b64.length * 0.75);
    if (usar.length >= MAX_ARCHIVOS || bytes > MAX_BYTES) break;
    usar.push({ nombre, tipo, base64: b64 });
  }
  return usar;
}

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return falla('metodo', 'Solo POST.', 405, cors);

  // 1. Quién pide (igual que en `leer-demanda`).
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return falla('sin_sesion', 'Falta iniciar sesión.', 401, cors);
  const acceso = await base(jwt, 'rpc/mi_acceso', {}).catch(() => null);
  if (!acceso) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
  if (acceso.status === 401 || /jwt/i.test(String(acceso.datos?.message || ''))) return falla('sin_sesion', 'La sesión venció: volvé a ingresar.', 401, cors);
  if (acceso.codigo === '42501' || (acceso.ok && !acceso.datos?.autorizado)) return falla('sin_acceso', 'Esta cuenta no está autorizada para usar la app.', 403, cors);
  if (!acceso.ok) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
  if (acceso.datos?.clave_temporal) return falla('clave_temporal', 'Antes de seguir, elegí tu contraseña definitiva.', 403, cors);

  // 2. Qué pide.
  let pedido: any;
  try { pedido = await req.json(); } catch { return falla('pedido', 'El pedido no se pudo leer.', 400, cors); }
  const carpeta = limpiarNombre(pedido?.carpeta);
  const archivos = elegirArchivos(pedido?.archivos);
  if (!carpeta) return falla('pedido', 'Falta el nombre del demandado para la carpeta.', 400, cors);
  if (!archivos.length) return falla('sin_archivos', 'No hay archivos para guardar (o pesan demasiado).', 400, cors);

  // 3. El puente de Drive.
  const url = Deno.env.get('DRIVE_PUENTE_URL') || '', clave = Deno.env.get('DRIVE_PUENTE_CLAVE') || '';
  if (!url || !clave) return falla('sin_configurar', 'Drive todavía no está conectado a la app.', 503, cors);
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ clave, carpeta, archivos }), redirect: 'follow', signal: AbortSignal.timeout(110_000) });
  } catch {
    console.error(JSON.stringify({ drive: 'sin_respuesta' }));
    return falla('puente', 'No se pudo hablar con Drive. Probá de nuevo en un momento.', 502, cors);
  }
  let d: any = null;
  try { d = await r.json(); } catch { /* el puente devolvió otra cosa (página de error de Google) */ }
  console.log(JSON.stringify({ drive: d?.ok ? 'ok' : 'error', status: r.status, archivos: archivos.length, error: d?.error || '' }));
  if (!d?.ok) {
    if (d?.error === 'clave') return falla('puente_clave', 'La clave del puente de Drive no coincide. Hay que revisar la conexión.', 502, cors);
    return falla('puente', 'Drive no aceptó los archivos. Probá de nuevo o subilos a mano.', 502, cors);
  }
  return responder({ ok: true, carpeta: String(d.carpeta || carpeta), url: String(d.url || ''), creada: !!d.creada, guardados: Array.isArray(d.guardados) ? d.guardados : [] }, 200, cors);
}

Deno.serve(manejar);
