// Vista «Agencias» de Créditos y Cobros: lo que la Mutual administra del cotizador para agencias
// (docs/agencias/). Acá solo se arma el HTML y se leen los formularios; los datos los trae datos.js y los
// eventos están en app.js (acciones `ag-…`). Las agencias usan el cotizador con su propia cuenta; la Mutual
// decide desde acá, con su sesión de siempre.
import { esc, plata, cuantos } from './textos.js';
// Los casilleros de documentos y los nombres de las categorías son los del cotizador (un solo lugar).
import { CATEGORIAS, DOCS, docsSinAdjuntar, dniDelCuit } from '../agencias/solicitud.js';

export const TABS_AGENCIAS = [['solicitudes', 'Solicitudes'], ['chats', 'Chats'], ['parametros', 'Parámetros'], ['agencias', 'Agencias'], ['cotizaciones', 'Cotizaciones'], ['estadisticas', 'Estadísticas']];

/** El color del BCRA como un círculo (pedido de la persona, nov 2026: sin el texto de lo que vio la agencia).
 *  Sin antecedentes va en amarillo, como la agencia lo ve («Sujeto a revisión»); el nombre queda para lectores de pantalla. */
const SEM = {
  verde: ['verde', 'Verde'],
  amarillo: ['amarillo', 'Amarillo'],
  sin_datos: ['amarillo', 'Sin antecedentes'],
  rojo: ['rojo', 'Rojo'],
};
const circulo = (s) => { const [c, nombre] = SEM[s] || ['', String(s ?? '')]; return `<span class="sem-punto ${c}" role="img" aria-label="BCRA: ${esc(nombre)}" title="${esc(nombre)}"></span>`; };
const ESTADO = { pendiente: ['Recibida', 't-prom'], en_analisis: ['En análisis', 't-prom'], aprobada: ['Aprobada', 't-plan'], rechazada: ['Rechazada', 't-mal'] };

const etiqueta = ([texto, clase]) => `<span class="tag ${clase}">${esc(texto)}</span>`;
const cuitLindo = (c) => (/^\d{11}$/.test(String(c)) ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : String(c ?? ''));
const anioTxt = (a) => (a === '0km' ? '0 km' : String(a ?? ''));
const pct = (n) => `${(Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
const fechaHora = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const tamano = (n) => (n >= 1048576 ? `${(n / 1048576).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const fila = (t, v) => `<tr><td>${t}</td><td class="num">${v}</td></tr>`;

/** "1,2" o "1.2" → 1.2; "13.000" → 13000; vacío → null; si no es un número, NaN. */
export function numero(s) {
  let t = String(s ?? '').trim().replace(/\s|\$|%/g, '');
  if (t === '') return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
/** Para mostrar en un campo: decimales con coma, sin separador de miles. */
const enCampo = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));

/** [1,2,…,24] → "1-24"; [12,18,24] → "12, 18, 24". */
export function plazosTexto(xs) {
  const v = [...new Set((xs || []).map(Number))].sort((a, b) => a - b), out = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(j - i >= 2 ? `${v[i]}-${v[j]}` : v.slice(i, j + 1).join(', '));
    i = j;
  }
  return out.join(', ');
}

const GASTOS = [
  ['sellado', 'Sellado (% del total del crédito)'], ['arancel', 'Arancel (% del total del crédito)'], ['arancelMin', 'Arancel mínimo ($)'],
  ['contratos', 'Contratos y administrativos ($)'], ['envio', 'Envío de documentación ($)'], ['gestoria', 'Gestoría ($)'],
  ['redondeo', 'Redondeo de gastos ($; vacío = automático)'], ['seguro', 'Seguro de vida (% del capital por cuota)'],
  ['administrativos', 'Gastos administrativos ($ por cuota)'], ['cuotaSocial', 'Cuota social ($ por cuota)'], ['igr', 'IGR (% de los intereses)'],
];

/** El formulario de parámetros como texto, para atarlo a S (así sobrevive a los redibujos). */
export function parametrosEnTexto(j = {}) {
  const g = j.gastos || {}, p = {
    habilitado: !!j.habilitado, pct_financiable: enCampo(j.pct_financiable), tasa_mensual: enCampo(j.tasa_mensual), plazos: plazosTexto(j.plazos),
    tasas: (j.tasas || []).map((t) => `${t.desde}=${enCampo(t.tasa)}`).join('; '), anio_minimo: enCampo(j.anio_minimo),
    antiguedad_max: enCampo(j.antiguedad_max), monto_minimo: enCampo(j.monto_minimo), monto_maximo: enCampo(j.monto_maximo),
    redondeo: enCampo(j.redondeo), tope_diario: enCampo(j.tope_diario), relacion_max: enCampo(j.relacion_max ?? 45),
    leyenda: j.leyenda || '', contacto: j.contacto || '', chat_habilitado: !!j.chat_habilitado, ayuda: j.ayuda || '',
  };
  for (const [k] of GASTOS) p['g_' + k] = enCampo(g[k]);
  return p;
}

/** Del formulario a la fila de ajustes_agencias: { fila } o { error: 'texto' }. */
export function leerParametros(p) {
  const plazos = [];
  for (const parte of String(p.plazos || '').split(/[,;]+/)) {
    const m = parte.trim().match(/^(\d+)\s*(?:-|a|al)\s*(\d+)$/i);
    if (m) { for (let n = Math.min(+m[1], +m[2]); n <= Math.max(+m[1], +m[2]) && plazos.length < 200; n++) plazos.push(n); }
    else for (const n of parte.split(/[^\d]+/).filter(Boolean).map(Number)) plazos.push(n);
  }
  const tasas = [];
  for (const parte of String(p.tasas || '').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = parte.match(/^(\d{4})\s*[=:]\s*([\d.,]+)\s*%?$/);
    const t = m ? numero(m[2]) : NaN;
    if (!m || !(t >= 0)) return { error: 'Las tasas por modelo van así: 2021=5; 2018=6; 2014=7 (desde ese año, esa tasa).' };
    tasas.push({ desde: +m[1], tasa: t });
  }
  const g = {};
  for (const [k] of GASTOS) g[k] = k === 'redondeo' ? numero(p['g_' + k]) : numero(p['g_' + k]) ?? 0;
  const fila = {
    habilitado: !!p.habilitado,
    pct_financiable: numero(p.pct_financiable), tasa_mensual: numero(p.tasa_mensual),
    plazos: [...new Set(plazos.filter((n) => n >= 1 && n <= 120))].sort((a, b) => a - b),
    anio_minimo: numero(p.anio_minimo), tasas: tasas.sort((x, y) => y.desde - x.desde),
    antiguedad_max: numero(p.antiguedad_max), monto_minimo: numero(p.monto_minimo) ?? 0, monto_maximo: numero(p.monto_maximo),
    redondeo: numero(p.redondeo) || 1, tope_diario: numero(p.tope_diario) || 300, relacion_max: numero(p.relacion_max) ?? 45,
    leyenda: String(p.leyenda || '').trim(), contacto: String(p.contacto || '').trim(), gastos: g,
    chat_habilitado: !!p.chat_habilitado, ayuda: String(p.ayuda || '').trim(),
  };
  if (!fila.plazos.length) return { error: 'Escribí al menos un plazo (por ejemplo: 12, 18, 24 o 1-24).' };
  const malos = Object.entries({ ...fila, ...g }).filter(([, x]) => typeof x === 'number' && Number.isNaN(x));
  if (malos.length || fila.pct_financiable == null || fila.tasa_mensual == null) return { error: 'Hay un número mal escrito: revisá los campos (usá coma para los decimales).' };
  if (!(fila.relacion_max > 0 && fila.relacion_max <= 100)) return { error: 'La relación cuota/ingreso tiene que estar entre 1 y 100 %.' };
  if (fila.ayuda.length > 12000) return { error: `La hoja de respuestas del chat tiene ${fila.ayuda.length.toLocaleString('es-AR')} caracteres y el máximo es 12.000.` };
  return { fila };
}

/** Pendientes primero; dentro de cada grupo, la más nueva arriba. */
/** Abiertas: las que la Mutual todavía tiene que resolver (recién recibidas o ya en análisis). */
/** Los vendedores de una agencia (migración 0042): el titular primero. */
const vendedoresDe = (A, agenciaId) => (A.vendedores || []).filter((v) => v.agencia_id === agenciaId);
/** El vendedor de una solicitud, cotización o chat; vacío si la agencia tiene una sola cuenta (el titular), para no repetir su nombre. */
function quienEs(A, x) {
  const v = (A.vendedores || []).find((y) => y.id === x.vendedor_id);
  if (!v) return '';
  return v.titular && vendedoresDe(A, v.agencia_id).length <= 1 ? '' : v.nombre;
}

export const solicitudAbierta = (x) => x.estado === 'pendiente' || x.estado === 'en_analisis';
const pendientes = (xs) => xs.filter(solicitudAbierta);

function documentos(x, docs) {
  const n = Array.isArray(x.archivos) ? x.archivos.length : 0;
  // Los documentos no son obligatorios para enviar: la Mutual ve cuáles faltan, para pedirlos por otra vía.
  const vacios = docsSinAdjuntar(x);
  const sin = vacios.length ? `<p class="aviso-chico" role="status"><b>Sin adjuntar:</b> ${esc(vacios.map((k) => DOCS[k]?.titulo || k).join('; '))}.</p>` : '';
  if (!n) return sin;
  const D = docs.get(x.id);
  const pdf = `<button class="btn" data-a="ag-pdf" data-id="${esc(x.id)}">Descargar todo en un PDF</button>`;
  if (!D || D.error) {
    return `${sin}${D?.error ? `<p class="aviso-chico" role="alert">${esc(D.error)}</p>` : ''}
      <div class="actions"><button class="btn" data-a="ag-docs" data-id="${esc(x.id)}">Ver documentos (${n})</button>${pdf}</div>`;
  }
  if (D.cargando) return '<p class="hint m0">Buscando los documentos…</p>';
  const grupos = Object.keys(DOCS).map((k) => [k, D.lista.filter((a) => a.slot === k)]).filter(([, xs]) => xs.length);
  return `${sin}<div class="ag-docs"><b>Documentos</b>${grupos.map(([k, xs]) => `<div><span class="hint">${esc(DOCS[k].titulo)}</span><ul>${xs.map((a) =>
    `<li>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.nombre)}</a>` : esc(a.nombre)} <span class="hint">${tamano(a.tamano)}</span></li>`).join('')}</ul></div>`).join('')}
    <p class="hint m0">Los enlaces vencen a los 15 minutos. Si uno vence, <button class="btn small" data-a="ag-docs" data-id="${esc(x.id)}">pedilos de nuevo</button>.</p>
    <div class="actions">${pdf}</div></div>`;
}

/**
 * Una solicitud, resumida para decidir (pedido de la persona, nov 2026): arriba y en grande la agencia; después el cliente
 * con su CUIT y el BCRA; el crédito con qué parte del valor del vehículo se presta; y el trabajo y los ingresos. Lo que
 * hace falta recién después de aprobar (DNI, domicilio, estado civil, celular, CBU, total, tasa y CFT) queda plegado.
 */
function solicitud(x, A, est, notas) {
  const b = A.bcra.get(x.consulta), motivos = Array.isArray(b?.motivos) ? b.motivos : [], d = x.datos || {};
  const dniCuit = dniDelCuit(x.cuit), pend = solicitudAbierta(x);
  const pctValor = Number(d.pct_valor) > 0 ? ` <span class="hint">(${esc(Number(d.pct_valor).toLocaleString('es-AR', { maximumFractionDigits: 1 }))} % del valor del vehículo)</span>` : '';
  const trabajo = [x.categoria ? CATEGORIAS[x.categoria] || x.categoria : '', d.actividad || ''].filter(Boolean);
  return `<section class="card ag-sol" id="sol-${esc(x.id)}">
    <div class="card-cab"><div><div class="ag-agencia">${esc(x.agencia)}${quienEs(A, x) ? ` <span class="hint">· ${esc(quienEs(A, x))}</span>` : ''}</div><div class="hint">${esc(fechaHora(x.enviada || x.momento))}</div></div>
      ${etiqueta(ESTADO[x.estado] || [x.estado, ''])}</div>
    <div class="ag-bloque"><span class="ag-rotulo">Cliente</span>
      <b class="ag-nombre">${esc(x.denominacion || cuitLindo(x.cuit))}</b>
      <div>CUIT ${esc(cuitLindo(x.cuit))} · ${circulo(x.semaforo)}</div>
      ${motivos.length ? `<div class="hint">${esc(motivos.join(' · '))}</div>` : ''}</div>
    <div class="ag-bloque"><span class="ag-rotulo">Crédito</span>
      <div><b>${plata(x.monto)}</b>${pctValor}</div>
      <div>${x.cuotas} cuotas de <b>${plata(x.cuota)}</b></div>
      <div class="hint">${esc(x.vehiculo)} (${esc(anioTxt(x.anio))})</div></div>
    <div class="ag-bloque"><span class="ag-rotulo">Trabajo e ingresos</span>
      ${trabajo.length ? `<div>${esc(trabajo.join(' · '))}</div>` : ''}
      ${x.ingreso ? `<div>Declara <b>${plata(x.ingreso)}</b> por mes · la cuota es el ${pct(x.relacion)}</div>` : '<div class="hint">No declaró ingresos</div>'}</div>
    <details class="ag-mas"><summary>Más datos del cliente y del crédito</summary>
      <div class="ag-tabla"><table class="tabla"><tbody>
        ${b ? fila('Deuda informada · entidades', `${plata(b.deuda_total)} · ${esc(b.entidades)}`) : ''}
        ${fila('Total · tasa mensual · CFT', `${plata(x.total)} · ${pct(x.tasa)} · ${pct(x.cft)}`)}
        ${d.dni ? fila('DNI', `${esc(Number(d.dni).toLocaleString('es-AR'))}${dniCuit && dniCuit !== d.dni ? ' <span class="tag t-mal">no coincide con el CUIL</span>' : ''}`) : ''}
        ${d.domicilio ? fila('Domicilio real', esc(d.domicilio)) : ''}
        ${d.estado_civil ? fila('Estado civil', d.estado_civil === 'casado' ? `Casado/a · ${esc(d.matrimonio_lugar || '')}, ${esc(String(d.matrimonio_fecha || '').split('-').reverse().join('/'))}` : 'Soltero/a') : ''}
        ${x.cliente ? fila('Celular', esc(x.cliente)) : ''}
        ${d.cbu ? fila('CBU o CVU', `<span class="mono">${esc(d.cbu)}</span>`) : fila('CBU o CVU', '<span class="hint">No lo informó la agencia</span>')}
        ${d.cuenta === 'propia' ? fila('Cuenta', 'Propia del cliente') : ''}
        ${d.cuenta === 'terceros' ? fila('Cuenta', `<span class="tag t-prom">De un tercero</span> ${esc(d.cuenta_titular || '')} · ${esc(cuitLindo(d.cuenta_cuit || ''))}${d.cuenta_relacion ? ` · ${esc(d.cuenta_relacion)}` : ''}`) : ''}
      </tbody></table></div></details>
    ${dniCuit && d.dni && dniCuit !== d.dni ? '<p class="aviso-chico m0">El DNI que cargó la agencia no coincide con el CUIL.</p>' : ''}
    ${documentos(x, est.docs)}
    ${pend ? `<label class="f">Nota para la agencia (opcional)<input data-k="ag.notas.${esc(x.id)}" value="${esc(notas[x.id] || '')}" maxlength="500" autocomplete="off"></label>
      <div class="actions">${x.estado === 'pendiente' ? `<button class="btn" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="en_analisis">Pasar a en análisis</button>` : ''}
        <button class="btn primary" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="aprobada">Aprobar</button>
        <button class="btn" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="rechazada">Rechazar</button>
        ${est.borrar === x.id ? '' : `<button class="btn" data-a="ag-borrar-preguntar" data-id="${esc(x.id)}">Eliminar</button>`}</div>`
      : `<p class="hint m0">${esc(x.resuelto_por || '')} · ${esc(fechaHora(x.resuelto))}${x.nota ? ` · «${esc(x.nota)}»` : ''}
        <button class="btn small" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="pendiente">Volver a recibida</button>
        ${est.borrar === x.id ? '' : `<button class="btn small" data-a="ag-borrar-preguntar" data-id="${esc(x.id)}">Eliminar</button>`}</p>`}
    ${est.borrar === x.id ? `<div class="aviso-chico ag-borrar" role="alert"><span>¿Eliminar la solicitud de ${esc(x.denominacion || cuitLindo(x.cuit))}? Se borran también sus documentos y no se puede deshacer desde la app.</span>
      <div class="actions"><button class="btn danger small" data-a="ag-borrar" data-id="${esc(x.id)}">Sí, eliminar</button><button class="btn small" data-a="ag-borrar-no" data-id="${esc(x.id)}">No</button></div></div>` : ''}
  </section>`;
}

/**
 * Toda la vista. `est`: { tab, msg, docs: Map(id → {cargando}|{lista}|{error}), notas: {id: texto}, p: parámetros en texto,
 * alta: {email, nombre, notas} }.
 */
/** Barras horizontales en SVG (sin librerías ni estilos en línea): una fila por agencia, una barra por serie. */
function graficoBarras(filas, series, fmt = (n) => String(n)) {
  const max = Math.max(1, ...filas.flatMap((x) => series.map(([k]) => Number(x[k] || 0))));
  const W = 640, izq = 150, ancho = W - izq - 120, alto = 12, sep = 3, pad = 14;
  const hFila = series.length * (alto + sep) + pad;
  const barras = filas.map((x, i) => {
    const y0 = i * hFila;
    return `<text class="gr-nombre" x="0" y="${y0 + 12}">${esc(corto(x.nombre, 22))}</text>` + series.map(([k, , c], j) => {
      const v = Number(x[k] || 0), w = Math.max(v ? 2 : 0, Math.round((v / max) * ancho)), y = y0 + j * (alto + sep);
      return `<rect class="gr-${c}" x="${izq}" y="${y}" width="${w}" height="${alto}" rx="3"/><text class="gr-valor" x="${izq + w + 6}" y="${y + alto - 2}">${esc(fmt(v))}</text>`;
    }).join('');
  }).join('');
  const leyenda = series.map(([, t, c]) => `<span class="gr-ley"><i class="gr-${c}"></i>${esc(t)}</span>`).join('');
  return `<div class="gr-ley-fila">${leyenda}</div><svg class="gr" viewBox="0 0 ${W} ${filas.length * hFila}" role="img" aria-label="Gráfico por agencia">${barras}</svg>`;
}

export function htmlAgencias(A, est) {
  const tabs = `<nav class="tabs" role="tablist" aria-label="Agencias">${TABS_AGENCIAS.map(([k, l]) => {
    const n = k === 'solicitudes' ? pendientes(A.solicitudes).length : k === 'agencias' ? A.agencias.filter((x) => x.activa).length : k === 'chats' ? est.chat?.atencion || 0 : 0;
    const extra = (k === 'solicitudes' || k === 'chats') && n ? ` (${n})` : k === 'agencias' ? ` (${n}/20)` : '';
    return `<button role="tab" data-a="ag-tab" data-tab="${k}" aria-selected="${est.tab === k}">${esc(l + extra)}</button>`;
  }).join('')}</nav>`;
  const msg = est.msg ? `<p class="aviso-chico" role="status">${esc(est.msg)}</p>` : '';
  let cuerpo;
  if (est.tab === 'chats') {
    cuerpo = htmlChats(est.chat || {}, A.ajustes);
  } else if (est.tab === 'parametros') {
    const p = est.p, campo = (k, t, extra = '') => `<label class="f">${esc(t)}<input data-k="ag.p.${k}" value="${esc(p[k] ?? '')}" inputmode="decimal" autocomplete="off"${extra}></label>`;
    cuerpo = `<section class="card">
      <div class="card-cab"><h3>Parámetros del crédito</h3></div>
      <label class="ag-check"><input type="checkbox" data-k="ag.p.habilitado" ${p.habilitado ? 'checked' : ''}> Cotizador habilitado para las agencias</label>
      <label class="ag-check"><input type="checkbox" data-k="ag.p.chat_habilitado" ${p.chat_habilitado ? 'checked' : ''}> Chat con la Mutual (botón «M») habilitado para las agencias</label>
      <div class="grid2">
        ${campo('pct_financiable', '% del valor del vehículo que se financia')}
        ${campo('plazos', 'Plazos en cuotas (ej.: 12, 18, 24 o un rango: 1-24)', ' inputmode="text"')}
        ${campo('tasas', 'Tasa mensual según el modelo (desde el año = tasa %)', ' inputmode="text" placeholder="2021=5; 2018=6; 2014=7"')}
        ${campo('tasa_mensual', 'Tasa mensual (%) si el modelo no entra en ningún tramo')}
        ${campo('anio_minimo', 'Modelo más viejo que se financia (año; vacío = sin tope)', ' inputmode="numeric"')}
        ${campo('antiguedad_max', 'Antigüedad máxima del vehículo (años; vacío = sin tope)')}
        ${campo('relacion_max', 'Relación cuota / ingreso máxima (%)')}
        ${campo('monto_minimo', 'Monto mínimo ($)')}
        ${campo('monto_maximo', 'Monto máximo ($; vacío = sin tope)')}
        ${campo('redondeo', 'Redondear el máximo hacia abajo a ($)')}
        ${campo('tope_diario', 'Tope de cotizaciones por agencia y por día')}
      </div>
      <div class="card-cab"><h3>Gastos (como el simulador interno)</h3></div>
      <div class="grid2">${GASTOS.map(([k, t]) => campo('g_' + k, t)).join('')}</div>
      <label class="f">Leyenda al pie de cada cotización<textarea data-k="ag.p.leyenda" maxlength="1000" rows="3">${esc(p.leyenda || '')}</textarea></label>
      <label class="f">Contacto de la Mutual (opcional; sale en la cotización)<input data-k="ag.p.contacto" value="${esc(p.contacto || '')}" maxlength="300" autocomplete="off"></label>
      <div class="card-cab"><h3>Hoja de respuestas del chat</h3></div>
      <label class="f">Lo que sabe el asistente que les contesta a las agencias primero<textarea data-k="ag.p.ayuda" maxlength="12000" rows="16">${esc(p.ayuda || '')}</textarea></label>
      <p class="hint m0">El asistente contesta solo con esto y con los datos que la agencia ya ve (plazos, relación cuota/ingreso, tope diario y contacto). Si algo no está acá, ofrece hablar con vos. No le pongas valores de vehículos, el % del valor que se financia ni tasas por año: la agencia podría deducir la valuación.</p>
      ${msg}
      <div class="actions"><button class="btn primary" data-a="ag-param-guardar">Guardar parámetros</button></div>
    </section>`;
  } else if (est.tab === 'agencias') {
    const al = est.alta;
    const filas = A.agencias.map((x) => `<tr><td><b>${esc(x.nombre)}</b><br><span class="hint">${esc(x.email)}</span>${x.notas ? `<br><span class="hint">${esc(x.notas)}</span>` : ''}</td>
      <td>${x.activa ? '<span class="tag t-plan">Activa</span>' : '<span class="tag t-mal">Pausada</span>'}</td>
      <td class="num"><button class="btn small" data-a="ag-activa" data-id="${esc(x.id)}" data-valor="${x.activa ? '0' : '1'}">${x.activa ? 'Pausar' : 'Activar'}</button></td></tr>${
      // Con una sola cuenta (el titular) no se repite nada; con más, cada vendedor en su renglón, para pausarlo por separado.
      vendedoresDe(A, x.id).length > 1 ? vendedoresDe(A, x.id).map((v) => `<tr class="ag-vend"><td>↳ ${esc(v.nombre)}${v.titular ? ' <span class="hint">(titular)</span>' : ''}<br><span class="hint">${esc(v.email)}</span></td>
      <td>${v.activo ? '<span class="tag t-plan">Activo</span>' : '<span class="tag t-mal">Pausado</span>'}</td>
      <td class="num"><button class="btn small" data-a="ag-vend-activo" data-id="${esc(v.id)}" data-valor="${v.activo ? '0' : '1'}">${v.activo ? 'Pausar' : 'Activar'}</button></td></tr>`).join('') : ''}`).join('');
    const nueva = est.nueva ? `<section class="card ag-nueva"><div class="card-cab"><h3>${est.nueva.vendedor ? 'Vendedor creado' : 'Agencia creada'}: ${esc(est.nueva.nombre)}</h3></div>
        <p class="m0">Pasale estos datos ${est.nueva.vendedor ? 'al vendedor' : 'a la agencia'}. <b>La contraseña se muestra una sola vez</b>: si cerrás esta pantalla, no se puede volver a ver.</p>
        <dl class="ag-acceso"><dt>Usuario</dt><dd class="mono">${esc(est.nueva.email)}</dd><dt>Contraseña provisoria</dt><dd class="mono">${esc(est.nueva.clave)}</dd></dl>
        <p class="hint m0">Cuando entre por primera vez, el cotizador le va a pedir que elija su propia contraseña.</p>
        <div class="actions"><button class="btn primary" data-a="ag-copiar-acceso">Copiar los datos para enviar</button><button class="btn" data-a="ag-listo">Listo, ya los copié</button></div>
      </section>` : '';
    cuerpo = `${nueva}<section class="card"><div class="card-cab"><h3>Agencias</h3><span class="hint">${A.agencias.filter((x) => x.activa).length} de 20 activas</span></div>
        ${A.agencias.length ? `<div class="ag-tabla"><table class="tabla"><tbody>${filas}</tbody></table></div>` : '<p class="hint m0">Todavía no hay agencias.</p>'}
        ${msg}</section>
      <section class="card"><div class="card-cab"><h3>Agregar una agencia</h3></div>
        <ol class="campos">
          <li>Completá esto y tocá «Crear agencia» (hasta 20 activas): se crea su cuenta con una contraseña provisoria que vas a ver una sola vez.</li>
          <li>Pasásela a la agencia: al entrar, va a tener que elegir su propia contraseña.</li>
        </ol>
        <div class="grid2">
          <label class="f">Nombre de la agencia<input data-k="ag.alta.nombre" value="${esc(al.nombre || '')}" maxlength="120" autocomplete="off"></label>
          <label class="f">Email de la cuenta<input type="email" data-k="ag.alta.email" value="${esc(al.email || '')}" autocomplete="off"></label>
          <label class="f">Notas<input data-k="ag.alta.notas" value="${esc(al.notas || '')}" maxlength="500" autocomplete="off"></label>
        </div>
        <div class="actions"><button class="btn primary" data-a="ag-crear">Crear agencia</button><button class="btn" data-a="ag-alta">Ya tiene cuenta: solo habilitar</button></div>
      </section>
      <section class="card"><div class="card-cab"><h3>Agregar un vendedor a una agencia</h3></div>
        <p class="hint m0">Cada vendedor entra con su propio usuario y ve solo lo suyo: sus cotizaciones, sus solicitudes y su chat. Pausar la agencia los pausa a todos.</p>
        <div class="grid2">
          <label class="f">Agencia<select data-k="ag.vend.agencia"><option value="">Elegí la agencia…</option>${A.agencias.filter((x) => x.activa).map((x) => `<option value="${esc(x.id)}"${(est.vend || {}).agencia === x.id ? ' selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></label>
          <label class="f">Nombre del vendedor<input data-k="ag.vend.nombre" value="${esc((est.vend || {}).nombre || '')}" maxlength="120" autocomplete="off"></label>
          <label class="f">Email de la cuenta<input type="email" data-k="ag.vend.email" value="${esc((est.vend || {}).email || '')}" autocomplete="off"></label>
        </div>
        <div class="actions"><button class="btn primary" data-a="ag-vend-crear">Crear vendedor</button></div>
      </section>`;
  } else if (est.tab === 'cotizaciones') {
    const pide = (est.borrarCot || '') !== '';
    const filas = A.cotizaciones.map((x) => `<tr><td>${esc(fechaHora(x.momento))}</td><td>${esc(x.agencia)}${quienEs(A, x) ? `<br><span class="hint">${esc(quienEs(A, x))}</span>` : ''}</td><td class="mono">${x.cuit ? esc(cuitLindo(x.cuit)) : '<span class="hint">—</span>'}</td><td>${esc(x.vehiculo)} <span class="hint">${esc(anioTxt(x.anio))}</span></td>
      <td class="num">${plata(x.monto)}</td><td class="num">${x.cuotas} × ${plata(x.cuota)}</td>
      <td class="num"><button class="btn small" data-a="ag-cot-preguntar" data-id="${esc(x.id)}">Eliminar</button></td></tr>`).join('');
    const aviso = !pide ? '' : `<div class="aviso-chico ag-borrar" role="alert"><span>${est.borrarCot === 'todas' ? '¿Eliminar todas las cotizaciones de la lista?' : '¿Eliminar esta cotización?'} Es solo un registro y no se puede deshacer. Si es de hoy, la agencia recupera ese lugar en su tope diario.</span>
      <div class="actions"><button class="btn danger small" data-a="ag-cot-borrar" data-id="${esc(est.borrarCot)}">Sí, eliminar</button><button class="btn small" data-a="ag-cot-no">No</button></div></div>`;
    cuerpo = `<section class="card"><div class="card-cab"><h3>Cotizaciones de las agencias</h3><span class="hint">Las últimas 200</span></div>
      ${aviso}
      ${A.cotizaciones.length ? `<div class="ag-tabla"><table class="tabla"><thead><tr><th>Fecha</th><th>Agencia</th><th>CUIT</th><th>Vehículo</th><th class="num">Monto</th><th class="num">Cuotas</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>
        <div class="actions"><button class="btn small" data-a="ag-cot-preguntar" data-id="todas">Eliminar todas</button></div>`
        : '<p class="hint m0">Todavía no hay cotizaciones.</p>'}
      <p class="hint m0">Se guarda el CUIT que la agencia consultó. No se guarda el valor del vehículo.</p></section>`;
  } else if (est.tab === 'estadisticas') {
    const E = est.est || {}, filas = E.filas || [];
    const per = [[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [null, 'Desde siempre']];
    const botones = per.map(([d, t]) => `<button class="btn small${E.dias === d ? ' primary' : ''}" data-a="ag-est-dias" data-dias="${d ?? ''}">${esc(t)}</button>`).join(' ');
    const tot = filas.reduce((a, x) => ({ c: a.c + x.cotizaciones, s: a.s + x.solicitudes, ap: a.ap + x.aprobadas, m: a.m + Number(x.monto_aprobado || 0) }), { c: 0, s: 0, ap: 0, m: 0 });
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
    const tabla = filas.map((x) => `<tr><td><b>${esc(x.nombre)}</b>${x.activa ? '' : ' <span class="tag t-mal">Pausada</span>'}<br><span class="hint">${x.ultima_cotizacion ? `Última cotización: ${esc(fechaHora(x.ultima_cotizacion))}` : 'Nunca cotizó'}</span></td>
      <td class="num">${x.cotizaciones}</td><td class="num">${x.solicitudes}</td><td class="num">${x.aprobadas}</td><td class="num">${x.rechazadas}</td><td class="num">${x.abiertas}</td>
      <td class="num">${pct(x.solicitudes, x.cotizaciones)}</td><td class="num">${plata(x.monto_aprobado)}</td></tr>`).join('');
    cuerpo = `<section class="card"><div class="card-cab"><h3>Estadísticas por agencia</h3></div>
      <div class="actions">${botones}</div>
      ${E.error ? `<p class="aviso-chico" role="alert">${esc(E.error)}</p>` : !E.filas ? '<p class="hint m0">Calculando…</p>'
        : !filas.length ? '<p class="hint m0">Todavía no hay agencias.</p>'
        : `<p class="m0"><b>${tot.c}</b> cotizaciones · <b>${tot.s}</b> solicitudes · <b>${tot.ap}</b> aprobadas · ${plata(tot.m)} aprobados</p>
          <details class="ag-est-det" data-est${E.abierto ? ' open' : ''}><summary>Ver gráficos y detalle por agencia</summary>
          <h4 class="gr-tit">Cotizaciones, solicitudes y aprobadas</h4>${graficoBarras(filas, [['cotizaciones', 'Cotizaciones', 'a'], ['solicitudes', 'Solicitudes', 'b'], ['aprobadas', 'Aprobadas', 'c']])}
          ${filas.some((x) => Number(x.monto_aprobado)) ? `<h4 class="gr-tit">Monto aprobado</h4>${graficoBarras(filas.filter((x) => Number(x.monto_aprobado)), [['monto_aprobado', 'Monto aprobado', 'c']], plata)}` : ''}
          <h4 class="gr-tit">Detalle</h4>
          <div class="ag-tabla"><table class="tabla"><thead><tr><th>Agencia</th><th class="num">Cotizaciones</th><th class="num">Solicitudes</th><th class="num">Aprobadas</th><th class="num">Rechazadas</th><th class="num">Abiertas</th><th class="num">Cotiz. → solicitud</th><th class="num">Monto aprobado</th></tr></thead><tbody>${tabla}</tbody></table></div></details>`}
      <p class="hint m0">Las solicitudes se cuentan por la fecha en que la agencia las mandó. «Cotiz. → solicitud» es qué parte de las cotizaciones terminó en una solicitud: sirve para ver quién cotiza y quién avanza.</p></section>`;
  } else {
    const pend = pendientes(A.solicitudes), resto = A.solicitudes.filter((x) => !solicitudAbierta(x));
    cuerpo = `${msg}
      ${pend.length ? pend.map((x) => solicitud(x, A, est, est.notas)).join('')
        : `<div class="empty"><b>No hay solicitudes pendientes</b>Cuando una agencia mande una, aparece acá con el informe del BCRA, el crédito y los documentos.</div>`}
      ${resto.length ? `<div class="card-cab ag-resueltas"><h3>Resueltas</h3><span class="hint">${cuantos(resto.length, 'solicitud', 'solicitudes')}</span></div>${resto.map((x) => solicitud(x, A, est, est.notas)).join('')}` : ''}`;
  }
  return `<div class="ag">${tabs}${cuerpo}</div>`;
}


// ───────────────────────── Chats (botón «M» del cotizador) ─────────────────────────
const ESTADO_CHAT = { bot: ['Con el asistente', ''], espera: ['Esperando tu respuesta', 't-prom'], humano: ['En conversación', 't-plan'], cerrado: ['Cerrada', 't-mal'] };
const DE_CHAT = { agencia: 'Agencia', bot: 'Asistente', mutual: 'Vos' };
const corto = (t, n = 110) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

/** Los avisos al celular: qué pasa en este dispositivo (est.push) y qué se puede hacer. */
function htmlAvisos(C) {
  const st = C.push || 'cargando';
  const cuerpo = {
    cargando: '<p class="hint m0">Revisando si este dispositivo recibe avisos…</p>',
    no: '<p class="m0">Este dispositivo no puede recibir avisos desde acá. <b>En el iPhone</b>: abrí Créditos y Cobros en Safari, tocá Compartir → «Agregar a pantalla de inicio» y entrá desde ese ícono (hace falta iOS 16.4 o más nuevo).</p>',
    denegado: '<p class="m0">Los avisos están bloqueados para esta app. Activalos en <b>Ajustes del iPhone → Notificaciones → Créditos y Cobros</b> y volvé acá.</p>',
    inactivo: '<p class="m0">Activalos para que te suene el celular cuando una agencia quiera hablar con vos, aunque no tengas la app abierta.</p><div class="actions"><button class="btn primary" data-a="ag-push-activar">Activar avisos en este celular</button></div>',
    activo: '<p class="m0">Los avisos están activados en este dispositivo.</p><div class="actions"><button class="btn" data-a="ag-push-probar">Mandarme un aviso de prueba</button><button class="btn" data-a="ag-push-quitar">Desactivar</button></div>',
  }[st] || '';
  return `<section class="card"><div class="card-cab"><h3>Avisos al celular</h3></div>${cuerpo}${C.pushMsg ? `<p class="aviso-chico" role="status">${esc(C.pushMsg)}</p>` : ''}
    <p class="hint m0">Si el aviso no llega, igual ves el pedido acá, con la insignia en la solapa Agencias.</p></section>`;
}

function htmlHilo(C) {
  const c = C.hilo;
  if (!c) return '';
  const [t, clase] = ESTADO_CHAT[c.estado] || [c.estado, ''];
  const abierta = c.estado !== 'cerrado';
  const cuerpoMsg = (m) => `<p>${esc(m.texto)}</p>`;
  const msgs = (C.mensajes || []).map((m) => `<div class="ag-msg ${esc(m.de)}"><span class="ag-msg-de">${esc(DE_CHAT[m.de] || m.de)} · ${esc(fechaHora(m.momento))}</span>${cuerpoMsg(m)}</div>`).join('');
  return `<section class="card ag-hilo"><div class="card-cab"><h3>${esc(c.agencia)} <span class="tag ${clase}">${esc(t)}</span></h3><button class="btn small" data-a="ag-chat-volver">← Todas las conversaciones</button></div>
    <div class="ag-msgs" id="agMsgs" role="log">${msgs || '<p class="hint m0">Todavía no hay mensajes.</p>'}</div>
    ${abierta ? `<label class="f">Tu respuesta<textarea data-k="ag.chat.texto" id="agChatTexto" rows="3" maxlength="1500" placeholder="Escribí la respuesta para la agencia">${esc(C.texto || '')}</textarea></label>
      <div class="actions"><button class="btn primary" data-a="ag-chat-enviar" data-id="${esc(c.id)}"${C.enviando ? ' disabled' : ''}>Enviar respuesta</button><button class="btn" data-a="ag-chat-cerrar" data-id="${esc(c.id)}">Cerrar la conversación</button></div>`
      : '<p class="hint m0">La conversación está cerrada. Si la agencia vuelve a escribir, se abre una nueva.</p>'}
    ${C.borrar
      ? `<div class="aviso-chico ag-borrar" role="alert"><span>¿Eliminar la conversación con ${esc(c.agencia)}? Se borran todos sus mensajes y no se puede deshacer.</span>
        <div class="actions"><button class="btn danger small" data-a="ag-chat-borrar" data-id="${esc(c.id)}">Sí, eliminar</button><button class="btn small" data-a="ag-chat-borrar-no">No</button></div></div>`
      : `<div class="actions"><button class="btn danger small" data-a="ag-chat-borrar-preguntar" data-id="${esc(c.id)}">Eliminar conversación</button></div>`}
    ${C.error ? `<p class="aviso-chico" role="alert">${esc(C.error)}</p>` : ''}</section>`;
}

export function htmlChats(C, ajustes) {
  if (C.hilo) return htmlHilo(C);
  const apagado = ajustes && !ajustes.chat_habilitado;
  const filas = (C.lista || []).map((x) => {
    const [t, clase] = ESTADO_CHAT[x.estado] || [x.estado, ''];
    const u = x.ultimo;
    const punto = x.sin_leer_mutual ? '<span class="sem-punto rojo" role="img" aria-label="Sin leer"></span>' : '';
    return `<button class="ag-chat-fila${x.estado === 'espera' ? ' espera' : ''}" data-a="ag-chat-abrir" data-id="${esc(x.id)}">
      <span class="ag-chat-quien"><b>${esc(x.agencia)}</b> ${punto}<span class="tag ${clase}">${esc(t)}</span></span>
      <span class="ag-chat-ultimo">${u ? `<span class="hint">${esc(DE_CHAT[u.de] || '')}:</span> ${esc(corto(u.texto))}` : ''}</span>
      <span class="hint">${esc(fechaHora(x.actualizado))}</span></button>`;
  }).join('');
  return `${htmlAvisos(C)}
    <section class="card"><div class="card-cab"><h3>Conversaciones con las agencias</h3><button class="btn small" data-a="ag-recargar">Actualizar</button></div>
      ${apagado ? '<p class="aviso-chico m0">El chat está apagado: las agencias no ven el botón «M». Se prende en Parámetros → «Chat con la Mutual».</p>' : ''}
      ${C.error ? `<p class="aviso-chico" role="alert">${esc(C.error)}</p>` : ''}
      ${filas ? `<div class="ag-chats">${filas}</div>` : '<p class="hint m0">Todavía no hay conversaciones. Cuando una agencia te escriba desde el botón «M», aparece acá.</p>'}
    </section>`;
}

/** El aviso de Inicio cuando hay solicitudes esperando. */
export const avisoInicio = (n, chats = 0) => (n ? `<section class="card ag-aviso"><div><b>${n === 1 ? 'Hay 1 solicitud de crédito de una agencia para revisar' : `Hay ${n} solicitudes de crédito de agencias para revisar`}</b>
  <div class="hint">Con el informe del BCRA, el crédito y los documentos.</div></div><button class="btn primary" data-ir="agencias">Ver solicitudes</button></section>` : '')
  + (chats ? `<section class="card ag-aviso"><div><b>${chats === 1 ? 'Hay 1 conversación de una agencia para atender' : `Hay ${chats} conversaciones de agencias para atender`}</b>
  <div class="hint">Una agencia quiere hablar con vos o te escribió.</div></div><button class="btn primary" data-a="ag-ir-chats">Ver chats</button></section>` : '');
