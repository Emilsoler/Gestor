// Lo que Claude puede hacer desde el chat de la app de cobranzas: leer deudores y su liquidación,
// anotar gestiones y la próxima acción, y registrar pagos que la persona dicta con su imputación.
// No puede eliminar nada ni mandar mensajes: el WhatsApp lo envía la persona desde la app.
// Las cuentas las hace la base (gestor.liquidacion_deudor, por los puentes de la migración 0019).
import { ErrorBase } from './base.ts';
import type { Contexto } from './herramientas.ts';
import { dma, esFecha, norm } from './util.ts';

class Problema extends Error {}
type Entrada = Record<string, any>;

const ESTADOS = ['En gestión', 'En juicio', 'Cancelado', 'Incobrable', 'Archivado'];
const TIPOS = ['Llamada', 'WhatsApp', 'Visita', 'Email', 'Carta documento', 'Promesa de pago', 'Nota'];
const ID = { type: 'string', description: 'Id del deudor (el que devuelve buscar_deudores).' };
const fecha = (d: string) => ({ type: 'string', description: `${d} Formato AAAA-MM-DD.` });

export const HERRAMIENTAS_COBRANZAS = [
  {
    name: 'buscar_deudores',
    description: 'Busca deudores por nombre, DNI, N° de socio, teléfono, dominio del vehículo o expediente. Sin texto, lista los de un estado. Por defecto no trae archivados ni cancelados.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabras a buscar (todas tienen que aparecer).' },
        estado: { type: 'string', enum: ESTADOS, description: 'Filtrar por estado.' },
      },
    },
  },
  {
    name: 'ver_deudor',
    description: 'Ficha de un deudor: datos, liquidación a hoy (o a la fecha que se pida) por rubro, planes, últimos pagos y últimas gestiones.',
    input_schema: {
      type: 'object',
      properties: { id: ID, a_la_fecha: fecha('Liquidar a esta fecha (por defecto hoy).'), con_cuotas_a_vencer: { type: 'boolean', description: 'Incluir las cuotas que todavía no vencieron.' } },
      required: ['id'],
    },
  },
  {
    name: 'listar_pendientes_cobranza',
    description: 'Deudores en gestión con próxima acción anotada, ordenados por vencimiento. Sirve para "qué tengo para hoy".',
    input_schema: { type: 'object', properties: { hasta: fecha('Solo los que vencen hasta este día.') } },
  },
  {
    name: 'anotar_gestion',
    description: 'Anota una gestión en el historial del deudor (llamada, WhatsApp, visita…). Con promesa_fecha queda como promesa de pago.',
    input_schema: {
      type: 'object',
      properties: {
        id: ID, texto: { type: 'string', description: 'Qué pasó, en una o dos frases.' },
        tipo: { type: 'string', enum: TIPOS }, fecha: fecha('Cuándo fue (por defecto hoy).'),
        promesa_fecha: fecha('Día en que prometió pagar.'), promesa_monto: { type: 'number', description: 'Monto prometido, en pesos.' },
      },
      required: ['id', 'texto', 'tipo'],
    },
  },
  {
    name: 'fijar_proxima_accion',
    description: 'Fija la próxima acción del deudor y su fecha. Con texto vacío la borra.',
    input_schema: { type: 'object', properties: { id: ID, texto: { type: 'string' }, vence: fecha('Cuándo hay que hacerlo.') }, required: ['id', 'texto'] },
  },
  {
    name: 'registrar_pago',
    description: 'Registra un pago recibido. SOLO con la imputación que la persona dictó: cuánto va a capital, a intereses, a honorarios o a un gasto (por su id). Si no la dijo, preguntásela; no la inventes.',
    input_schema: {
      type: 'object',
      properties: {
        id: ID, fecha: fecha('Fecha del pago (no puede ser futura).'),
        imputacion: { type: 'object', description: 'Importes por rubro, en pesos: {"capital": 100000, "intereses": 20000}. También "honorarios" o el id de un gasto.', additionalProperties: { type: 'number' } },
        recibo: { type: 'string' }, medio: { type: 'string', description: 'Efectivo, transferencia…' }, nota: { type: 'string' },
        plan: { type: 'string', description: 'Id del plan vigente al que corresponde el pago, si es de un plan.' },
      },
      required: ['id', 'fecha', 'imputacion'],
    },
  },
];

const CAMPOS = 'id,nombre,trato,dni,socio,domicilio,email,telefonos,estado,expte,tasa,hon_pct,proxima,vence,notas,rev';

const idValido = (x: unknown) => {
  const id = String(x ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Problema(`"${id}" no es un id de deudor. Usá buscar_deudores.`);
  return id;
};
const fechaOpc = (x: unknown, campo: string) => {
  if (x === undefined || x === null || x === '') return null;
  if (!esFecha(x)) throw new Problema(`"${campo}" tiene que ser una fecha AAAA-MM-DD.`);
  return x as string;
};

async function deudor(ctx: Contexto, x: unknown, campos = '*') {
  const id = idValido(x);
  const [d] = await ctx.db.leer('deudores', `id=eq.${id}&select=${campos}`);
  if (!d) throw new Problema('No existe ese deudor. Probá con buscar_deudores.');
  return d;
}

const resumen = (d: any) => ({
  id: d.id, nombre: d.nombre, dni: d.dni || null, socio: d.socio || null, estado: d.estado, expte: d.expte || null,
  proxima: d.proxima || null, vence: d.proxima ? d.vence : null,
});

const acciones: Record<string, (e: Entrada, ctx: Contexto) => Promise<unknown>> = {
  async buscar_deudores(e, ctx) {
    const palabras = norm(e.texto ?? '').split(/[\s,.;:]+/).filter(Boolean);
    if (e.estado && !ESTADOS.includes(e.estado)) throw new Problema(`Estado desconocido. Los estados son: ${ESTADOS.join(', ')}.`);
    if (!palabras.length && !e.estado) throw new Problema('Decime qué buscar: un nombre, un DNI, un socio o un estado.');
    const todos: any[] = [];
    for (let desde = 0; ; desde += 1000) {
      const tramo = await ctx.db.leer('deudores', `select=${CAMPOS},operaciones&order=nombre&offset=${desde}&limit=1000`);
      todos.push(...tramo);
      if (tramo.length < 1000) break;
    }
    const hallan = todos.filter((d) => {
      if (e.estado ? d.estado !== e.estado : ['Archivado', 'Cancelado'].includes(d.estado) && palabras.length === 0) return false;
      const pajar = norm([d.nombre, d.trato, d.dni, d.socio, d.expte, d.email, d.notas, ...(d.telefonos || []).map((t: any) => t.numero),
        ...(d.operaciones || []).map((o: any) => `${o.numero} ${o.vehiculo}`)].join(' '));
      return palabras.every((p) => pajar.includes(p));
    });
    return { encontrados: hallan.length, deudores: hallan.slice(0, 20).map(resumen), ...(hallan.length > 20 ? { nota: 'Hay más: afiná la búsqueda.' } : {}) };
  },

  async ver_deudor(e, ctx) {
    const d = await deudor(ctx, e.id);
    const f = fechaOpc(e.a_la_fecha, 'a_la_fecha');
    const liq = await ctx.db.rpc('chat_liquidacion_deudor', { p_deudor: d.id, p_fecha: f, p_a_vencer: !!e.con_cuotas_a_vencer });
    const orden = (a: any, b: any) => String(b.fecha || '').localeCompare(String(a.fecha || '')) || String(b.creado || '').localeCompare(String(a.creado || ''));
    return {
      ...resumen(d), trato: d.trato || null, domicilio: d.domicilio || null, email: d.email || null, telefonos: d.telefonos || [],
      tasa_mensual_pct: d.tasa, honorarios_pct: d.hon_pct, notas: d.notas || null,
      liquidacion: {
        fecha: liq.fecha, rubros: (liq.rubros || []).map((r: any) => ({ id: r.id, rubro: r.nombre, devengado: r.devengado, pagado: r.pagado, saldo: r.saldo })),
        total: liq.total, cuotas_vencidas: liq.vencidas, dias_de_mora: liq.dias_mora,
        ...(+liq.capital_a_vencer ? { capital_a_vencer: liq.capital_a_vencer } : {}),
      },
      planes: (d.planes || []).map((p: any) => ({ id: p.id, estado: p.estado, fecha: p.fecha, deuda: p.deuda, anticipo: p.anticipo, cuotas: (p.cuotas || []).length, nota: p.nota || null })),
      ultimos_pagos: [...(d.pagos || [])].sort(orden).slice(0, 8).map((p: any) => ({ fecha: p.fecha, recibo: p.recibo || null, medio: p.medio || null, imputacion: p.imp, plan: p.plan || null })),
      ultimas_gestiones: [...(d.gestiones || [])].sort(orden).slice(0, 8).map((g: any) => ({ fecha: g.fecha, tipo: g.tipo, texto: g.texto, ...(g.promesa_fecha ? { promesa_fecha: g.promesa_fecha, promesa_monto: g.promesa_monto } : {}) })),
      ultimo_cambio: d.actualizado ? { cuando: d.actualizado, quien: d.actualizado_por } : undefined,
    };
  },

  async listar_pendientes_cobranza(e, ctx) {
    const hasta = fechaOpc(e.hasta, 'hasta');
    const filas = await ctx.db.leer('deudores', `estado=eq.En%20gesti%C3%B3n&proxima=neq.&select=id,nombre,estado,expte,dni,socio,proxima,vence&order=vence.asc.nullslast&limit=200`);
    const lista = filas.filter((d: any) => !hasta || (d.vence && d.vence <= hasta));
    return {
      hoy: ctx.hoy.fecha,
      pendientes: lista.slice(0, 40).map((d: any) => ({ ...resumen(d), ...(d.vence && d.vence < ctx.hoy.fecha ? { vencida: true } : {}) })),
      ...(lista.length > 40 ? { nota: `Hay ${lista.length - 40} más.` } : {}),
    };
  },

  async anotar_gestion(e, ctx) {
    const d = await deudor(ctx, e.id, 'id,nombre');
    const texto = String(e.texto ?? '').trim();
    if (!texto) throw new Problema('Falta el texto de la gestión.');
    if (!TIPOS.includes(e.tipo)) throw new Problema(`Tipo desconocido. Los tipos son: ${TIPOS.join(', ')}.`);
    const promesa = fechaOpc(e.promesa_fecha, 'promesa_fecha');
    await ctx.db.rpc('chat_anotar_gestion', {
      p_deudor: d.id, p_texto: texto, p_tipo: e.tipo, p_fecha: fechaOpc(e.fecha, 'fecha'),
      p_promesa_fecha: promesa, p_promesa_monto: promesa ? +e.promesa_monto || 0 : null,
    });
    ctx.cambios = true;
    ctx.acciones.push(`${d.nombre}: gestión "${e.tipo}" anotada${promesa ? ` (promesa para el ${dma(promesa)})` : ''}`);
    return { listo: true };
  },

  async fijar_proxima_accion(e, ctx) {
    const d = await deudor(ctx, e.id, 'id,nombre');
    const texto = String(e.texto ?? '').trim();
    const vence = fechaOpc(e.vence, 'vence');
    await ctx.db.rpc('chat_proxima_deudor', { p_deudor: d.id, p_texto: texto, p_vence: vence });
    ctx.cambios = true;
    ctx.acciones.push(texto ? `${d.nombre}: próxima acción "${texto}"${vence ? ` para el ${dma(vence)}` : ''}` : `${d.nombre}: próxima acción borrada`);
    return { listo: true };
  },

  async registrar_pago(e, ctx) {
    const d = await deudor(ctx, e.id, 'id,nombre');
    if (!esFecha(e.fecha)) throw new Problema('La fecha del pago tiene que ser AAAA-MM-DD.');
    if (!e.imputacion || typeof e.imputacion !== 'object' || Array.isArray(e.imputacion)) throw new Problema('Falta la imputación por rubro.');
    const liq = await ctx.db.rpc('chat_registrar_pago', {
      p_deudor: d.id, p_fecha: e.fecha, p_imp: e.imputacion, p_recibo: String(e.recibo ?? ''), p_medio: String(e.medio ?? ''),
      p_nota: String(e.nota ?? ''), p_plan: String(e.plan ?? ''),
    });
    const total = Object.values(e.imputacion as Record<string, number>).reduce((a, v) => a + (+v || 0), 0);
    ctx.cambios = true;
    ctx.acciones.push(`${d.nombre}: pago del ${dma(e.fecha)} registrado ($ ${total.toLocaleString('es-AR')})`);
    return { listo: true, saldo_total: liq?.total?.saldo, rubros: (liq?.rubros || []).map((r: any) => ({ rubro: r.nombre, saldo: r.saldo })) };
  },
};

/** Corre una herramienta y devuelve el tool_result para Claude. Nunca lanza: un error vuelve explicado. */
export async function ejecutarCobranzas(bloque: { id: string; name: string; input: Entrada }, ctx: Contexto) {
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
    return resultado({ error: 'Falló algo inesperado al hacerlo. No sé si quedó hecho: revisá la ficha antes de repetir.' }, true);
  }
}
