// Chat de Claude dentro del gestor (función `chat` de Supabase).
//
// La app manda la conversación hasta ahora y el mensaje nuevo; acá se le pasa todo a Claude con
// las herramientas del gestor, se ejecutan las que pida (con la sesión de la persona: mismas
// barreras que la app) y se devuelven los mensajes nuevos para que la app los sume tal cual.
//
// La clave de la API de Claude vive solo acá, como secreto de Supabase (ANTHROPIC_API_KEY):
// nunca llega al navegador ni al repositorio.
//
// La ruta `…/chat/ahora` es otra cosa: el botón «Ahora» de las tarjetas de escritos (ahora.ts).
// Comparte con el chat la comprobación de quién pide.
import { presentarAhora } from './ahora.ts';
import { Base, ErrorBase } from './base.ts';
import { ErrorClaude, pedirAClaude } from './claude.ts';
import { Contexto, HERRAMIENTAS, ejecutar } from './herramientas.ts';
import { instrucciones } from './instrucciones.ts';
import { ahora } from './util.ts';

const MODELO = Deno.env.get('GESTOR_MODELO') || 'claude-sonnet-5-5';
const URL_CLAUDE = Deno.env.get('ANTHROPIC_URL') || 'https://api.anthropic.com'; // otra solo en las pruebas locales
const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());
const MAX_VUELTAS = 12; // pasos de herramientas por mensaje: corta un ida y vuelta que no termina
const MAX_MENSAJES = 160; // conversación más larga que esto: se pide empezar una nueva
const MAX_TEXTO = 8000;

/** La clave pública del proyecto (la misma de config.js): con ella y la sesión se pide a la API. */
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

/** Que la conversación que manda la app tenga la forma que espera la API (y no traiga otra cosa). */
function historialValido(h: unknown): h is { role: string; content: unknown[] }[] {
  if (!Array.isArray(h) || h.length > MAX_MENSAJES) return false;
  return h.every((m, i) => m && typeof m === 'object' && Array.isArray(m.content) &&
    m.role === (i % 2 === 0 ? 'user' : 'assistant')) && (h.length === 0 || h[h.length - 1].role === 'assistant');
}

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responder({ error: 'metodo', mensaje: 'Solo POST.' }, 405, cors);
  const esAhora = /\/ahora\/?$/.test(new URL(req.url).pathname);

  // 1. Quién pide: la sesión de la app. La base dice si está autorizado (y la puerta de la API
  //    rechaza a quien no lo está antes de cualquier otra cosa). Lo del botón «Ahora» queda
  //    firmado por la persona; lo del chat, como Claude.
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return responder({ error: 'sin_sesion', mensaje: 'Falta iniciar sesión.' }, 401, cors);
  const db = new Base(URL_BASE, clavePublica(), jwt, !esAhora);
  let acceso: any;
  try {
    acceso = await db.rpc('mi_acceso');
  } catch (e) {
    if (e instanceof ErrorBase && (e.status === 401 || /jwt/i.test(e.message))) return responder({ error: 'sin_sesion', mensaje: 'La sesión venció: volvé a ingresar.' }, 401, cors);
    if (e instanceof ErrorBase && e.codigo === '42501') return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar el gestor.' }, 403, cors);
    console.error('mi_acceso:', e);
    return responder({ error: 'base', mensaje: 'No se pudo consultar la base de datos. Probá de nuevo en un momento.' }, 502, cors);
  }
  if (!acceso?.autorizado) return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar el gestor.' }, 403, cors);
  if (acceso.clave_temporal) return responder({ error: 'clave_temporal', mensaje: `Antes de ${esAhora ? 'presentar escritos' : 'usar el chat'}, elegí tu contraseña definitiva.` }, 403, cors);

  if (esAhora) {
    let pedido: any;
    try { pedido = await req.json(); } catch { return responder({ error: 'pedido', mensaje: 'El pedido no se pudo leer.' }, 400, cors); }
    try {
      const r = await presentarAhora(db, pedido, acceso.nombre || acceso.email || 'La persona');
      return responder(r.cuerpo, r.status, cors);
    } catch (e) {
      console.error('ahora:', e);
      return responder({ error: 'base', mensaje: 'No se pudo consultar la base de datos. Probá de nuevo en un momento.' }, 502, cors);
    }
  }

  const clave = Deno.env.get('ANTHROPIC_API_KEY');
  if (!clave) {
    return responder({ error: 'sin_clave', mensaje: 'Falta conectar el chat con la API de Claude: hay que cargar la clave en Supabase (secreto ANTHROPIC_API_KEY).' }, 503, cors);
  }

  // 2. Lo que se pide.
  let pedido: any;
  try { pedido = await req.json(); } catch { return responder({ error: 'pedido', mensaje: 'El pedido no se pudo leer.' }, 400, cors); }
  const texto = String(pedido?.texto ?? '').trim();
  const notas = (Array.isArray(pedido?.notas) ? pedido.notas : []).map((n: unknown) => String(n).trim()).filter(Boolean).slice(0, 10);
  if (!texto) return responder({ error: 'pedido', mensaje: 'Escribí un mensaje.' }, 400, cors);
  if (texto.length > MAX_TEXTO) return responder({ error: 'pedido', mensaje: `El mensaje es demasiado largo (más de ${MAX_TEXTO} caracteres).` }, 400, cors);
  const historial = pedido?.historial ?? [];
  if (Array.isArray(historial) && historial.length > MAX_MENSAJES) return responder({ error: 'larga', mensaje: 'La conversación quedó muy larga. Empezá una nueva.' }, 400, cors);
  if (!historialValido(historial)) return responder({ error: 'pedido', mensaje: 'La conversación guardada no tiene la forma esperada. Empezá una nueva.' }, 400, cors);

  // 3. La conversación con Claude. El mensaje nuevo lleva la fecha y hora de Córdoba (y, si las
  //    hay, las notas de lo que la persona hizo en la app desde el último mensaje).
  const t = ahora();
  const usuario = {
    role: 'user',
    content: [{ type: 'text', text: [`[${t.texto}]`, ...notas.map((n: string) => `[Nota del gestor: ${n}]`), texto].join('\n') }],
  };
  const mensajes: any[] = [...historial, usuario];
  const nuevos: any[] = [usuario];
  const ctx: Contexto = { db, hoy: t, cambios: false, acciones: [], borradores: [] };
  const uso = { entrada: 0, salida: 0, cache_leida: 0, cache_escrita: 0, vueltas: 0 };
  const sistema = instrucciones(acceso.nombre || 'Emi');

  try {
    for (let vuelta = 1; ; vuelta++) {
      const r = await pedirAClaude({
        model: MODELO, max_tokens: 8000, system: sistema, tools: HERRAMIENTAS, messages: mensajes,
        thinking: { type: 'between_tools' }, output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral' },
      }, { clave, url: URL_CLAUDE });
      uso.vueltas = vuelta;
      uso.entrada += r.usage?.input_tokens || 0; uso.salida += r.usage?.output_tokens || 0;
      uso.cache_leida += r.usage?.cache_read_input_tokens || 0; uso.cache_escrita += r.usage?.cache_creation_input_tokens || 0;
      const asistente = { role: 'assistant', content: r.content };
      mensajes.push(asistente); nuevos.push(asistente);
      const pedidas = (r.content || []).filter((b: any) => b.type === 'tool_use');
      if (r.stop_reason !== 'tool_use' || !pedidas.length) break;

      const resultados: any[] = [];
      if (vuelta >= MAX_VUELTAS) {
        for (const b of pedidas) resultados.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Se llegó al máximo de pasos para un mensaje: no se hizo.' });
        nuevos.push({ role: 'user', content: resultados });
        nuevos.push({ role: 'assistant', content: [{ type: 'text', text: 'Me quedé sin pasos para este pedido. Lo que alcancé a hacer está anotado abajo; decime cómo seguimos.' }] });
        break;
      }
      for (const b of pedidas) resultados.push(await ejecutar(b, ctx)); // de a uno: algunos dependen del anterior
      const respuesta = { role: 'user', content: resultados };
      mensajes.push(respuesta); nuevos.push(respuesta);
    }
  } catch (e) {
    const mensaje = e instanceof ErrorClaude ? e.message : 'Algo falló al hablar con Claude.';
    console.error('claude:', e instanceof ErrorClaude ? `${e.status} ${e.tipo}` : '', e);
    // Nada llegó a pasar: la app conserva el mensaje para reintentar.
    if (nuevos.length === 1) return responder({ error: e instanceof ErrorClaude && e.tipo === 'red' ? 'red' : 'claude', mensaje }, 502, cors);
    // Hubo pasos completos (quizá con cambios): se devuelven, con un cierre que lo explica.
    nuevos.push({ role: 'assistant', content: [{ type: 'text', text: `Se cortó la respuesta: ${mensaje}` }] });
    return responder({ nuevos, cambios: ctx.cambios, acciones: ctx.acciones, borradores: ctx.borradores, aviso: mensaje }, 200, cors);
  }

  console.log(JSON.stringify({ chat: 'ok', modelo: MODELO, ...uso, cambios: ctx.cambios }));
  return responder({ nuevos, cambios: ctx.cambios, acciones: ctx.acciones, borradores: ctx.borradores }, 200, cors);
}

Deno.serve(manejar);
