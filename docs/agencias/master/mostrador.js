// Venta de mostrador y cotización rápida del panel máster: la persona va a la Mutual sin pasar por una agencia.
// Tres pasos: el CUIT en el BCRA, el vehículo y el crédito, y los datos del cliente, con «Aprobar crédito» ahí mismo
// (pedido de la persona del 27/11/2026: sin el paso de ingresos ni el de documentación; los documentos son opcionales).
// La Mutual puede apartarse de las condiciones de las agencias (monto y tasa): la pantalla lo avisa, no lo impide.
// Acá se arma el HTML y se maneja lo que se toca; la red está en ../../cobranzas/datos.js.
import { consultarBCRA, cotizadorMutual, aprobarMostrador, subirDocMostrador, mensaje } from '../../cobranzas/datos.js';
import { simularCredito } from '../../cobranzas/vehiculos.js';
import { esc, plata, hoy } from '../../cobranzas/textos.js';
import { MAX_BYTES, NUPCIAS, cuitValido, dniDelCuit, esJuridica, revisarDatos, tipoArchivo } from '../solicitud.js';

/** El identificador fijo de las solicitudes de mostrador (el mismo que usa la base). */
const MAX_DOCS = 40;
const LADO_FOTO = 2000;

export const nuevoMostrador = () => ({
  cuit: '', bcra: null, buscando: false, errorBcra: '',
  marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anio: '', buscaVer: '',
  cuotas: '', cargando: '', error: '', base: null, monto: '', tasa: '',
  datos: {}, docs: [], preparando: 0, errores: [], errorAprobar: '', confirmar: false, aprobando: '', pedido: 0,
});
export const nuevaRapida = () => ({ capital: '', cuotas: '', tasa: '', g: null, res: null, error: '' });

/** «1.500.000», «1,2» → número. */
const numAR = (x) => { const n = Number(String(x ?? '').trim().replace(/\s|\$|%/g, '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
/** Una tasa admite el punto como decimal: «6.5» son seis y medio, no sesenta y cinco. */
const tasaAR = (x) => { const t = String(x ?? '').trim().replace('%', '').replace(',', '.'); return t === '' ? null : Number(t); };
const escribir = (n, dec = 2) => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: dec });
const miles = (n) => Math.round(Number(n) || 0).toLocaleString('es-AR');
const cuitLindo = (c) => (/^\d{11}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c);
const anioTxt = (a) => (a === '0km' ? '0 km' : String(a));

/** La tasa habitual según el año del modelo: la misma regla que la función `agencias` (tasaPara). */
export function tasaHabitual(anio, a, anioActual = Number(hoy().slice(0, 4))) {
  const y = anio === '0km' ? anioActual : Math.trunc(Number(anio));
  let mejor = null;
  for (const t of Array.isArray(a?.tasas) ? a.tasas : []) {
    const desde = Math.trunc(Number(t?.desde)), tasa = Number(t?.tasa);
    if (Number.isFinite(desde) && tasa >= 0 && desde <= y && (!mejor || desde > mejor.desde)) mejor = { desde, tasa };
  }
  return mejor ? mejor.tasa : Number(a?.tasa_mensual) || 0;
}
const plazosDe = (a) => (Array.isArray(a?.plazos) ? a.plazos : []).map(Number).filter((n) => n >= 1 && n <= 120).sort((x, y) => x - y);
const cuotasTxt = (n) => `${n} ${Number(n) === 1 ? 'cuota' : 'cuotas'}`;

/**
 * El crédito que se está armando: lo que respondió el cotizador (el máximo y el valor del vehículo) más lo que la Mutual
 * haya cambiado. null si todavía no se pidió. `avisos` dice en qué se aparta de lo habitual.
 */
export function creditoElegido(M, a) {
  const B = M.base;
  if (!B) return null;
  const monto = numAR(M.monto) || B.monto;
  const habitual = tasaHabitual(B.anio, a);
  const t = tasaAR(M.tasa), tasa = t === null ? habitual : t;
  if (!(tasa >= 0 && tasa <= 100)) return { error: 'Revisá la tasa mensual.' };
  const sim = simularCredito({ capital: monto, cuotas: B.cuotas, g: a?.gastos || {}, tasa });
  if (!sim) return { error: 'No se pudo calcular el crédito con estos datos.' };
  const pct = B.valor ? Math.round((monto / B.valor) * 1000) / 10 : 0;
  const avisos = [];
  if (B.maximo && monto > B.maximo) avisos.push(`Supera el máximo que ven las agencias (${plata(B.maximo)}): es el ${escribir(pct, 1)} % del valor del vehículo.`);
  if (tasa !== habitual) avisos.push(`La tasa habitual para este modelo es ${escribir(habitual)} % mensual.`);
  return { monto, tasa, habitual, sim, pct, avisos, cuotas: B.cuotas, anio: B.anio, vehiculo: B.vehiculo };
}

// ───────────────────────── Pantalla ─────────────────────────
const campo = (ruta, rotulo, valor, extra = '', clase = '') => `<label class="f${clase}">${esc(rotulo)}<input data-k="ag.mos.${ruta}" value="${esc(valor ?? '')}" autocomplete="off"${extra}></label>`;
const lista = (ruta, rotulo, valor, opciones, extra = '') => `<label class="f">${esc(rotulo)}<select data-k="ag.mos.${ruta}"${extra}>${opciones.map(([v, t]) => `<option value="${esc(v)}"${String(valor ?? '') === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const aviso = (t) => (t ? `<p class="aviso-chico m0" role="alert">${esc(t)}</p>` : '');

const BCRA_TXT = { verde: 'Verde', amarillo: 'Amarillo', rojo: 'Rojo', sin_datos: 'Sin antecedentes' };

function paso1(M) {
  const B = M.bcra;
  if (!B) {
    return `<section class="card"><div class="card-cab"><h3>1 · El cliente</h3></div>
      ${campo('cuit', 'CUIT o CUIL del cliente', M.cuit, ' inputmode="numeric" maxlength="20" placeholder="Ej.: 20-12345678-6"')}
      ${aviso(M.errorBcra)}
      <div class="actions"><button class="btn primary" data-a="mo-bcra" ${M.buscando ? 'disabled' : ''}>${M.buscando ? 'Consultando…' : 'Consultar BCRA'}</button></div>
      <p class="hint m0">Se consulta la Central de Deudores del BCRA. Hacelo con el consentimiento del cliente. La consulta queda guardada.</p></section>`;
  }
  const clase = B.semaforo === 'sin_datos' ? 'amarillo' : B.semaforo;
  return `<section class="card"><div class="card-cab"><h3>1 · El cliente</h3><button class="btn small" data-a="mo-otro">Otro cliente</button></div>
    <div><b class="ag-nombre">${esc(B.denominacion || 'Sin nombre informado')}</b>
      <div>CUIT ${esc(cuitLindo(B.cuit))} · <span class="sem-punto ${esc(clase)}" aria-hidden="true"></span> BCRA: ${esc(BCRA_TXT[B.semaforo] || B.semaforo)}</div></div>
    ${(B.motivos || []).length ? `<p class="hint m0">${esc(B.motivos.join(' · '))}</p>` : ''}
    <p class="hint m0">Deuda informada: <b>${plata(B.deuda_total)}</b>${B.entidades ? ` · ${B.entidades} ${B.entidades === 1 ? 'entidad' : 'entidades'}` : ''}</p></section>`;
}

const versionesDelAnio = (M) => (M.versiones || []).filter((v) => !M.anio || (v.anios || []).includes(M.anio));
const aniosDelModelo = (M) => [...new Set((M.versiones || []).flatMap((v) => v.anios || []))].sort((a, b) => (a === '0km' ? -1 : b === '0km' ? 1 : b - a));
const normal = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function paso2(M, A) {
  const a = A.ajustes || {}, plazos = plazosDe(a);
  const sel = (ruta, rotulo, valor, xs, cargando, apagado) => lista(ruta, rotulo, valor,
    [['', cargando ? 'Cargando…' : 'Elegí'], ...(xs || [])], ` data-re="1" data-mo="${ruta}"${apagado ? ' disabled' : ''}`);
  const palabras = normal(M.buscaVer).split(/\s+/).filter(Boolean);
  const todas = versionesDelAnio(M);
  const vers = todas.filter((v) => v.ref === M.version || palabras.every((p) => normal(v.nombre).includes(p)));
  const c = creditoElegido(M, a);
  return `<section class="card"><div class="card-cab"><h3>2 · El vehículo y el crédito</h3></div>
    <div class="grid2">
      ${sel('marca', 'Marca', M.marca, (M.marcas || []).map((x) => [x.id, x.nombre]), M.cargando === 'marcas', !M.marcas)}
      ${sel('modelo', 'Modelo', M.modelo, (M.modelos || []).map((x) => [x.id, x.nombre]), M.cargando === 'modelos', !M.modelos)}
      ${sel('anio', 'Año', M.anio, aniosDelModelo(M).map((y) => [y, anioTxt(y)]), M.cargando === 'versiones', !M.versiones)}
      ${todas.length > 8 ? campo('buscaVer', 'Buscar versión', M.buscaVer, ' data-re="1" placeholder="Escribí y salí del campo"') : ''}
      ${sel('version', 'Versión', M.version, vers.map((x) => [x.ref, x.nombre]), false, !M.anio)}
      ${lista('cuotas', 'Cuotas', M.cuotas || plazos[plazos.length - 1] || '', plazos.map((n) => [n, cuotasTxt(n)]), ' data-re="1" data-mo="cuotas"')}
    </div>
    ${aviso(M.error)}
    ${!M.base ? `<div class="actions"><button class="btn primary" data-a="mo-ver" ${!M.version || !M.anio || M.cargando ? 'disabled' : ''}>${M.cargando === 'cotizar' ? 'Calculando…' : 'Ver crédito'}</button></div>` : `
    <p class="hint m0">${esc(M.base.vehiculo)} (${esc(anioTxt(M.base.anio))})${M.base.valor ? ` · valor de referencia ${plata(M.base.valor)}` : ''}</p>
    <div class="grid2">
      ${campo('monto', 'Monto del crédito ($)', M.monto, ` inputmode="numeric" data-re="1" placeholder="${esc(miles(M.base.monto))}"`)}
      ${campo('tasa', 'Tasa mensual (%)', M.tasa, ` inputmode="decimal" data-re="1" placeholder="${esc(escribir(tasaHabitual(M.base.anio, a)))}"`)}
    </div>
    <p class="hint m0">Si dejás vacíos el monto y la tasa, va el máximo y la tasa habitual.</p>
    ${c?.error ? aviso(c.error) : htmlCuota(c)}`}
  </section>`;
}

const htmlCuota = (c) => `<div class="mo-cuota" role="status">
  <div><span class="hint">Monto</span><b>${plata(c.monto)}</b></div>
  <div><span class="hint">${cuotasTxt(c.cuotas)} de</span><b>${plata(c.sim.cuota)}</b></div>
  <div><span class="hint">Total</span><b>${plata(c.sim.totalCredito)}</b></div></div>
  <p class="hint m0">Tasa ${escribir(c.tasa)} % mensual · gastos de otorgamiento ${plata(c.sim.gastos)}${c.pct ? ` · se presta el ${escribir(c.pct, 1)} % del valor` : ''}</p>
  ${c.avisos.map((t) => `<p class="aviso-chico mo-fuera m0" role="status"><b>Fuera de lo habitual.</b> ${esc(t)}</p>`).join('')}`;

function paso3(M, A) {
  const c = creditoElegido(M, A.ajustes || {});
  if (!c || c.error) return '';
  const d = M.datos, juridica = esJuridica(M.bcra.cuit), v = (k) => d[k] ?? '';
  const t = (k, rotulo, extra = '', clase = '') => campo(`datos.${k}`, rotulo, v(k), extra, clase);
  const f = (k, rotulo) => t(k, rotulo, ` type="date" max="${hoy()}"`);
  const s = (k, rotulo, ops) => lista(`datos.${k}`, rotulo, v(k), [['', 'Elegí'], ...ops], ' data-re="1"');
  const persona = juridica ? `<p class="hint m0">Razón social: <b>${esc(M.bcra.denominacion || M.bcra.cuit)}</b></p>
    <div class="grid2">${t('representante_nombre', 'Representante: apellido y nombre', ' maxlength="200"')}${t('representante_dni', 'Representante: DNI', ' inputmode="numeric"')}${t('representante_cargo', 'Cargo', ' maxlength="100"')}</div>`
    : `<div class="grid2">${t('dni', 'DNI', ' inputmode="numeric" maxlength="12"')}${t('nacionalidad', 'Nacionalidad', ' maxlength="80"')}${f('nacimiento', 'Fecha de nacimiento')}</div>`;
  const civil = juridica ? '' : `<div class="grid2">${s('estado_civil', 'Estado civil', [['soltero', 'Soltero/a'], ['casado', 'Casado/a']])}
    ${v('estado_civil') === 'casado' ? t('matrimonio_lugar', 'Lugar del matrimonio') + f('matrimonio_fecha', 'Fecha del matrimonio') + s('matrimonio_nupcias', '¿En qué nupcias?', NUPCIAS) : ''}</div>
    ${v('estado_civil') === 'casado' ? `<p class="hint m0"><b>Datos del cónyuge</b></p><div class="grid2">${t('conyuge_nombre', 'Apellido y nombre')}${t('conyuge_dni', 'DNI', ' inputmode="numeric"')}${t('conyuge_nacionalidad', 'Nacionalidad')}${f('conyuge_nacimiento', 'Fecha de nacimiento')}${t('conyuge_domicilio', 'Domicilio')}</div>` : ''}`;
  const hayCuenta = String(v('cbu')).trim() || String(v('alias')).trim();
  return `<section class="card"><div class="card-cab"><h3>3 · Datos del cliente</h3></div>
    ${persona}
    ${t('actividad', 'Empleo, profesión o actividad (opcional)', ' maxlength="200"')}
    <p class="hint m0"><b>${juridica ? 'Domicilio o sede social' : 'Domicilio real'}</b></p>
    <div class="grid2">${t('dom_calle', 'Calle')}${t('dom_numero', 'Número', ' placeholder="o S/N"')}${t('dom_piso', 'Piso (opcional)')}${t('dom_depto', 'Depto. (opcional)')}${t('dom_localidad', 'Localidad')}${t('dom_cp', 'Código postal', ' maxlength="8"')}${t('dom_departamento', 'Departamento (opcional)')}${t('dom_provincia', 'Provincia')}</div>
    ${civil}
    <div class="grid2">${t('celular', 'Celular, con característica', ' type="tel" inputmode="tel" maxlength="25"')}
      ${s('asociado', juridica ? '¿La empresa es asociada a la Mutual?' : '¿Es asociado a la Mutual?', [['si', 'Sí'], ['no', 'No']])}
      ${t('cbu', 'CBU o CVU (opcional)', ' inputmode="numeric" maxlength="30" data-re="1"')}${t('alias', 'O el alias (opcional)', ' autocapitalize="none" spellcheck="false" maxlength="20" data-re="1"')}
      ${hayCuenta ? s('cuenta', '¿De quién es la cuenta?', [['propia', 'Del cliente'], ['terceros', 'De un tercero']]) : ''}</div>
    ${hayCuenta && v('cuenta') === 'terceros' ? `<div class="grid2">${t('cuenta_titular', 'Titular de la cuenta')}${t('cuenta_cuit', 'CUIT o CUIL del titular', ' inputmode="numeric"')}${t('cuenta_relacion', 'Relación con el cliente (opcional)')}</div>` : ''}
    <label class="f">Notas (opcional)<textarea data-k="ag.mos.datos.notas" maxlength="1000" rows="3">${esc(v('notas'))}</textarea></label>
    <div class="mo-docs"><label class="f">Adjuntar documentos (opcional: PDF o fotos)<input type="file" id="moArchivos" accept="application/pdf,image/*" multiple></label>
      <p class="hint m0">Sirven para «Leer título y DNI» al armar la prenda. Sin archivos podés aprobar igual y completar esos datos a mano.</p>
      ${M.preparando ? '<p class="hint m0">Preparando las fotos…</p>' : ''}
      ${M.docs.length ? `<ul class="mo-lista">${M.docs.map((x, i) => `<li><span>${esc(x.name)}</span><button class="btn small" data-a="mo-quitar" data-i="${i}">Quitar</button></li>`).join('')}</ul>` : ''}</div>
    ${M.errores.length ? `<div class="aviso-chico" role="alert"><b>Antes de aprobar, falta:</b><ul>${M.errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${aviso(M.errorAprobar)}
    ${M.confirmar ? `<div class="aviso-chico ag-borrar" role="alert"><span>¿Aprobar ${plata(c.monto)} en ${cuotasTxt(c.cuotas)} de ${plata(c.sim.cuota)} a ${esc(M.bcra.denominacion || cuitLindo(M.bcra.cuit))}?${c.avisos.length ? ' Está fuera de lo habitual.' : ''}</span>
      <div class="actions"><button class="btn primary" data-a="mo-aprobar-si" ${M.aprobando ? 'disabled' : ''}>${esc(M.aprobando || 'Sí, aprobar crédito')}</button><button class="btn" data-a="mo-aprobar-no" ${M.aprobando ? 'disabled' : ''}>Todavía no</button></div></div>`
      : `<div class="actions"><button class="btn primary mo-aprobar" data-a="mo-aprobar" ${M.preparando ? 'disabled' : ''}>Aprobar crédito</button></div>`}
  </section>`;
}

export function htmlMostrador(M, A) {
  return paso1(M) + (M.bcra ? paso2(M, A) + paso3(M, A) : '');
}

// ───────────────────────── Cotización rápida ─────────────────────────
const GASTOS = [['sellado', 'Sellado (%)'], ['arancel', 'Arancel del Registro (%)'], ['arancelMin', 'Arancel mínimo ($)'], ['contratos', 'Contratos ($)'], ['envio', 'Envío ($)'], ['gestoria', 'Gestoría ($)'],
  ['seguro', 'Seguro (% por cuota)'], ['administrativos', 'Gastos administrativos ($ por cuota)'], ['cuotaSocial', 'Cuota social ($ por cuota)'], ['igr', 'IGR (% de los intereses)']];
// La lista de lo que tiene que mandar el cliente: el mismo texto (de la persona) que la simulación rápida del cotizador.
const DOCS_RAPIDA = `Recordá que para avanzar en tu crédito debes enviarnos por acá:
1) Foto de DNI (ambos lados)
2) Foto de un impuesto o Servicio para constatar el domicilio
3) A) En caso de ser empleado en relación de dependencia: Últimos 6 recibos de sueldo.
    B) En caso de ser Monotributista: Constancia de Inscripción y últimos 3 pagos.
    C) En caso de ser Responsable Inscripto: Constancia de Inscripción, últimas 3 DDJJ de IVA y Ganancias.
4) Título del automotor.
5) Estado civil; en caso de ser casado/a: menciona el lugar y fecha de matrimonio
6) Nro. de celular
7) CBU dónde se va a depositar el crédito`;

export function textoRapida(r, a = {}) {
  return `Te paso las condiciones del crédito prendario de la Asociación Mutual Bell:\n\nMonto del crédito: ${plata(r.capital)}\n${cuotasTxt(r.cuotas)} de ${plata(r.cuota)}\n\n${DOCS_RAPIDA}\n\n`
    + (a.leyenda ? `${a.leyenda}\n` : '') + (a.contacto ? `${a.contacto}\n` : '');
}

/** Los gastos de la cotización rápida: los de los parámetros, salvo lo que se haya cambiado en pantalla. */
function gastosRapida(R, a) {
  const g = { ...(a.gastos || {}) };
  for (const [k] of GASTOS) if (R.g && R.g[k] !== undefined && String(R.g[k]).trim() !== '') g[k] = k === 'arancelMin' || ['contratos', 'envio', 'gestoria', 'administrativos', 'cuotaSocial'].includes(k) ? numAR(R.g[k]) : tasaAR(R.g[k]) || 0;
  return g;
}

export function calcularRapida(R, a) {
  const plazos = plazosDe(a), capital = numAR(R.capital), cuotas = Math.trunc(numAR(R.cuotas || plazos[plazos.length - 1] || 12));
  const t = tasaAR(R.tasa), tasa = t === null ? tasaHabitual('0km', a) : t;
  if (!(capital > 0)) return { error: 'Escribí el capital.' };
  if (!(cuotas >= 1 && cuotas <= 120)) return { error: 'Las cuotas tienen que ser de 1 a 120.' };
  if (!(tasa >= 0 && tasa <= 100)) return { error: 'Revisá la tasa mensual.' };
  const g = gastosRapida(R, a), sim = simularCredito({ capital, cuotas, g, tasa });
  if (!sim) return { error: 'No se pudo calcular el crédito con estos datos.' };
  const opciones = plazos.map((n) => ({ cuotas: n, cuota: simularCredito({ capital, cuotas: n, g, tasa })?.cuota })).filter((o) => o.cuota);
  return { res: { ...sim, tasa, opciones } };
}

export function htmlRapida(R, A) {
  const a = A.ajustes || {}, plazos = plazosDe(a), r = R.res;
  const c = (k, rotulo, val, pista = '') => `<label class="f">${esc(rotulo)}<input data-k="ag.rap.${k}" value="${esc(val ?? '')}" inputmode="decimal" autocomplete="off" placeholder="${esc(pista)}"></label>`;
  return `<section class="card"><div class="card-cab"><h3>Cotización rápida</h3></div>
    <div class="grid2">${c('capital', 'Capital ($)', R.capital, 'Ej.: 5.000.000')}${c('cuotas', 'Cuotas (1 a 120)', R.cuotas, String(plazos[plazos.length - 1] || 12))}${c('tasa', 'Tasa mensual (%)', R.tasa, escribir(tasaHabitual('0km', a)))}</div>
    <details class="ag-mas"><summary>Gastos (vacío = el de los parámetros)</summary><div class="grid2">${GASTOS.map(([k, t]) => c(`g.${k}`, t, R.g?.[k], escribir(a.gastos?.[k] || 0))).join('')}</div></details>
    ${aviso(R.error)}
    <div class="actions"><button class="btn primary" data-a="mr-calcular">Calcular</button></div></section>
  ${r ? `<section class="card" id="mrResultado"><div class="mo-cuota"><div><span class="hint">Monto</span><b>${plata(r.capital)}</b></div><div><span class="hint">${cuotasTxt(r.cuotas)} de</span><b>${plata(r.cuota)}</b></div><div><span class="hint">Total</span><b>${plata(r.totalCredito)}</b></div></div>
    <p class="hint m0">Tasa ${escribir(r.tasa)} % mensual · gastos de otorgamiento ${plata(r.gastos)} (sellado ${plata(r.sellado)}, arancel ${plata(r.arancel)})</p>
    ${r.opciones.length ? `<details class="ag-mas"><summary>Cuota en cada plazo</summary><div class="ag-tabla"><table class="tabla"><tbody>${r.opciones.map((o) => `<tr><td>${cuotasTxt(o.cuotas)}</td><td class="num">${plata(o.cuota)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <div class="actions"><button class="btn primary" data-a="mr-whatsapp">Mandar por WhatsApp</button><button class="btn" data-a="mr-copiar">Copiar el mensaje</button></div></section>` : ''}`;
}

// ───────────────────────── Lo que se toca ─────────────────────────
/** Pide algo al cotizador. Si mientras tanto se eligió otra cosa (o se empezó con otro cliente), la respuesta se descarta. */
async function pedirLista(ctx, M, que, cuerpo) {
  const n = ++M.pedido;
  M.cargando = que; M.error = ''; ctx.render();
  try {
    const r = await cotizadorMutual(cuerpo);
    if (ctx.estado() !== M || n !== M.pedido) return null;
    M.cargando = '';
    return r;
  } catch (e) {
    if (ctx.estado() !== M || n !== M.pedido) return null;
    M.cargando = ''; M.error = mensaje(e, 'no se pudo consultar'); ctx.render();
    return null;
  }
}
export async function cargarMarcas(ctx) {
  const M = ctx.estado();
  if (M.marcas || M.cargando) return;
  const r = await pedirLista(ctx, M, 'marcas', { accion: 'marcas' });
  if (r) { M.marcas = r.marcas || []; ctx.render(); }
}

/** Cambió un campo de la venta. Lo que depende de él se borra; elegir marca o modelo pide la lista siguiente. */
export async function cambioMostrador(ctx, que) {
  const M = ctx.estado();
  M.confirmar = false;
  if (!que) return;
  M.base = null; M.error = '';
  if (que === 'marca') {
    Object.assign(M, { modelos: null, modelo: '', versiones: null, version: '', anio: '', buscaVer: '', monto: '', tasa: '' });
    if (!M.marca) return ctx.render();
    const r = await pedirLista(ctx, M, 'modelos', { accion: 'modelos', marca: Number(M.marca) });
    if (r) M.modelos = r.modelos || [];
  } else if (que === 'modelo') {
    Object.assign(M, { versiones: null, version: '', anio: '', buscaVer: '', monto: '', tasa: '' });
    if (!M.modelo) return ctx.render();
    const r = await pedirLista(ctx, M, 'versiones', { accion: 'versiones', marca: Number(M.marca), grupo: Number(M.modelo) });
    if (r) M.versiones = r.versiones || [];
  } else if (que === 'anio') {
    if (!versionesDelAnio(M).some((v) => v.ref === M.version)) M.version = '';
  }
  ctx.render();
}

async function verCredito(ctx) {
  const M = ctx.estado(), a = ctx.ajustes();
  const plazos = plazosDe(a), cuotas = Number(M.cuotas || plazos[plazos.length - 1]);
  const vehiculo = [(M.marcas || []).find((x) => String(x.id) === String(M.marca))?.nombre, (M.modelos || []).find((x) => String(x.id) === String(M.modelo))?.nombre,
    (M.versiones || []).find((x) => x.ref === M.version)?.nombre].filter(Boolean).join(' ');
  const r = await pedirLista(ctx, M, 'cotizar', { accion: 'cotizar', ref: M.version, anio: M.anio, cuotas, vehiculo });
  if (!r) return;
  if (!r.financiable) M.error = r.mensaje || 'Este vehículo no se puede financiar.';
  else M.base = { monto: r.monto, maximo: r.maximo, valor: r.valor_vehiculo || 0, cuotas: r.cuotas, anio: r.anio, vehiculo };
  ctx.render();
}

/** Los datos como los controla la solicitud de una agencia: «si/no» pasa a verdadero o falso. */
export function controlarDatos(M) {
  const d = { ...M.datos, asociado: M.datos.asociado === 'si' ? true : M.datos.asociado === 'no' ? false : undefined };
  // El formulario completo trae el domicilio por casilleros: aunque la calle esté vacía, se controla así.
  d.dom_calle = d.dom_calle ?? '';
  return revisarDatos(d, hoy(), esJuridica(M.bcra?.cuit));
}

/** Un PDF va como está; una foto se achica y se pasa a JPG (como en el cotizador). */
async function prepararArchivo(f) {
  const nombre = f.name || 'archivo';
  const tipo = tipoArchivo(new Uint8Array(await f.slice(0, 8).arrayBuffer()));
  if (tipo?.ext === 'pdf') {
    if (f.size > MAX_BYTES) throw new Error(`«${nombre}» pesa más de 10 MB: mandalo más liviano o como fotos.`);
    return f;
  }
  let bmp;
  try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch {
    if (tipo?.ext === 'jpg' && f.size <= MAX_BYTES) return f;
    throw new Error(`«${nombre}» no es un PDF ni una foto que se pueda leer.`);
  }
  const k = Math.min(1, LADO_FOTO / Math.max(bmp.width, bmp.height));
  const cv = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bmp.width * k)), height: Math.max(1, Math.round(bmp.height * k)) });
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
  cx.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.85));
  if (!blob || blob.size > MAX_BYTES) throw new Error(`No se pudo preparar «${nombre}». Probá con otra foto o en PDF.`);
  return new File([blob], `${nombre.replace(/\.[^.]*$/, '') || 'foto'}.jpg`, { type: 'image/jpeg' });
}

export async function agregarDocs(ctx, files) {
  const M = ctx.estado();
  M.errorAprobar = '';
  for (const f of files) {
    if (M.docs.length >= MAX_DOCS) { M.errorAprobar = `Van hasta ${MAX_DOCS} archivos.`; break; }
    M.preparando++; ctx.render();
    try { M.docs.push(await prepararArchivo(f)); } catch (e) { M.errorAprobar = e.message; }
    M.preparando--;
  }
  ctx.render();
}

async function aprobar(ctx) {
  const M = ctx.estado(), c = creditoElegido(M, ctx.ajustes());
  if (M.aprobando || !c || c.error) return;
  const r = controlarDatos(M);
  if (r.errores) { M.errores = r.errores; M.confirmar = false; ctx.render(); return; }
  M.aprobando = 'Aprobando…'; M.errorAprobar = ''; ctx.render();
  let id;
  try {
    id = await aprobarMostrador({
      cuit: M.bcra.cuit, consulta: M.bcra.id, vehiculo: c.vehiculo.slice(0, 200), anio: String(c.anio),
      monto: c.monto, cuotas: c.cuotas, cuota: c.sim.cuota, total: c.sim.totalCredito, tasa: c.tasa,
      datos: { ...r.datos, ...(c.pct ? { pct_valor: c.pct } : {}) },
    });
  } catch (e) { M.aprobando = ''; M.errorAprobar = mensaje(e, 'no se aprobó'); ctx.render(); return; }
  const fallaron = [];
  for (const [i, f] of M.docs.entries()) {
    M.aprobando = `Subiendo ${i + 1} de ${M.docs.length}…`; ctx.render();
    try { await subirDocMostrador(id, f); } catch (e) { console.error(e); fallaron.push(f.name); }
  }
  await ctx.aprobado(fallaron);
}

export async function accionMostrador(ctx, act, b) {
  const M = ctx.estado();
  if (act === 'mo-otro') { ctx.reiniciar(); await cargarMarcas(ctx); return; }
  if (act === 'mo-bcra') {
    if (M.buscando) return;
    const cuit = String(M.cuit).replace(/\D/g, '');
    if (!cuitValido(cuit)) { M.errorBcra = 'Ese CUIT o CUIL no es válido: revisá los números.'; ctx.render(); return; }
    M.buscando = true; M.errorBcra = ''; ctx.render();
    try {
      M.bcra = await consultarBCRA(cuit);
      if (!esJuridica(cuit) && !M.datos.dni) M.datos.dni = dniDelCuit(cuit);
    } catch (e) { M.errorBcra = mensaje(e, 'no se pudo consultar'); }
    M.buscando = false; ctx.render();
    if (M.bcra) await cargarMarcas(ctx);
    return;
  }
  if (act === 'mo-ver') { await verCredito(ctx); return; }
  if (act === 'mo-quitar') { M.docs.splice(Number(b.dataset.i), 1); ctx.render(); return; }
  if (act === 'mo-aprobar') {
    const r = controlarDatos(M);
    M.errores = r.errores || []; M.confirmar = !r.errores; M.errorAprobar = ''; ctx.render();
    return;
  }
  if (act === 'mo-aprobar-no') { M.confirmar = false; ctx.render(); return; }
  if (act === 'mo-aprobar-si') await aprobar(ctx);
}
