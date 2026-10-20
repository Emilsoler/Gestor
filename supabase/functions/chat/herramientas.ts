// Lo que Claude puede hacer desde el chat: leer y anotar en las causas, y dejar escritos en la
// agenda como borrador. No puede eliminar nada ni presentar en el SAC: eso último lo hace la
// tarea programada, y solo con lo que la persona confirmó en la app.
import { Base, ErrorBase } from './base.ts';
import {
  Ahora, CAUTELARES, Causa, ESTADOS, Mov, SITUACIONES, UBICACIONES, caratula, completar, dma, esFecha, nombreDia, norm,
  reclamado, resumenLiquidacion, ultimaDe,
} from './util.ts';

export type Contexto = {
  db: Base;
  hoy: Ahora;
  cambios: boolean; // algo cambió en la base: la app relee
  acciones: string[]; // lo que cambió, en una línea cada cosa, para mostrarlo debajo de la respuesta
  borradores: Record<string, unknown>[]; // escritos que la persona tiene que confirmar
};

class Problema extends Error {} // un pedido que no se puede hacer: vuelve a Claude como error, explicado

const fecha = (descripcion: string) => ({ type: 'string', description: `${descripcion} Formato AAAA-MM-DD.` });
const EXPTE = { type: 'string', description: 'N° de expediente del SAC (solo números).' };
const UBICACION = { type: 'string', enum: UBICACIONES, description: 'Dónde está el expediente.' };
const ESTADO = { type: 'string', enum: ESTADOS, description: 'La etapa del juicio.' };
const CAUTELAR = { type: 'string', enum: CAUTELARES, description: 'La etiqueta cautelar.' };
const SITUACION = { type: 'string', enum: SITUACIONES, description: 'Archivada: no aparece en el listado de la app. Acuerdo: se ve aparte.' };

export const HERRAMIENTAS = [
  {
    name: 'buscar_causas',
    description: 'Busca causas por demandado, actor, N° de expediente, tipo, oficina o texto de sus acciones y notas, y las filtra por ubicación, estado, etiqueta cautelar o situación (por ejemplo, para "¿qué causas están a despacho?" mandá solo ubicacion). Devuelve hasta 20, con esos datos, la última acción y la próxima. Las archivadas solo si se pide o si se filtra por situación Archivada.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Lo que se busca, por ejemplo "piedra" o "14036179". Puede faltar si hay algún filtro.' },
        ubicacion: UBICACION, estado: ESTADO, cautelar: CAUTELAR, situacion: SITUACION,
        incluir_archivadas: { type: 'boolean' },
      },
    },
  },
  {
    name: 'ver_causa',
    description: 'Lee una causa completa: datos, ubicación, estado, etiqueta cautelar, situación, próxima acción, últimos movimientos, demandados con su contacto, títulos con el monto reclamado a hoy, liquidación y escritos de la agenda.',
    input_schema: { type: 'object', properties: { expte: EXPTE }, required: ['expte'] },
  },
  {
    name: 'listar_pendientes',
    description: 'Lo que hay que hacer: causas activas con próxima acción anotada, de la más vencida a la más lejana, y los escritos de la agenda (borradores, agendados, presentándose y con error). Para "¿qué tengo pendiente?", "¿qué vence esta semana?".',
    input_schema: {
      type: 'object',
      properties: {
        hasta: fecha('Solo lo que vence hasta esa fecha (siempre incluye lo vencido).'),
        incluir_sin_vencimiento: { type: 'boolean', description: 'Sumar las próximas acciones que no tienen fecha.' },
      },
    },
  },
  {
    name: 'editar_causa',
    description: 'Cambia campos de una causa: solo los que mandes. Para sumar algo a las notas sin borrar lo que hay, usá agregar_a_notas. Para borrar la próxima acción, mandá proxima vacía.',
    input_schema: {
      type: 'object',
      properties: {
        expte: EXPTE,
        ubicacion: UBICACION, estado: ESTADO, cautelar: CAUTELAR, situacion: SITUACION,
        proxima: { type: 'string', description: 'Qué hay que hacer.' },
        vence: { type: 'string', description: 'Vencimiento de la próxima acción, AAAA-MM-DD, o vacío para quitarlo.' },
        notas: { type: 'string', description: 'Reemplaza todas las notas.' },
        agregar_a_notas: { type: 'string', description: 'Se agrega al final de las notas, en una línea nueva.' },
        tipo: { type: 'string' }, nom: { type: 'string', description: 'Nominación (número).' }, oficina: { type: 'string' },
        actor: { type: 'string' }, demandado: { type: 'string' },
      },
      required: ['expte'],
    },
  },
  {
    name: 'registrar_movimiento',
    description: 'Anota en la causa algo que ya pasó (un decreto, una cédula, un escrito presentado por otro lado). Si es lo más reciente, pasa a ser la última acción. Puede cambiar a la vez el estado (la etapa) y la ubicación: un escrito presentado deja el expediente A despacho.',
    input_schema: {
      type: 'object',
      properties: {
        expte: EXPTE,
        texto: { type: 'string' },
        fecha: fecha('Cuándo pasó; si no se dice, hoy. No puede ser futura.'),
        estado: ESTADO, ubicacion: UBICACION,
      },
      required: ['expte', 'texto'],
    },
  },
  {
    name: 'marcar_realizada',
    description: 'Da por realizada la próxima acción anotada: pasa a los movimientos (con la fecha en que vencía, o la de hoy si todavía no venció) y la causa queda sin próxima acción.',
    input_schema: { type: 'object', properties: { expte: EXPTE }, required: ['expte'] },
  },
  {
    name: 'listar_plantillas',
    description: 'La biblioteca de plantillas de escritos: id y título de cada una.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'preparar_presentacion',
    description: 'Arma un escrito para presentar en el SAC y lo deja como BORRADOR en la agenda, con la fecha que se indique. La persona lo ve completo en una tarjeta, puede corregirlo y elige "Ahora" (queda listo y se abre la tarea de Claude, donde toca "Ejecutar ahora" para que se presente) o "Agendar" (queda en la agenda para ese día, pero no se presenta solo). Con plantilla_id usa esa plantilla completada con los datos de la causa; si no, mandá titulo y cuerpo. Con dar_por_realizada, al presentarlo también se da por realizada la próxima acción que la causa tenga anotada.',
    input_schema: {
      type: 'object',
      properties: {
        expte: EXPTE,
        fecha: fecha('Día en que se presenta.'),
        plantilla_id: { type: 'string', description: 'id de listar_plantillas.' },
        titulo: { type: 'string', description: 'Sumario del escrito; si hay plantilla, reemplaza el de la plantilla.' },
        cuerpo: { type: 'string', description: 'Texto del escrito; si hay plantilla, reemplaza el de la plantilla.' },
        dar_por_realizada: { type: 'boolean' },
      },
      required: ['expte', 'fecha'],
    },
  },
  {
    name: 'ver_agenda',
    description: 'Escritos de la agenda: borradores, agendados para presentar, presentándose y con error; con incluir_cerrados, también los presentados y los cancelados. Se puede filtrar por causa.',
    input_schema: { type: 'object', properties: { expte: EXPTE, incluir_cerrados: { type: 'boolean' } } },
  },
  {
    name: 'cancelar_presentacion',
    description: 'Cancela un escrito agendado, o descarta un borrador: no se presenta.',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'id del escrito en la agenda.' } }, required: ['id'] },
  },
  {
    name: 'reprogramar_presentacion',
    description: 'Cambia el día de un escrito agendado, o vuelve a agendar uno que quedó con error (el texto ya fue confirmado). Agendado no se presenta solo: ese día la persona toca "Presentar ahora".',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id del escrito en la agenda.' }, fecha: fecha('Día nuevo.') },
      required: ['id', 'fecha'],
    },
  },
];

// ───────────────────────── Lectura ─────────────────────────

const CAMPOS_LISTA = 'expte,actor,demandado,tipo,nom,oficina,ubicacion,estado,cautelar,situacion,proxima,vence,ultima,fecha,notas,rev';

async function todasLasCausas(db: Base): Promise<Causa[]> {
  const filas: Causa[] = [];
  for (let desde = 0; ; desde += 1000) { // la API entrega de a 1000 filas como máximo
    const tramo = await db.leer('causas', `select=${CAMPOS_LISTA}&order=expte&offset=${desde}&limit=1000`);
    filas.push(...tramo);
    if (tramo.length < 1000) return filas;
  }
}

function expteValido(x: unknown): string {
  const e = String(x ?? '').trim();
  if (!/^\d+$/.test(e)) throw new Problema(`"${e}" no es un N° de expediente: tiene que ser solo números. Si tenés el nombre, usá buscar_causas.`);
  return e;
}

async function causa(db: Base, x: unknown): Promise<Causa> {
  const expte = expteValido(x);
  const [c] = await db.leer('causas', `expte=eq.${expte}&select=*`);
  if (!c) throw new Problema(`No existe la causa con expediente ${expte}. Probá con buscar_causas.`);
  return c;
}

const resumen = (c: Causa) => ({
  expte: c.expte, caratula: caratula(c), ubicacion: c.ubicacion, estado: c.estado || '(sin estado)', cautelar: c.cautelar, situacion: c.situacion,
  nominacion: c.nom ? `${c.nom}°` : '', oficina: c.oficina,
  ultima_accion: c.ultima || null, fecha_ultima: c.fecha, proxima: c.proxima || null, vence: c.proxima ? c.vence : null,
});

const idValido = (x: unknown) => {
  const id = String(x ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Problema(`"${id}" no es un id de la agenda.`);
  return id;
};

const escrito = (a: any, causas?: Map<string, Causa>) => ({
  id: a.id, expte: a.expte, ...(causas?.get(a.expte) ? { caratula: caratula(causas.get(a.expte)!) } : {}),
  titulo: a.titulo, fecha: a.fecha,
  estado: a.estado === 'pendiente' ? (a.ahora ? 'listo para presentar: falta que la persona toque "Ejecutar ahora" en la tarea de Claude' : 'agendado (no se presenta solo)') : a.estado === 'presentando' ? 'presentándose en el SAC en este momento' : a.estado,
  ...(a.realizar ? { da_por_realizada: a.realizar } : {}), ...(a.resultado ? { resultado: a.resultado } : {}),
});

// ───────────────────────── Escritura ─────────────────────────

/**
 * Cambia una causa con su número de revisión: si alguien la cambió recién (la persona desde la
 * app, otra pestaña), se relee y se vuelve a aplicar sobre lo nuevo, en vez de pisarlo.
 */
async function cambiarCausa(ctx: Contexto, expte: unknown, armar: (c: Causa) => Record<string, unknown>) {
  for (let intento = 0; intento < 3; intento++) {
    const c = await causa(ctx.db, expte);
    const campos = armar(c);
    const [fila] = await ctx.db.cambiar('causas', `expte=eq.${c.expte}&rev=eq.${c.rev}`, campos);
    if (fila) { ctx.cambios = true; return { antes: c, despues: fila as Causa }; }
  }
  throw new Problema('La causa cambió varias veces mientras la actualizaba. Volvé a intentarlo.');
}

const VALORES: Record<string, { lista: string[]; desconocido: string; son: string }> = {
  ubicacion: { lista: UBICACIONES, desconocido: 'Ubicación desconocida', son: 'Las ubicaciones son' },
  estado: { lista: ESTADOS, desconocido: 'Estado desconocido', son: 'Los estados son' },
  cautelar: { lista: CAUTELARES, desconocido: 'Etiqueta cautelar desconocida', son: 'Las etiquetas cautelares son' },
  situacion: { lista: SITUACIONES, desconocido: 'Situación desconocida', son: 'Las situaciones son' },
};
const CAMPOS_FIJOS = Object.keys(VALORES);

/** Un valor de ubicación, estado, cautelar o situación; si es de otro de los cuatro, lo dice. */
function validar(campo: string, valor: unknown) {
  const v = String(valor ?? '').trim(), { lista, desconocido, son } = VALORES[campo];
  if (lista.includes(v)) return v;
  const otro = CAMPOS_FIJOS.find((k) => k !== campo && VALORES[k].lista.includes(v));
  throw new Problema(`${desconocido}: "${v}".${otro ? ` Ese valor va en ${otro}.` : ''} ${son}: ${lista.join(', ')}.`);
}

// ───────────────────────── Herramientas ─────────────────────────

type Entrada = Record<string, any>;

const acciones: Record<string, (e: Entrada, ctx: Contexto) => Promise<unknown>> = {
  async buscar_causas(e, { db }) {
    const texto = String(e.texto ?? '').trim();
    const palabras = norm(texto).split(/[\s,.;:]+/).filter(Boolean);
    const filtros = CAMPOS_FIJOS.filter((k) => e[k] !== undefined && e[k] !== null && e[k] !== '');
    const pide: Record<string, string> = Object.fromEntries(filtros.map((k) => [k, validar(k, e[k])]));
    if (!palabras.length && !filtros.length) throw new Problema('Decime qué buscar: un nombre, un expediente o un filtro.');
    const conArchivadas = !!e.incluir_archivadas || pide.situacion === 'Archivada';
    const coincide = (c: Causa) => filtros.every((k) => (c as any)[k] === pide[k]);
    const todas = await todasLasCausas(db);
    const hallan = todas.filter((c) => {
      if (c.situacion === 'Archivada' && !conArchivadas) return false;
      if (!coincide(c)) return false;
      const pajar = norm([c.expte, c.actor, c.demandado, c.tipo, c.oficina, c.nom, c.ubicacion, c.estado, c.cautelar, c.situacion, c.ultima, c.proxima, c.notas].join(' '));
      return palabras.every((p) => pajar.includes(p));
    });
    hallan.sort((a, b) => Number(b.expte === texto) - Number(a.expte === texto) || caratula(a).localeCompare(caratula(b)));
    const archivadas = conArchivadas ? 0 : todas.filter((c) => c.situacion === 'Archivada' && coincide(c) && palabras.every((p) => norm([c.expte, c.actor, c.demandado].join(' ')).includes(p))).length;
    return {
      encontradas: hallan.length, causas: hallan.slice(0, 20).map(resumen),
      ...(hallan.length > 20 ? { nota: 'Hay más: afiná la búsqueda.' } : {}),
      ...(archivadas ? { archivadas_que_coinciden: archivadas } : {}),
    };
  },

  async ver_causa(e, { db, hoy }) {
    const c = await causa(db, e.expte);
    const movs = (c.historial || []).map((h, i) => ({ ...h, i })).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.i - a.i);
    const agenda = await db.leer('agenda', `expte=eq.${c.expte}&estado=neq.cancelado&order=fecha.desc&limit=10&select=*`);
    return {
      ...resumen(c), actor: c.actor, demandado: c.demandado, tipo: c.tipo, notas: c.notas || null,
      movimientos: movs.slice(0, 15).map((h) => ({ fecha: h.fecha, texto: h.texto, ...(h.hecha ? { realizada: true } : {}) })),
      ...(movs.length > 15 ? { movimientos_anteriores: movs.length - 15 } : {}),
      demandados: c.demandados || [],
      ...((c.titulos || []).length ? { reclamado: reclamado(c, hoy.fecha) } : {}),
      ...(c.liquidacion ? { liquidacion: resumenLiquidacion(c.liquidacion) } : {}),
      agenda: agenda.map((a: any) => escrito(a)),
      ultimo_cambio: c.actualizado ? { cuando: c.actualizado, quien: c.actualizado_por } : null,
    };
  },

  async listar_pendientes(e, { db, hoy }) {
    if (e.hasta !== undefined && e.hasta !== '' && !esFecha(e.hasta)) throw new Problema('"hasta" tiene que ser una fecha AAAA-MM-DD.');
    const todas = await todasLasCausas(db);
    const activas = todas.filter((c) => c.situacion !== 'Archivada' && (c.proxima || '').trim());
    const conFecha = activas.filter((c) => c.vence && (!e.hasta || c.vence <= e.hasta)).sort((a, b) => a.vence!.localeCompare(b.vence!));
    const sinFecha = e.incluir_sin_vencimiento ? activas.filter((c) => !c.vence) : [];
    const porCausa = new Map(todas.map((c) => [c.expte, c]));
    const agenda = await db.leer('agenda', 'estado=in.(borrador,pendiente,presentando,error)&order=fecha&select=*');
    return {
      hoy: hoy.fecha,
      proximas_acciones: conFecha.map((c) => ({
        expte: c.expte, caratula: caratula(c), proxima: c.proxima, vence: c.vence, ubicacion: c.ubicacion, estado: c.estado,
        plazo: c.vence! < hoy.fecha ? 'vencida' : c.vence === hoy.fecha ? 'vence hoy' : `vence el ${nombreDia(c.vence!)} ${dma(c.vence!)}`,
      })),
      ...(sinFecha.length ? { sin_vencimiento: sinFecha.map((c) => ({ expte: c.expte, caratula: caratula(c), proxima: c.proxima })) } : {}),
      ...(!e.incluir_sin_vencimiento ? { con_proxima_sin_vencimiento: activas.filter((c) => !c.vence).length } : {}),
      agenda: agenda.map((a: any) => escrito(a, porCausa)),
    };
  },

  async editar_causa(e, ctx) {
    const pide = (k: string) => Object.prototype.hasOwnProperty.call(e, k) && e[k] !== null && e[k] !== undefined;
    const fijos: Record<string, string> = Object.fromEntries(CAMPOS_FIJOS.filter(pide).map((k) => [k, validar(k, e[k])]));
    if (pide('vence') && e.vence !== '' && !esFecha(e.vence)) throw new Problema('El vencimiento tiene que ser una fecha AAAA-MM-DD (o vacío para quitarlo).');
    if (pide('nom') && String(e.nom).trim() && !/^\d+$/.test(String(e.nom).trim().replace(/°$/, ''))) throw new Problema('La nominación es un número.');
    const { antes, despues } = await cambiarCausa(ctx, e.expte, (c) => {
      const f: Record<string, unknown> = { ...fijos };
      for (const k of ['tipo', 'oficina', 'actor', 'demandado']) if (pide(k)) f[k] = String(e[k]).trim();
      if (pide('nom')) f.nom = String(e.nom).trim().replace(/°$/, '');
      if (pide('proxima')) f.proxima = String(e.proxima).trim();
      if (pide('vence')) f.vence = e.vence || null;
      if (f.proxima === '') f.vence = null; // sin próxima acción no hay vencimiento (como gestor.proxima)
      if (pide('notas')) f.notas = String(e.notas);
      if (pide('agregar_a_notas') && String(e.agregar_a_notas).trim()) {
        const base = String(f.notas ?? c.notas ?? '').trimEnd();
        f.notas = (base ? base + '\n' : '') + String(e.agregar_a_notas).trim();
      }
      if (!Object.keys(f).length) throw new Problema('No mandaste ningún cambio.');
      const actor = 'actor' in f ? f.actor : c.actor, demandado = 'demandado' in f ? f.demandado : c.demandado;
      if (!actor && !demandado) throw new Problema('La causa necesita un actor o un demandado para poder nombrarla.');
      return f;
    });
    const cambiados = Object.keys(despues).filter((k) => !['rev', 'actualizado', 'actualizado_por'].includes(k) &&
      JSON.stringify((antes as any)[k] ?? null) !== JSON.stringify((despues as any)[k] ?? null));
    ctx.acciones.push(cambiados.length ? `Causa ${despues.expte}: ${cambiados.map(nombreCampo).join(', ')} actualizado${cambiados.length > 1 ? 's' : ''}` : `Causa ${despues.expte}: sin cambios (ya estaba así)`);
    return { listo: true, expte: despues.expte, cambios: Object.fromEntries(cambiados.map((k) => [k, { antes: (antes as any)[k], ahora: (despues as any)[k] }])) };
  },

  async registrar_movimiento(e, ctx) {
    const texto = String(e.texto ?? '').trim();
    if (!texto) throw new Problema('Falta el texto del movimiento.');
    const f = e.fecha ? e.fecha : ctx.hoy.fecha;
    if (!esFecha(f)) throw new Problema('La fecha tiene que ser AAAA-MM-DD.');
    if (f > ctx.hoy.fecha) throw new Problema('Un movimiento es algo que ya pasó. Para algo que hay que hacer, anotalo como próxima acción con su vencimiento.');
    const estado = e.estado ? validar('estado', e.estado) : null;
    const ubicacion = e.ubicacion ? validar('ubicacion', e.ubicacion) : null;
    const { despues } = await cambiarCausa(ctx, e.expte, (c) => {
      const historial: Mov[] = [...(c.historial || []), { fecha: f, texto }];
      return { historial, ...ultimaDe(historial), ...(estado ? { estado } : {}), ...(ubicacion ? { ubicacion } : {}) };
    });
    ctx.acciones.push(`Causa ${despues.expte}: movimiento anotado (${dma(f)}: ${texto})${estado ? `, estado ${estado}` : ''}${ubicacion ? `, ${ubicacion}` : ''}`);
    return { listo: true, expte: despues.expte, ultima_accion: despues.ultima, fecha_ultima: despues.fecha, estado: despues.estado, ubicacion: despues.ubicacion };
  },

  async marcar_realizada(e, ctx) {
    let hecha = '';
    const { despues } = await cambiarCausa(ctx, e.expte, (c) => {
      hecha = (c.proxima || '').trim();
      if (!hecha) throw new Problema(`La causa ${c.expte} no tiene próxima acción anotada.`);
      // Con la fecha en que vencía; si todavía no venció (se hizo antes), con la de hoy: un
      // movimiento con fecha futura taparía la causa en "sin movimiento" y en "última acción".
      const f = c.vence && c.vence < ctx.hoy.fecha ? c.vence : ctx.hoy.fecha;
      const historial: Mov[] = [...(c.historial || []), { fecha: f, texto: hecha, hecha: true }];
      return { historial, ...ultimaDe(historial), proxima: '', vence: null };
    });
    ctx.acciones.push(`Causa ${despues.expte}: "${hecha}" realizada`);
    return { listo: true, expte: despues.expte, realizada: hecha, ultima_accion: despues.ultima, fecha_ultima: despues.fecha };
  },

  async listar_plantillas(_e, { db }) {
    return { plantillas: await db.leer('plantillas', 'select=id,titulo&order=titulo') };
  },

  async preparar_presentacion(e, ctx) {
    const { db, hoy } = ctx;
    const c = await causa(db, e.expte);
    if (!esFecha(e.fecha)) throw new Problema('La fecha tiene que ser AAAA-MM-DD.');
    if (e.fecha < hoy.fecha) throw new Problema('La fecha ya pasó: un escrito se agenda para hoy o más adelante.');
    let titulo = e.titulo, cuerpo = e.cuerpo;
    if (e.plantilla_id) {
      const [p] = await db.leer('plantillas', `id=eq.${encodeURIComponent(String(e.plantilla_id))}&select=id,titulo,cuerpo`);
      if (!p) {
        const hay = await db.leer('plantillas', 'select=id,titulo&order=titulo');
        throw new Problema(`No existe la plantilla "${e.plantilla_id}". Las que hay: ${hay.map((x: any) => `${x.titulo} (id ${x.id})`).join('; ') || 'ninguna'}.`);
      }
      titulo = titulo || p.titulo; cuerpo = cuerpo || p.cuerpo;
    }
    titulo = completar(String(titulo ?? ''), c).trim();
    cuerpo = completar(String(cuerpo ?? ''), c).replace(/\s+$/, '');
    if (!titulo || !cuerpo.trim()) throw new Problema('Falta el título o el texto del escrito: indicá una plantilla o mandá los dos.');

    const avisos: string[] = [];
    const sueltos = [...new Set([...`${titulo}\n${cuerpo}`.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]))];
    if (sueltos.length) avisos.push(`Quedaron campos sin completar: ${sueltos.map((s) => `{{${s}}}`).join(', ')}.`);
    let realizar = '';
    if (e.dar_por_realizada) {
      realizar = (c.proxima || '').trim();
      if (!realizar) avisos.push('La causa no tiene próxima acción anotada: al presentar no hay nada para dar por realizada.');
    }
    // La tarea que presenta en el SAC no adjunta archivos: un escrito que acompaña documentos lo deja con error.
    if (/acompa[ñn]|adjunt/i.test(`${titulo}\n${cuerpo}`)) avisos.push('El escrito dice que acompaña documentos: la tarea que presenta en el SAC no adjunta archivos, así que no lo va a presentar (lo deja con error para que la persona lo presente o se lo pida a Claude en la app de Claude, con los archivos).');
    const iguales = await db.leer('agenda', `expte=eq.${c.expte}&estado=in.(pendiente,presentando,borrador)&select=id,titulo,fecha,estado,ahora`);
    for (const a of iguales) if (norm(a.titulo) === norm(titulo)) avisos.push(`Ya hay un escrito igual ${a.estado === 'borrador' ? 'en borrador' : a.estado === 'presentando' ? 'presentándose ahora' : a.ahora ? 'listo para presentar' : 'agendado'} para el ${dma(a.fecha)} (id ${a.id}).`);

    const [fila] = await db.insertar('agenda', { expte: c.expte, titulo, cuerpo, fecha: e.fecha, realizar, estado: 'borrador' });
    ctx.cambios = true;
    ctx.borradores.push({ ...fila, caratula: caratula(c), avisos });
    return {
      tarjeta: true, id: fila.id, expte: c.expte, caratula: caratula(c), titulo, cuerpo, fecha: fila.fecha,
      dia: nombreDia(fila.fecha), da_por_realizada: realizar || null, avisos,
      importante: 'Es un borrador: para presentarlo, la persona lo revisa en la tarjeta, toca "Ahora" y después "Ejecutar ahora" en la tarea de Claude que se abre. "Agendar" solo lo deja en la agenda: no se presenta solo. Hasta que toque uno de los dos, no está confirmado.',
    };
  },

  async ver_agenda(e, { db }) {
    const filtros = [e.expte ? `expte=eq.${expteValido(e.expte)}` : '', e.incluir_cerrados ? '' : 'estado=in.(borrador,pendiente,presentando,error)'].filter(Boolean);
    const filas = await db.leer('agenda', [...filtros, 'order=fecha.desc', 'limit=40', 'select=*'].join('&'));
    const porCausa = new Map((await todasLasCausas(db)).map((c) => [c.expte, c]));
    return { escritos: filas.map((a: any) => escrito(a, porCausa)) };
  },

  async cancelar_presentacion(e, ctx) {
    const id = idValido(e.id);
    const [fila] = await ctx.db.cambiar('agenda', `id=eq.${id}&estado=in.(borrador,pendiente,error)`, { estado: 'cancelado' });
    if (!fila) {
      const [a] = await ctx.db.leer('agenda', `id=eq.${id}&select=estado`);
      throw new Problema(!a ? 'No existe ese escrito en la agenda.' : a.estado === 'presentado' ? 'Ese escrito ya se presentó: no se puede cancelar.'
        : a.estado === 'presentando' ? 'Ese escrito se está presentando en el SAC en este momento: ya no se puede cancelar.' : 'Ese escrito ya estaba cancelado.');
    }
    ctx.cambios = true;
    ctx.acciones.push(`Causa ${fila.expte}: escrito "${fila.titulo}" cancelado`);
    return { listo: true, ...escrito(fila) };
  },

  async reprogramar_presentacion(e, ctx) {
    const id = idValido(e.id);
    if (!esFecha(e.fecha)) throw new Problema('La fecha tiene que ser AAAA-MM-DD.');
    if (e.fecha < ctx.hoy.fecha) throw new Problema('La fecha ya pasó.');
    const [fila] = await ctx.db.cambiar('agenda', `id=eq.${id}&estado=in.(pendiente,error)`, { fecha: e.fecha, estado: 'pendiente', resultado: '', ahora: null });
    if (!fila) {
      const [a] = await ctx.db.leer('agenda', `id=eq.${id}&select=estado`);
      throw new Problema(!a ? 'No existe ese escrito en la agenda.'
        : a.estado === 'borrador' ? 'Ese escrito todavía es un borrador: la persona tiene que confirmarlo en la tarjeta (ahí puede cambiar la fecha).'
          : a.estado === 'presentando' ? 'Ese escrito se está presentando en el SAC en este momento: no se puede reprogramar.'
            : `Ese escrito está ${a.estado}: no se puede reprogramar.`);
    }
    ctx.cambios = true;
    ctx.acciones.push(`Causa ${fila.expte}: "${fila.titulo}" agendado para el ${dma(fila.fecha)}`);
    return { listo: true, ...escrito(fila) };
  },
};

const NOMBRES: Record<string, string> = {
  proxima: 'próxima acción', vence: 'vencimiento', nom: 'nominación', ultima: 'última acción', fecha: 'fecha de la última acción',
  ubicacion: 'ubicación', cautelar: 'etiqueta cautelar', situacion: 'situación',
};
const nombreCampo = (k: string) => NOMBRES[k] || k;

/** Corre una herramienta y devuelve el tool_result para Claude. Nunca lanza: un error vuelve explicado. */
export async function ejecutar(bloque: { id: string; name: string; input: Entrada }, ctx: Contexto) {
  const resultado = (contenido: unknown, error = false) => ({
    type: 'tool_result', tool_use_id: bloque.id, content: JSON.stringify(contenido), ...(error ? { is_error: true } : {}),
  });
  const accion = acciones[bloque.name];
  if (!accion) return resultado({ error: `No existe la herramienta ${bloque.name}.` }, true);
  try {
    return resultado(await accion(bloque.input || {}, ctx));
  } catch (e) {
    if (e instanceof Problema) return resultado({ error: e.message }, true);
    if (e instanceof ErrorBase) {
      console.error('base:', bloque.name, e.status, e.codigo, e.message);
      return resultado({ error: `La base de datos no aceptó el pedido: ${e.message}` }, true);
    }
    console.error('herramienta:', bloque.name, e);
    return resultado({ error: 'Falló algo inesperado al hacerlo. No sé si quedó hecho: revisá la causa antes de repetir.' }, true);
  }
}
