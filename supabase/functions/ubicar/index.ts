// Ubicar un vehículo prendado (función `ubicar` de Supabase).
//
// La app manda {vehiculo_id, motivo, nota}. Acá se verifica la sesión (con la base: mismas barreras
// que la app), se controla que el vehículo tenga el consentimiento del tomador registrado, se pide la
// posición al equipo GPS a través de Traccar (o se simula, mientras no haya equipo) y se deja
// constancia en public.ubicaciones con la sesión de quien consulta. Devuelve la constancia guardada.
//
// No usa ninguna clave secreta de la base: la usa con la sesión de la persona. Si hay servidor de
// rastreo, su dirección y su credencial van en los secretos TRACCAR_URL y TRACCAR_TOKEN de la función.
import { codigoControl, ErrorTraccar, type Pos, posicionTraccar, referencia, simular } from './traccar.ts';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const TRACCAR_URL = Deno.env.get('TRACCAR_URL') || '';
const TRACCAR_TOKEN = Deno.env.get('TRACCAR_TOKEN') || '';
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());
const BASE_DEFECTO: [number, number] = [-32.6259, -62.6887]; // Bell Ville

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
const responder = (cuerpo: unknown, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

class ErrorBase extends Error {
  constructor(mensaje: string, public status: number, public codigo: string) { super(mensaje); }
}

/** La API de la base (PostgREST) con la sesión de la persona. */
async function base(metodo: string, jwt: string, ruta: string, cuerpo?: unknown, prefer = '') {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    method: metodo,
    headers: {
      apikey: clavePublica(), authorization: `Bearer ${jwt}`, accept: 'application/json',
      ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(prefer ? { prefer } : {}),
    },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let datos: any = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* no es JSON: va en el error */ }
  if (!r.ok) throw new ErrorBase(datos?.message || texto.slice(0, 200) || `La base respondió ${r.status}`, r.status, datos?.code || '');
  return datos;
}

const MOTIVOS = new Set([
  'Control de la garantía por mora', 'Diligencia de secuestro ordenada', 'Alerta del equipo',
  'Pedido del deudor por robo o extravío', 'Otro motivo',
]);

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responder({ error: 'metodo', mensaje: 'Solo POST.' }, 405, cors);

  // 1. Quién pide: la sesión de la app.
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return responder({ error: 'sin_sesion', mensaje: 'Falta iniciar sesión.' }, 401, cors);
  let acceso: any;
  try {
    acceso = await base('POST', jwt, 'rpc/mi_acceso', {});
  } catch (e) {
    if (e instanceof ErrorBase && (e.status === 401 || /jwt/i.test(e.message))) return responder({ error: 'sin_sesion', mensaje: 'La sesión venció: volvé a ingresar.' }, 401, cors);
    if (e instanceof ErrorBase && e.codigo === '42501') return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
    console.error('mi_acceso:', e);
    return responder({ error: 'base', mensaje: 'No se pudo consultar la base de datos. Probá de nuevo en un momento.' }, 502, cors);
  }
  if (!acceso?.autorizado) return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
  if (acceso.clave_temporal) return responder({ error: 'clave_temporal', mensaje: 'Antes de ubicar, elegí tu contraseña definitiva.' }, 403, cors);

  // 2. El pedido.
  let pedido: any;
  try { pedido = await req.json(); } catch { return responder({ error: 'pedido', mensaje: 'El pedido no se pudo leer.' }, 400, cors); }
  const id = String(pedido?.vehiculo_id || '');
  const motivo = String(pedido?.motivo || '').trim();
  const nota = String(pedido?.nota || '').trim().slice(0, 500);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return responder({ error: 'pedido', mensaje: 'Falta indicar el vehículo.' }, 400, cors);
  if (!MOTIVOS.has(motivo)) return responder({ error: 'motivo', mensaje: 'Falta elegir un motivo válido para la consulta.' }, 400, cors);
  if (motivo === 'Otro motivo' && !nota) return responder({ error: 'motivo', mensaje: 'Para «Otro motivo» hace falta una nota.' }, 400, cors);

  // 3. El vehículo y su consentimiento.
  let veh: any;
  try {
    const filas = await base('GET', jwt, `vehiculos?id=eq.${id}&select=*&limit=1`);
    veh = Array.isArray(filas) ? filas[0] : null;
  } catch (e) {
    if (e instanceof ErrorBase && e.codigo === '42501') return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
    console.error('leer vehiculo:', e);
    return responder({ error: 'base', mensaje: 'No se pudo leer el vehículo. Probá de nuevo.' }, 502, cors);
  }
  if (!veh) return responder({ error: 'no_vehiculo', mensaje: 'Ese vehículo no existe o fue eliminado.' }, 404, cors);
  if (!veh.consentimiento) return responder({ error: 'sin_consentimiento', mensaje: 'Falta registrar el consentimiento del tomador: sin eso no se puede ubicar el vehículo.' }, 403, cors);

  // 4. La posición: Traccar si hay equipo vinculado y servidor configurado; si no, simulada.
  let pos: Pos;
  const conTraccar = !!TRACCAR_TOKEN && !!TRACCAR_URL && !!veh.traccar_id;
  if (conTraccar) {
    try {
      pos = await posicionTraccar({ url: TRACCAR_URL, token: TRACCAR_TOKEN }, veh.traccar_id);
    } catch (e) {
      const err = e instanceof ErrorTraccar ? e : new ErrorTraccar(String(e), 'traccar');
      console.error(JSON.stringify({ ubicar: 'traccar', tipo: err.tipo }));
      const st = err.tipo === 'sin_posicion' ? 404 : err.tipo === 'red' ? 504 : 502;
      return responder({ error: `traccar_${err.tipo}`, mensaje: err.message }, st, cors);
    }
  } else {
    pos = simular(veh.sim, BASE_DEFECTO);
  }

  // 5. La constancia.
  const ref = referencia(pos.lat, pos.lon);
  const lat = pos.lat.toFixed(5), lon = pos.lon.toFixed(5);
  const textoConst = [
    'CONSTANCIA DE UBICACION DEL BIEN PRENDADO',
    `Vehiculo: ${veh.marca} ${veh.modelo} ${veh.anio || ''} dominio ${veh.dominio}`,
    `Deudor: ${veh.deudor}`,
    `Operacion: ${veh.operacion}`,
    `Coordenadas: ${lat}, ${lon} (WGS84)`,
    `Referencia: ${ref}`,
    `Reporte del equipo: ${pos.momento}`,
    `Motivo: ${motivo}${nota ? ' (' + nota + ')' : ''}`,
    `Consultado: ${new Date().toISOString()}`,
  ].join('\n');
  const codigo = await codigoControl(textoConst);

  const resultado = {
    lat: pos.lat, lon: pos.lon, referencia: ref, momento_reporte: pos.momento, origen: pos.origen,
    velocidad: pos.velocidad, rumbo: pos.rumbo, motor: pos.motor, bateria: pos.bateria, senal: pos.senal,
  };
  let fila: any;
  try {
    [fila] = await base('POST', jwt, 'ubicaciones?select=*', {
      vehiculo: veh.id, dominio: veh.dominio, deudor: veh.deudor, motivo, nota, exito: true, resultado, codigo,
    }, 'return=representation');
  } catch (e) {
    console.error('guardar ubicacion:', e instanceof ErrorBase ? `${e.status} ${e.codigo} ${e.message}` : e);
    if (e instanceof ErrorBase && e.codigo === '42501') return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
    return responder({ error: 'base', mensaje: 'Se obtuvo la ubicación, pero la constancia no se pudo guardar. Probá de nuevo.' }, 502, cors);
  }

  console.log(JSON.stringify({ ubicar: 'ok', origen: pos.origen }));
  return responder({ ubicacion: fila }, 200, cors);
}

Deno.serve(manejar);
