// Vista «Agencias» de Créditos y Cobros: lo que la Mutual administra del cotizador para agencias
// (docs/agencias/). Acá solo se arma el HTML y se leen los formularios; los datos los trae datos.js y los
// eventos están en app.js (acciones `ag-…`). Las agencias usan el cotizador con su propia cuenta; la Mutual
// decide desde acá, con su sesión de siempre.
import { esc, plata, cuantos } from './textos.js';
// Los casilleros de documentos y los nombres de las categorías son los del cotizador (un solo lugar).
import { CATEGORIAS, DOCS, docsRequeridos, dniDelCuit } from '../agencias/solicitud.js';

export const TABS_AGENCIAS = [['solicitudes', 'Solicitudes'], ['parametros', 'Parámetros'], ['agencias', 'Agencias'], ['cotizaciones', 'Cotizaciones']];

/** Lo que vio la agencia según el color del BCRA, y la marca para la Mutual. */
const SEM = {
  verde: ['Verde · Continuar', 't-plan'],
  amarillo: ['Amarillo · Sujeto a revisión', 't-prom'],
  sin_datos: ['Sin antecedentes · Sujeto a revisión', 't-prom'],
  rojo: ['Rojo · No apto', 't-mal'],
};
const ESTADO = { pendiente: ['Pendiente', 't-prom'], aprobada: ['Aprobada', 't-plan'], rechazada: ['Rechazada', 't-mal'] };

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
    leyenda: j.leyenda || '', contacto: j.contacto || '',
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
  };
  if (!fila.plazos.length) return { error: 'Escribí al menos un plazo (por ejemplo: 12, 18, 24 o 1-24).' };
  const malos = Object.entries({ ...fila, ...g }).filter(([, x]) => typeof x === 'number' && Number.isNaN(x));
  if (malos.length || fila.pct_financiable == null || fila.tasa_mensual == null) return { error: 'Hay un número mal escrito: revisá los campos (usá coma para los decimales).' };
  if (!(fila.relacion_max > 0 && fila.relacion_max <= 100)) return { error: 'La relación cuota/ingreso tiene que estar entre 1 y 100 %.' };
  return { fila };
}

/** Pendientes primero; dentro de cada grupo, la más nueva arriba. */
const pendientes = (xs) => xs.filter((x) => x.estado === 'pendiente');

function documentos(x, docs) {
  const n = Array.isArray(x.archivos) ? x.archivos.length : 0;
  // Los documentos no son obligatorios para enviar: la Mutual ve cuáles faltan, para pedirlos por otra vía.
  const vacios = docsRequeridos(x.categoria, x.anio).filter((k) => !(x.archivos || []).some((a) => a.slot === k));
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
  const dniCuit = dniDelCuit(x.cuit), pend = x.estado === 'pendiente';
  const pctValor = Number(d.pct_valor) > 0 ? ` <span class="hint">(${esc(Number(d.pct_valor).toLocaleString('es-AR', { maximumFractionDigits: 1 }))} % del valor del vehículo)</span>` : '';
  const trabajo = [x.categoria ? CATEGORIAS[x.categoria] || x.categoria : '', d.actividad || ''].filter(Boolean);
  return `<section class="card ag-sol" id="sol-${esc(x.id)}">
    <div class="card-cab"><div><div class="ag-agencia">${esc(x.agencia)}</div><div class="hint">${esc(fechaHora(x.enviada || x.momento))}</div></div>
      ${etiqueta(ESTADO[x.estado] || [x.estado, ''])}</div>
    <div class="ag-bloque"><span class="ag-rotulo">Cliente</span>
      <b class="ag-nombre">${esc(x.denominacion || cuitLindo(x.cuit))}</b>
      <div>CUIT ${esc(cuitLindo(x.cuit))} · ${etiqueta(SEM[x.semaforo] || [x.semaforo, ''])}</div>
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
      <div class="actions"><button class="btn primary" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="aprobada">Aprobar</button>
        <button class="btn" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="rechazada">Rechazar</button>
        ${est.borrar === x.id ? '' : `<button class="btn" data-a="ag-borrar-preguntar" data-id="${esc(x.id)}">Eliminar</button>`}</div>`
      : `<p class="hint m0">${esc(x.resuelto_por || '')} · ${esc(fechaHora(x.resuelto))}${x.nota ? ` · «${esc(x.nota)}»` : ''}
        <button class="btn small" data-a="ag-resolver" data-id="${esc(x.id)}" data-estado="pendiente">Volver a pendiente</button>
        ${est.borrar === x.id ? '' : `<button class="btn small" data-a="ag-borrar-preguntar" data-id="${esc(x.id)}">Eliminar</button>`}</p>`}
    ${est.borrar === x.id ? `<div class="aviso-chico ag-borrar" role="alert"><span>¿Eliminar la solicitud de ${esc(x.denominacion || cuitLindo(x.cuit))}? Se borran también sus documentos y no se puede deshacer desde la app.</span>
      <div class="actions"><button class="btn danger small" data-a="ag-borrar" data-id="${esc(x.id)}">Sí, eliminar</button><button class="btn small" data-a="ag-borrar-no" data-id="${esc(x.id)}">No</button></div></div>` : ''}
  </section>`;
}

/**
 * Toda la vista. `est`: { tab, msg, docs: Map(id → {cargando}|{lista}|{error}), notas: {id: texto}, p: parámetros en texto,
 * alta: {email, nombre, informada, notas} }.
 */
export function htmlAgencias(A, est) {
  const tabs = `<nav class="tabs" role="tablist" aria-label="Agencias">${TABS_AGENCIAS.map(([k, l]) => {
    const n = k === 'solicitudes' ? pendientes(A.solicitudes).length : k === 'agencias' ? A.agencias.filter((x) => x.activa).length : 0;
    const extra = k === 'solicitudes' && n ? ` (${n})` : k === 'agencias' ? ` (${n}/20)` : '';
    return `<button role="tab" data-a="ag-tab" data-tab="${k}" aria-selected="${est.tab === k}">${esc(l + extra)}</button>`;
  }).join('')}</nav>`;
  const msg = est.msg ? `<p class="aviso-chico" role="status">${esc(est.msg)}</p>` : '';
  let cuerpo;
  if (est.tab === 'parametros') {
    const p = est.p, campo = (k, t, extra = '') => `<label class="f">${esc(t)}<input data-k="ag.p.${k}" value="${esc(p[k] ?? '')}" inputmode="decimal" autocomplete="off"${extra}></label>`;
    cuerpo = `<section class="card">
      <div class="card-cab"><h3>Parámetros del crédito</h3></div>
      <label class="ag-check"><input type="checkbox" data-k="ag.p.habilitado" ${p.habilitado ? 'checked' : ''}> Cotizador habilitado para las agencias</label>
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
      ${msg}
      <div class="actions"><button class="btn primary" data-a="ag-param-guardar">Guardar parámetros</button></div>
    </section>`;
  } else if (est.tab === 'agencias') {
    const al = est.alta;
    const filas = A.agencias.map((x) => `<tr><td><b>${esc(x.nombre)}</b><br><span class="hint">${esc(x.email)}</span>${x.notas ? `<br><span class="hint">${esc(x.notas)}</span>` : ''}</td>
      <td>${x.activa ? '<span class="tag t-plan">Activa</span>' : '<span class="tag t-mal">Pausada</span>'}<br><span class="hint">Informada: ${esc(String(x.informada_infoauto || '—').split('-').reverse().join('/'))}</span></td>
      <td class="num"><button class="btn small" data-a="ag-activa" data-id="${esc(x.id)}" data-valor="${x.activa ? '0' : '1'}">${x.activa ? 'Pausar' : 'Activar'}</button></td></tr>`).join('');
    cuerpo = `<section class="card"><div class="card-cab"><h3>Agencias</h3><span class="hint">${A.agencias.filter((x) => x.activa).length} de 20 activas</span></div>
        ${A.agencias.length ? `<div class="ag-tabla"><table class="tabla"><tbody>${filas}</tbody></table></div>` : '<p class="hint m0">Todavía no hay agencias.</p>'}
        ${msg}</section>
      <section class="card"><div class="card-cab"><h3>Agregar una agencia</h3></div>
        <ol class="campos">
          <li>Avisale por escrito a la guía de precios que vas a sumar esta agencia (lo exige la licencia; tope: 20).</li>
          <li>Creá su cuenta en el panel de Supabase (Authentication → Users → Add user, con «Auto Confirm User») con una contraseña provisoria.</li>
          <li>Completá esto: al entrar, la agencia va a tener que elegir su propia contraseña.</li>
        </ol>
        <div class="grid2">
          <label class="f">Nombre de la agencia<input data-k="ag.alta.nombre" value="${esc(al.nombre || '')}" maxlength="120" autocomplete="off"></label>
          <label class="f">Email de la cuenta<input type="email" data-k="ag.alta.email" value="${esc(al.email || '')}" autocomplete="off"></label>
          <label class="f">Fecha en que se informó a la guía de precios<input type="date" data-k="ag.alta.informada" value="${esc(al.informada || '')}"></label>
          <label class="f">Notas<input data-k="ag.alta.notas" value="${esc(al.notas || '')}" maxlength="500" autocomplete="off"></label>
        </div>
        <div class="actions"><button class="btn primary" data-a="ag-alta">Habilitar agencia</button></div>
      </section>`;
  } else if (est.tab === 'cotizaciones') {
    const filas = A.cotizaciones.map((x) => `<tr><td>${esc(fechaHora(x.momento))}</td><td>${esc(x.agencia)}</td><td>${esc(x.vehiculo)} <span class="hint">${esc(anioTxt(x.anio))}</span></td>
      <td class="num">${plata(x.monto)}</td><td class="num">${x.cuotas} × ${plata(x.cuota)}</td></tr>`).join('');
    cuerpo = `<section class="card"><div class="card-cab"><h3>Cotizaciones de las agencias</h3><span class="hint">Las últimas 200</span></div>
      ${A.cotizaciones.length ? `<div class="ag-tabla"><table class="tabla"><thead><tr><th>Fecha</th><th>Agencia</th><th>Vehículo</th><th class="num">Monto</th><th class="num">Cuotas</th></tr></thead><tbody>${filas}</tbody></table></div>`
        : '<p class="hint m0">Todavía no hay cotizaciones.</p>'}
      <p class="hint m0">No se guarda el valor del vehículo.</p></section>`;
  } else {
    const pend = pendientes(A.solicitudes), resto = A.solicitudes.filter((x) => x.estado !== 'pendiente');
    cuerpo = `${msg}
      ${pend.length ? pend.map((x) => solicitud(x, A, est, est.notas)).join('')
        : `<div class="empty"><b>No hay solicitudes pendientes</b>Cuando una agencia mande una, aparece acá con el informe del BCRA, el crédito y los documentos.</div>`}
      ${resto.length ? `<div class="card-cab ag-resueltas"><h3>Resueltas</h3><span class="hint">${cuantos(resto.length, 'solicitud', 'solicitudes')}</span></div>${resto.map((x) => solicitud(x, A, est, est.notas)).join('')}` : ''}`;
  }
  return `<div class="ag">${tabs}${cuerpo}</div>`;
}

/** El aviso de Inicio cuando hay solicitudes esperando. */
export const avisoInicio = (n) => (n ? `<section class="card ag-aviso"><div><b>${n === 1 ? 'Hay 1 solicitud de crédito de una agencia para revisar' : `Hay ${n} solicitudes de crédito de agencias para revisar`}</b>
  <div class="hint">Con el informe del BCRA, el crédito y los documentos.</div></div><button class="btn primary" data-ir="agencias">Ver solicitudes</button></section>` : '');
