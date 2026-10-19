// Botón «Ahora» de la app (ruta `ahora` de esta función): el escrito se presenta en el SAC en el
// momento, sin esperar a la corrida de las 10:15. Ver supabase/migrations/0006.
//
// 1. Se confirma el escrito con la sesión de la persona, que queda como quien lo confirmó (igual
//    que con "Agendar"): pendiente, con fecha de hoy y la hora del pedido en `ahora`.
// 2. Se dispara la tarea programada que presenta en el SAC, por su API. Esa corrida toma solo lo
//    pedido «Ahora» (gestor.agenda_tomar(true)). El token vive acá, como secreto de Supabase
//    (TAREA_SAC_TOKEN): nunca llega al navegador ni al repositorio.
// 3. Si la tarea no arranca, el escrito vuelve al estado y la fecha que tenía: nada queda agendado
//    para otro momento sin que la persona lo sepa. Lo corregido en la tarjeta de un borrador queda
//    guardado en el borrador, para no perderlo.
import { Base, ErrorBase } from './base.ts';
import { ahora as horaDeCordoba } from './util.ts';

// La tarea programada "Presentar escritos agendados en el SAC" (claude.ai/code/routines). Otra
// dirección solo para las pruebas locales, o si la tarea se vuelve a crear.
const URL_TAREA = Deno.env.get('TAREA_SAC_URL') ||
  'https://api.anthropic.com/v1/claude_code/routines/trig_01EX9sLZMbvqDtgqTNJFGTg5/fire';
const ABIERTOS = ['borrador', 'pendiente', 'error']; // lo que todavía se puede mandar a presentar
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CERRADOS: Record<string, string> = {
  presentando: 'Ese escrito ya se está presentando en el SAC.',
  presentado: 'Ese escrito ya se presentó en el SAC.',
  cancelado: 'Ese escrito está cancelado: no se presenta.',
};

export type Resultado = { status: number; cuerpo: Record<string, unknown> };
const falla = (status: number, error: string, mensaje: string, fila?: unknown): Resultado =>
  ({ status, cuerpo: { error, mensaje, ...(fila !== undefined ? { fila } : {}) } });

/** `pedido`: { id, rev } del escrito y, si es un borrador, lo que dice la tarjeta (titulo, cuerpo, realizar). */
export async function presentarAhora(db: Base, pedido: any, quien: string): Promise<Resultado> {
  const id = String(pedido?.id ?? '').trim(), rev = Number(pedido?.rev);
  if (!UUID.test(id) || !Number.isSafeInteger(rev)) return falla(400, 'pedido', 'Falta indicar qué escrito presentar.');
  const token = Deno.env.get('TAREA_SAC_TOKEN') || '';
  if (!token) {
    return falla(503, 'sin_token', 'Falta conectar el botón «Ahora» con la tarea que presenta en el SAC: hay que cargar su token en Supabase (secreto TAREA_SAC_TOKEN). El escrito quedó como estaba.');
  }

  const [antes] = await db.leer('agenda', `id=eq.${id}&select=*`);
  if (!antes) return falla(404, 'no_existe', 'Ese escrito ya no está en la agenda.');
  if (!ABIERTOS.includes(antes.estado)) return falla(409, 'estado', CERRADOS[antes.estado] || 'Ese escrito ya no se puede presentar.', antes);
  if (antes.rev !== rev) return falla(409, 'conflicto', 'El escrito cambió recién. Revisalo y probá de nuevo.', antes);

  // 1. Confirmado para ya.
  const campos: Record<string, unknown> = { estado: 'pendiente', fecha: horaDeCordoba().fecha, ahora: new Date().toISOString(), resultado: '' };
  if (antes.estado === 'borrador') {
    // Lo que la persona corrigió en la tarjeta antes de tocar «Ahora», igual que con "Agendar".
    if (typeof pedido.titulo === 'string') campos.titulo = pedido.titulo.trim();
    if (typeof pedido.cuerpo === 'string') campos.cuerpo = pedido.cuerpo.replace(/\s+$/, '');
    if ('realizar' in pedido) campos.realizar = pedido.realizar && pedido.realizar === antes.realizar ? antes.realizar : '';
  }
  let fila: any;
  try {
    [fila] = await db.cambiar('agenda', `id=eq.${id}&rev=eq.${rev}&estado=in.(${ABIERTOS.join(',')})`, campos);
  } catch (e) {
    if (e instanceof ErrorBase && e.codigo === '23514') return falla(400, 'pedido', 'Completá el título y el texto del escrito.');
    throw e;
  }
  if (!fila) {
    const [actual] = await db.leer('agenda', `id=eq.${id}&select=*`);
    return actual ? falla(409, 'conflicto', 'El escrito cambió recién. Revisalo y probá de nuevo.', actual)
      : falla(404, 'no_existe', 'Ese escrito ya no está en la agenda.');
  }

  // 2. La tarea arranca ya. Lo que se le manda es solo un aviso: ella toma de la base lo pedido «Ahora».
  const disparo = await dispararTarea(token, `Botón «Ahora» del gestor: ${quien} pidió presentar en el SAC el escrito ${id} (causa ${fila.expte}).`);
  if (disparo.ok) {
    console.log(JSON.stringify({ ahora: 'ok', id, sesion: disparo.sesion }));
    return { status: 200, cuerpo: { fila, sesion: disparo.sesion } };
  }

  // 3. No arrancó: el escrito vuelve al estado y la fecha que tenía, salvo que alguien lo haya
  //    tocado en el medio (por ejemplo, la corrida de las 10:15 ya lo tomó); entonces se devuelve cómo quedó.
  const volver = { estado: antes.estado, fecha: antes.fecha, ahora: antes.ahora, resultado: antes.resultado };
  let vuelta: any = null;
  try { [vuelta] = await db.cambiar('agenda', `id=eq.${id}&rev=eq.${fila.rev}`, volver); } catch (e) { console.error('ahora, al volver atrás:', e); }
  const queda = antes.estado === 'borrador' ? 'No se agendó: sigue como borrador, con lo que corregiste.'
    : antes.estado === 'pendiente' ? 'Sigue agendado como antes.' : 'Sigue sin presentar.';
  if (vuelta) return falla(disparo.status, 'tarea', `${disparo.mensaje} ${queda}`, vuelta);
  let actual: any = null;
  try { [actual] = await db.leer('agenda', `id=eq.${id}&select=*`); } catch { /* se avisa igual */ }
  return falla(disparo.status, 'tarea', `${disparo.mensaje} Mientras tanto el escrito cambió: fijate cómo quedó en la tarjeta.`, actual);
}

type Disparo = { ok: true; sesion: string } | { ok: false; status: number; mensaje: string };

/** POST al endpoint de la tarea (routine) con su token: abre una corrida nueva y devuelve su sesión. */
async function dispararTarea(token: string, aviso: string): Promise<Disparo> {
  let r: Response;
  try {
    r = await fetch(URL_TAREA, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'content-type': 'application/json',
      },
      body: JSON.stringify({ text: aviso }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    console.error('tarea:', e);
    return { ok: false, status: 502, mensaje: 'No se pudo comunicar con la tarea que presenta en el SAC. Probá de nuevo en un momento.' };
  }
  const texto = await r.text();
  let datos: any = null;
  try { datos = JSON.parse(texto); } catch { /* lo de abajo alcanza */ }
  if (r.ok) return { ok: true, sesion: String(datos?.claude_code_session_url || '') };
  console.error('tarea:', r.status, texto.slice(0, 300));
  if (r.status === 401 || r.status === 403) {
    return { ok: false, status: 502, mensaje: 'La tarea que presenta en el SAC no aceptó el token: hay que generar uno nuevo y cargarlo en Supabase (secreto TAREA_SAC_TOKEN).' };
  }
  if (r.status === 404) return { ok: false, status: 502, mensaje: 'No se encontró la tarea que presenta en el SAC: puede que se haya borrado.' };
  if (r.status === 429) return { ok: false, status: 429, mensaje: 'Se pidieron demasiadas presentaciones seguidas. Esperá un rato y probá de nuevo.' };
  return { ok: false, status: 502, mensaje: `La tarea que presenta en el SAC no arrancó (respondió ${r.status}). Probá de nuevo en un momento.` };
}
