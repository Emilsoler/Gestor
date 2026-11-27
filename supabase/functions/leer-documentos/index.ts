// Lectura de los documentos de una solicitud de crédito (función `leer-documentos` de Supabase).
//
// Solo para la Mutual: la app de Créditos y Cobros (botón «Leer título y DNI de los documentos», al generar la prenda)
// manda { id } con la solicitud; la función baja sus PDF y fotos, se los da a Claude para que transcriba el título del
// automotor y el DNI, y devuelve esos datos ya controlados (leer.js). La persona los revisa antes de imprimir.
//
// Es una función aparte de `agencias` a propósito: la usan las agencias todos los días y esto es una ayuda de la Mutual.
// No guarda nada. En los registros no queda contenido de los documentos, solo el estado de las respuestas.
//
// Permisos: la sesión de la persona (mismas barreras que la app: `mi_acceso`) y la solicitud se lee con esa sesión, así que
// vale la regla de acceso de la tabla. La clave de servicio se usa SOLO para pedir enlaces temporales a los archivos que
// esa solicitud trae (la carpeta `solicitudes` del almacenamiento no tiene políticas). Secreto: ANTHROPIC_API_KEY.
import { INSTRUCCIONES, SIN_DATOS, bloquesDelPedido, elegirArchivos, extraerJson, limpiarLectura } from './leer.js';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const CLAVE_SERVICIO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const URL_CLAUDE = (Deno.env.get('ANTHROPIC_URL') || 'https://api.anthropic.com').replace(/\/+$/, ''); // otra solo en las pruebas locales
const MODELO = Deno.env.get('AGENCIAS_LECTURA_MODELO') || 'claude-sonnet-5-5'; // lee fotos de documentos: acá conviene el más preciso
const CARPETA = 'solicitudes';
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());

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

const esUuid = (x: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x ?? ''));

/** Una consulta a la API de la base con la sesión de la persona. */
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

/** Un enlace para bajar el archivo, que vence a los 5 minutos (con la clave de servicio: la carpeta no tiene políticas). */
async function enlace(path: string): Promise<string | null> {
  const r = await fetch(`${URL_BASE}/storage/v1/object/sign/${CARPETA}/${path}`, {
    method: 'POST', headers: { apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}`, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const u = String(d?.signedURL ?? d?.signedUrl ?? '');
  return u ? `${URL_BASE}/storage/v1${u.startsWith('/') ? '' : '/'}${u}` : null;
}

function base64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Le pide a Claude que transcriba los documentos. El JSON crudo, o null si no se pudo (sin clave, sin crédito, saturado…). */
async function leerConClaude(archivos: { nombre: string; tipo: string; base64: string }[]): Promise<{ crudo?: unknown; error?: string }> {
  const clave = Deno.env.get('ANTHROPIC_API_KEY') || '';
  if (!clave) return { error: 'sin_clave' };
  const cuerpo = JSON.stringify({ model: MODELO, max_tokens: 1200, system: INSTRUCCIONES, messages: [{ role: 'user', content: bloquesDelPedido(archivos) }] });
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(`${URL_CLAUDE}/v1/messages`, {
        method: 'POST', headers: { 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: cuerpo, signal: AbortSignal.timeout(90_000),
      });
      if (r.ok) {
        const d = await r.json();
        const t = (Array.isArray(d?.content) ? d.content : []).filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join('\n');
        const crudo = extraerJson(t);
        return crudo ? { crudo } : { error: 'ilegible' };
      }
      // Sin el detalle (podría llevar texto de los documentos): solo el estado y el tipo de error.
      let tipo = ''; try { tipo = String((await r.json())?.error?.type || ''); } catch { /* sin cuerpo */ }
      console.error(JSON.stringify({ lectura: 'claude', status: r.status, tipo }));
      if (!(r.status === 429 || r.status === 529 || r.status >= 500) || intento) return { error: 'api' };
    } catch {
      console.error(JSON.stringify({ lectura: 'claude', status: 0 }));
      if (intento) return { error: 'api' };
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return { error: 'api' };
}

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return falla('metodo', 'Solo POST.', 405, cors);

  // 1. Quién pide: la sesión de la app, autorizada en la base (como en la función `bcra`).
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return falla('sin_sesion', 'Falta iniciar sesión.', 401, cors);
  const acceso = await base(jwt, 'rpc/panel_acceso', {}).catch(() => null);
  if (!acceso) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
  if (acceso.status === 401 || /jwt/i.test(String(acceso.datos?.message || ''))) return falla('sin_sesion', 'La sesión venció: volvé a ingresar.', 401, cors);
  if (acceso.codigo === '42501' || (acceso.ok && !acceso.datos?.autorizado)) return falla('sin_acceso', 'Esta cuenta no está autorizada para usar la app.', 403, cors);
  if (!acceso.ok) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
  if (acceso.datos?.clave_temporal) return falla('clave_temporal', 'Antes de seguir, elegí tu contraseña definitiva.', 403, cors);

  // 2. Qué pide: la solicitud, leída con la sesión de la persona.
  let pedido: any;
  try { pedido = await req.json(); } catch { return falla('pedido', 'El pedido no se pudo leer.', 400, cors); }
  if (!esUuid(pedido?.id)) return falla('pedido', 'Falta la solicitud.', 400, cors);
  const s = await base(jwt, `solicitudes_credito?id=eq.${pedido.id}&select=archivos`);
  if (!s.ok) return falla('base', 'No se pudo leer la solicitud.', 502, cors);
  if (!Array.isArray(s.datos) || !s.datos.length) return falla('sin_solicitud', 'No se encontró la solicitud.', 404, cors);

  // 3. Los archivos: solo los de esa solicitud, con enlaces que vencen enseguida.
  const { usar, omitidos } = elegirArchivos(s.datos[0]?.archivos);
  if (!usar.length) return falla('sin_archivos', 'Esta solicitud no tiene fotos ni PDF para leer. Cargá los datos a mano.', 400, cors);
  const listos: { nombre: string; tipo: string; base64: string }[] = [];
  for (const x of usar) {
    const u = await enlace(String(x.path));
    const f = u ? await fetch(u).catch(() => null) : null;
    if (!f || !f.ok) continue;
    listos.push({ nombre: String(x.nombre || ''), tipo: String(x.tipo), base64: base64(new Uint8Array(await f.arrayBuffer())) });
  }
  if (!listos.length) return falla('almacen', 'No se pudieron abrir los documentos. Probá de nuevo en un momento.', 502, cors);

  // 4. La lectura, con el control de cada dato.
  const inicio = Date.now();
  const l = await leerConClaude(listos);
  if (l.error === 'sin_clave') return falla('sin_clave', 'La lectura automática no está habilitada todavía. Cargá los datos a mano.', 503, cors);
  if (l.error === 'ilegible') return falla('lectura', 'No se pudo interpretar la lectura. Probá de nuevo o cargá los datos a mano.', 502, cors);
  if (!l.crudo) return falla('lectura', 'No se pudo leer ahora. Probá de nuevo en un momento o cargá los datos a mano.', 502, cors);
  const lectura = limpiarLectura(l.crudo);
  console.log(JSON.stringify({ lectura: 'ok', ms: Date.now() - inicio, archivos: listos.length, titulo: !!lectura.titulo, dni: !!lectura.dni }));
  if (!lectura.titulo && !lectura.dni) return falla('sin_datos', SIN_DATOS, 422, cors);
  return responder({ ...lectura, leidos: listos.length, omitidos }, 200, cors);
}

Deno.serve(manejar);
