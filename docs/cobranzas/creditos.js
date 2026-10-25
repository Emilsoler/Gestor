// Aprobación de créditos: lo que se muestra de una consulta a la Central de Deudores del BCRA.
// Arma HTML (todo dato pasa por esc) y textos; no toca la pantalla ni la red. La consulta la hace la
// función `bcra` de Supabase, que también decide el semáforo (supabase/functions/bcra/bcra.ts).
import { esc, plata, fmtLargo, cuantos } from './textos.js';
import { nombrePropio } from './calculo.js';

export const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/** CUIT, CUIL o CDI: 11 números y el último, el dígito verificador (módulo 11). El mismo control que la función. */
export function cuitValido(c) {
  if (!/^\d{11}$/.test(c)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(c[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  return dv !== 10 && dv === Number(c[10]);
}
/** 20-12345678-6 */
export const cuitTexto = (c) => (/^\d{11}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : String(c ?? ''));

/** Qué decirle a la persona mientras escribe el CUIT (vacío: nada que decir). */
export function avisoCuit(texto) {
  const d = soloDigitos(texto);
  if (!d) return { ok: false, texto: '' };
  if (d.length < 11) return { ok: false, texto: `Faltan ${11 - d.length} ${11 - d.length === 1 ? 'número' : 'números'}` };
  if (d.length > 11) return { ok: false, texto: 'Sobran números: el CUIT o CUIL tiene 11', mal: true };
  if (!cuitValido(d)) return { ok: false, texto: 'Ese CUIT o CUIL no existe: revisá los números', mal: true };
  return { ok: true, texto: cuitTexto(d) };
}

// Las personas jurídicas (30, 33, 34) están en la cartera comercial, que nombra distinto las situaciones.
const juridica = (cuit) => /^3[034]/.test(cuit || '');
const NOMBRES = {
  consumo: { 1: 'Normal', 2: 'Riesgo bajo', 3: 'Riesgo medio', 4: 'Riesgo alto', 5: 'Irrecuperable', 6: 'Irrecuperable por disp. técnica' },
  comercial: { 1: 'Normal', 2: 'Seguimiento especial', 3: 'Con problemas', 4: 'Alto riesgo de insolvencia', 5: 'Irrecuperable', 6: 'Irrecuperable por disp. técnica' },
};
export const nombreSituacion = (s, cuit) => NOMBRES[juridica(cuit) ? 'comercial' : 'consumo'][s] || `Situación ${s}`;
const claseSituacion = (s) => (s <= 1 ? 's-ok' : s === 2 ? 's-warn' : 's-bad');

export const SEMAFORO = {
  verde: { texto: 'Verde', detalle: 'Todo en situación normal', clase: 'verde' },
  amarillo: { texto: 'Amarillo', detalle: 'Hay algo para mirar', clase: 'amarillo' },
  rojo: { texto: 'Rojo', detalle: 'Deudas con problemas o cheques sin pagar', clase: 'rojo' },
  sin_datos: { texto: 'Sin deudas', detalle: 'No tiene deudas informadas', clase: 'sin' },
};
const semaforo = (s) => SEMAFORO[s] || SEMAFORO.sin_datos;
/** La pastilla con la luz del semáforo: nunca solo el color, siempre con su nombre. */
export const luz = (s, chica = false) => `<span class="luz luz-${semaforo(s).clase}${chica ? ' chica' : ''}"><i aria-hidden="true"></i>${esc(semaforo(s).texto)}</span>`;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** "202608" → "agosto de 2026" */
export const periodoTexto = (p) => (/^\d{6}$/.test(p || '') ? `${MESES[+p.slice(4) - 1]} de ${p.slice(0, 4)}` : '');
const periodoCorto = (p) => (/^\d{6}$/.test(p || '') ? `${MES_CORTO[+p.slice(4) - 1]} ${p.slice(2, 4)}` : String(p ?? ''));

/** Fecha y hora de la consulta, en Córdoba: "21/10/2026 08:41". */
export function momentoTexto(m) {
  const d = new Date(m);
  if (Number.isNaN(d.getTime())) return '';
  const f = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const p = Object.fromEntries(f.map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

const lista = (x) => (Array.isArray(x) ? x : []);
const sit = (e) => Math.max(0, Math.min(6, Math.trunc(Number(e?.situacion) || 0)));
const fecha = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? fmtLargo(String(s).slice(0, 10)) : '');

/** El último período de la consulta actual y sus entidades, de peor a mejor y de mayor a menor deuda. */
function actual(deudas) {
  const ps = lista(deudas?.periodos).filter((p) => /^\d{6}$/.test(String(p?.periodo)));
  if (!ps.length) return { periodo: '', entidades: [] };
  const p = ps.reduce((a, b) => (String(b.periodo) > String(a.periodo) ? b : a));
  return { periodo: String(p.periodo), entidades: [...lista(p.entidades)].sort((a, b) => sit(b) - sit(a) || (+b.monto || 0) - (+a.monto || 0)) };
}

/** Las marcas que el BCRA pone a una deuda, en palabras. */
function marcas(e) {
  const m = [];
  if (+e.diasAtrasoPago > 0) m.push([`${e.diasAtrasoPago} días de atraso`, 't-prom']);
  if (e.procesoJud) m.push(['En proceso judicial', 't-mal']);
  if (e.situacionJuridica) m.push(['Situación jurídica', 't-mal']);
  if (e.irrecDisposicionTecnica) m.push(['Irrecuperable por disposición técnica', 't-mal']);
  if (e.refinanciaciones) m.push(['Refinanciada', 't-prom']);
  if (e.recategorizacionOblig) m.push(['Recategorización obligatoria', 't-prom']);
  if (e.enRevision) m.push(['En revisión', '']);
  return m;
}

/** Los cheques rechazados, con su causal, del más nuevo al más viejo. */
function cheques(ch) {
  return lista(ch?.causales).flatMap((c) => lista(c?.entidades).flatMap((e) => lista(e?.detalle).map((d) => ({ ...d, causal: c?.causal || '' }))))
    .sort((a, b) => String(b.fechaRechazo || '').localeCompare(String(a.fechaRechazo || '')));
}

/**
 * Los últimos 24 meses como una grilla: una fila por entidad, una columna por mes, y en cada celda la
 * situación de ese mes (el número, y el color de su gravedad). Es una tabla de verdad: se lee igual sin colores.
 */
function historia(historicas, cuit) {
  const ps = lista(historicas?.periodos).filter((p) => /^\d{6}$/.test(String(p?.periodo))).sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)));
  if (!ps.length) return '';
  const periodos = ps.map((p) => String(p.periodo));
  const filas = new Map(); // entidad → { periodo → {s, monto} }
  for (const p of ps) {
    for (const e of lista(p.entidades)) {
      const nombre = String(e?.entidad ?? '').trim() || 'Sin nombre';
      if (!filas.has(nombre)) filas.set(nombre, new Map());
      const ant = filas.get(nombre).get(String(p.periodo));
      filas.get(nombre).set(String(p.periodo), { s: Math.max(ant?.s || 0, sit(e)), monto: (ant?.monto || 0) + (+e.monto || 0) });
    }
  }
  const peor = (m) => Math.max(0, ...[...m.values()].map((x) => x.s));
  const ultima = (m) => m.get(periodos[periodos.length - 1])?.monto || 0;
  const orden = [...filas.entries()].sort((a, b) => peor(b[1]) - peor(a[1]) || ultima(b[1]) - ultima(a[1]) || a[0].localeCompare(b[0], 'es'));
  // Rótulos: el primer mes, el último y cada enero que no se les pise (un rótulo ocupa casi dos
  // columnas); el resto queda para lectores de pantalla.
  const conRotulo = new Set([0, periodos.length - 1]);
  periodos.forEach((p, i) => { if (p.endsWith('01') && i >= 2 && i <= periodos.length - 4) conRotulo.add(i); });
  const cab = periodos.map((p, i) => `<th scope="col" title="${esc(periodoTexto(p))}">${conRotulo.has(i) ? `<span class="r">${esc(periodoCorto(p))}</span>` : `<span class="vh">${esc(periodoCorto(p))}</span>`}</th>`).join('');
  const cuerpo = orden.map(([nombre, m]) => `<tr><th scope="row" title="${esc(nombre)}">${esc(nombre)}</th>${periodos.map((p) => {
    const x = m.get(p);
    if (!x) return '<td class="h0"><span class="vh">sin deuda</span></td>';
    const t = `${periodoTexto(p)} · Situación ${x.s} (${nombreSituacion(x.s, cuit).toLowerCase()}) · ${plata(x.monto * 1000)}`;
    return `<td class="h${x.s}" title="${esc(t)}">${x.s}</td>`;
  }).join('')}</tr>`).join('');
  return `<section class="sec">
    <div class="sec-cab"><h4>Últimos 24 meses</h4><span class="hint">${esc(periodoTexto(periodos[0]))} a ${esc(periodoTexto(periodos[periodos.length - 1]))}</span></div>
    <div class="scrollx historia-caja"><table class="historia"><caption class="vh">Situación en cada entidad, mes por mes</caption><thead><tr><th scope="col"><span class="vh">Entidad</span></th>${cab}</tr></thead><tbody>${cuerpo}</tbody></table></div>
    <p class="hint m0 leyenda">${[1, 2, 3, 4, 5].map((s) => `<span><b class="h${s}">${s}</b> ${esc(nombreSituacion(s, cuit))}</span>`).join('')}<span><b class="h0"></b> Sin deuda ese mes</span></p>
  </section>`;
}

/** Los deudores de Cobranzas que coinciden con el CUIT (o con el DNI que lleva adentro). */
export function deudoresDelCuit(deudores, cuit) {
  if (!/^\d{11}$/.test(cuit || '')) return [];
  const dni = cuit.slice(2, 10).replace(/^0+/, '');
  return deudores.filter((d) => {
    const x = soloDigitos(d.dni);
    return x.length === 11 ? x === cuit : x.length >= 6 && x.length <= 8 && x.replace(/^0+/, '') === dni;
  });
}

/**
 * La ficha de una consulta. `c` es la fila guardada; `detalle`, su `resultado` (o null mientras se lee);
 * `deudores`, los de Cobranzas con ese CUIT; `confirmar`, si se está por eliminar.
 */
export function fichaConsulta(c, detalle, { deudores = [], confirmar = false, error = '' } = {}) {
  const sem = semaforo(c.semaforo);
  const nombre = c.denominacion ? c.denominacion : 'Sin nombre informado';
  const cab = `<div class="cr-cab">
      <div class="cr-quien"><h3>${esc(nombre)}</h3><span class="mono">${esc(cuitTexto(c.cuit))}</span></div>
      <div class="cr-luz luz-${sem.clase}"><i aria-hidden="true"></i><div><b>${esc(sem.texto)}</b><span>${esc(sem.detalle)}</span></div></div>
    </div>
    <p class="hint m0">Consultado el ${esc(momentoTexto(c.momento))}${c.consultado_por ? ` por ${esc(c.consultado_por)}` : ''}${c.periodo ? ` · información del BCRA a ${esc(periodoTexto(c.periodo))}` : ''}</p>`;
  const motivos = lista(c.motivos).length ? `<ul class="motivos">${lista(c.motivos).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '';
  const cifras = `<dl class="cifras">
      <div><dt>Deuda informada</dt><dd>${esc(plata(+c.deuda_total || 0))}</dd></div>
      <div><dt>Entidades</dt><dd>${esc(String(c.entidades || 0))}</dd></div>
      <div><dt>Peor situación hoy</dt><dd>${c.peor_situacion ? esc(`${c.peor_situacion} · ${nombreSituacion(c.peor_situacion, c.cuit)}`) : '—'}</dd></div>
      <div><dt>Cheques rechazados</dt><dd>${esc(String(c.cheques || 0))}${c.cheques_impagos ? ` <small class="malo">(${esc(cuantos(c.cheques_impagos, 'sin pagar', 'sin pagar'))})</small>` : ''}</dd></div>
    </dl>`;
  const aviso = !c.denominacion && c.semaforo === 'sin_datos'
    ? '<p class="aviso-chico">Sin deudas el BCRA no devuelve el nombre: confirmá que el CUIT sea el de la persona antes de decidir.</p>' : '';
  const enCobranzas = deudores.length ? `<div class="nota choque"><p><b>Ya figura en Cobranzas.</b></p>${deudores.map((d) => `<div class="cr-deudor"><span>${esc(nombrePropio(d.nombre))} · ${esc(d.estado)}</span><button class="btn small" data-abrir="${esc(d.id)}">Abrir ficha</button></div>`).join('')}</div>` : '';

  let cuerpo;
  if (error) cuerpo = `<p class="aviso-chico">${esc(error)}</p>`;
  else if (!detalle) cuerpo = '<p class="hint m0">Cargando el detalle…</p>';
  else {
    const { entidades } = actual(detalle.deudas);
    const tabla = entidades.length ? `<section class="sec"><div class="sec-cab"><h4>Deudas informadas</h4><span class="hint">${esc(periodoTexto(c.periodo))}</span></div>
      <div class="scrollx"><table class="tabla cr-entidades"><thead><tr><th>Entidad</th><th>Situación</th><th class="num">Monto</th></tr></thead><tbody>
      ${entidades.map((e) => { const s = sit(e), ms = marcas(e); return `<tr><td><b>${esc(String(e.entidad ?? '').trim() || 'Sin nombre')}</b>${ms.length ? `<span class="tags">${ms.map(([t, k]) => `<span class="tag ${k}">${esc(t)}</span>`).join('')}</span>` : ''}</td>
        <td><span class="pill ${claseSituacion(s)}">${esc(`${s} · ${nombreSituacion(s, c.cuit)}`)}</span></td><td class="num mono">${esc(plata((+e.monto || 0) * 1000))}</td></tr>`; }).join('')}
      </tbody><tfoot><tr><td colspan="2">Total</td><td class="num mono">${esc(plata(+c.deuda_total || 0))}</td></tr></tfoot></table></div>
      <p class="hint m0">El BCRA informa los montos en miles de pesos; acá están pasados a pesos.</p></section>` : '';
    const chs = cheques(detalle.cheques);
    const tablaCheques = chs.length ? `<section class="sec"><div class="sec-cab"><h4>Cheques rechazados</h4><span class="hint">${esc(cuantos(chs.length, 'cheque', 'cheques'))}</span></div>
      <div class="scrollx"><table class="tabla cr-cheques"><thead><tr><th>Rechazado</th><th>N° de cheque</th><th>Causal</th><th class="num">Monto</th><th>Pago</th></tr></thead><tbody>
      ${chs.map((x) => `<tr${x.fechaPago ? ' class="apagada"' : ''}><td class="mono ch-f">${esc(fecha(x.fechaRechazo) || '—')}</td><td class="mono ch-n">${esc(String(x.nroCheque ?? ''))}</td><td class="ch-c">${esc(x.causal)}${x.denomJuridica ? `<small class="hint"> · ${esc(x.denomJuridica)}</small>` : ''}</td>
        <td class="num mono ch-m">${esc(plata(+x.monto || 0))}</td><td class="ch-p">${x.fechaPago ? `Pagado el ${esc(fecha(x.fechaPago))}` : '<span class="malo">Sin pagar</span>'}${x.estadoMulta ? `<small class="hint"> · multa ${esc(String(x.estadoMulta).toLowerCase())}</small>` : x.fechaPagoMulta ? `<small class="hint"> · multa pagada</small>` : ''}</td></tr>`).join('')}
      </tbody></table></div></section>` : '';
    const faltan = Object.keys(detalle.errores || {}).length
      ? `<p class="aviso-chico">No se pudieron traer ${detalle.errores.historicas ? 'los últimos 24 meses' : 'todos los datos'}: ${esc(Object.values(detalle.errores)[0])}</p>` : '';
    cuerpo = `${tabla}${historia(detalle.historicas, c.cuit)}${tablaCheques}${faltan}`;
  }

  const acciones = confirmar
    ? `<div class="confirm"><span>¿Eliminar esta consulta? Se puede recuperar después desde el historial de cambios.</span><button class="btn small danger" data-a="cr-borrar" data-id="${esc(c.id)}">Sí, eliminar</button><button class="btn small" data-a="cr-no">Cancelar</button></div>`
    : `<div class="actions"><button class="btn small primary" data-a="cr-repetir" data-cuit="${esc(c.cuit)}">Volver a consultar</button><button class="btn small" data-a="cr-copiar">Copiar resumen</button><span class="sep"></span><button class="btn small danger" data-a="cr-confirmar">Eliminar consulta</button></div>`;

  return `${cab}${aviso}${motivos}${cifras}${enCobranzas}${cuerpo}
    <details class="sec ayuda"><summary>¿Qué significa cada situación?</summary>
      <p class="hint m0">En los préstamos a personas (cartera de consumo), según los días de atraso:</p><ul class="campos">
      <li><b>1 · Normal:</b> paga en término o con atrasos de hasta 31 días.</li>
      <li><b>2 · Riesgo bajo:</b> atrasos de 31 a 90 días.</li>
      <li><b>3 · Riesgo medio:</b> atrasos de 90 a 180 días.</li>
      <li><b>4 · Riesgo alto:</b> atrasos de 180 días a un año.</li>
      <li><b>5 · Irrecuperable:</b> atrasos de más de un año.</li>
    </ul><p class="hint m0">En las empresas (cartera comercial) los nombres cambian y cuenta también la capacidad de pago.</p>
    <p class="hint m0">Semáforo: rojo con situación 3 o peor, o con algún cheque rechazado sin pagar; amarillo con situación 2, o con cheques rechazados ya pagados; verde si todo está en situación 1. Fuente: BCRA, Central de Deudores del Sistema Financiero.</p></details>
    ${acciones}`;
}

/** El resumen para copiar y pegar (en un mail, en un WhatsApp al consejo, en un acta). */
export function textoConsulta(c) {
  const sem = semaforo(c.semaforo);
  return [
    `Consulta BCRA — Central de Deudores`,
    `${c.denominacion || 'Sin nombre informado'} · CUIT/CUIL ${cuitTexto(c.cuit)}`,
    `Semáforo: ${sem.texto} (${sem.detalle.toLowerCase()})`,
    ...lista(c.motivos).map((m) => `• ${m}`),
    `Deuda informada: ${plata(+c.deuda_total || 0).replace('\u00a0', ' ')}${c.periodo ? ` (a ${periodoTexto(c.periodo)})` : ''}`,
    `Consultado el ${momentoTexto(c.momento)}${c.consultado_por ? ` por ${c.consultado_por}` : ''}`,
  ].join('\n');
}

/** Una consulta en el historial. */
export const filaConsulta = (c, elegida) => `<button class="cr-fila${elegida ? ' elegida' : ''}" data-consulta="${esc(c.id)}" aria-pressed="${elegida}">
    ${luz(c.semaforo, true)}<span class="cr-fila-t"><b>${esc(c.denominacion || 'Sin nombre informado')}</b><span class="mono">${esc(cuitTexto(c.cuit))}</span></span>
    <span class="cr-fila-f"><span class="mono">${esc(momentoTexto(c.momento).slice(0, 10))}</span>${c.peor_situacion ? `<small>situación ${esc(String(c.peor_situacion))}</small>` : ''}</span></button>`;
