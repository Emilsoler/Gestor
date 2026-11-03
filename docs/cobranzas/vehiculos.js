// Cotización de vehículos: lo que se muestra de una consulta a InfoAuto (precio 0km y usados por año).
// Arma HTML (todo dato pasa por esc) y textos; no toca la pantalla ni la red. Las consultas las hace la
// función `infoauto` de Supabase (supabase/functions/infoauto), que guarda el token y las credenciales.
// InfoAuto informa los precios en miles de pesos.
import { esc, plata } from './textos.js';
import { importe, enCelda } from '../liquidacion.js';

const lista = (x) => (Array.isArray(x) ? x : []);

/** Las descripciones de InfoAuto vienen con espacios de sobra: "ONIX 1.4 JOY BLACK            L/19". */
export const descripcion = (m) => String(m?.description ?? '').replace(/\s+/g, ' ').trim();

/** Miles de pesos → pesos. */
export const enPesos = (miles) => Math.round((Number(miles) || 0) * 1000);

/** Un modelo de la lista, con sus datos mínimos (lo demás de InfoAuto —ficha, fotos— no se usa acá). */
export function modeloSimple(m) {
  const codia = Math.trunc(Number(m?.codia));
  if (!Number.isFinite(codia) || codia <= 0) return null;
  return {
    codia, descripcion: descripcion(m), marca: String(m?.brand?.name ?? '').trim(), grupo: String(m?.group?.name ?? '').trim(),
    desde: Number(m?.prices_from) || null, hasta: Number(m?.prices_to) || null, tiene0km: !!m?.list_price,
  };
}

/** Los años con precio usado, del más nuevo al más viejo. */
export function preciosPorAnio(precios) {
  return lista(precios).map((p) => ({ anio: Math.trunc(Number(p?.year)), pesos: enPesos(p?.price) }))
    .filter((p) => p.anio > 1900 && p.pesos > 0).sort((a, b) => b.anio - a.anio);
}

export const rangoAnios = (m) => (m.desde && m.hasta ? (m.desde === m.hasta ? String(m.desde) : `${m.desde} a ${m.hasta}`) : '');

/** La fila de un modelo en la lista de resultados. */
export function filaModelo(m, elegido) {
  return `<button type="button" class="cr-fila${elegido ? ' elegida' : ''}" data-vehiculo="${m.codia}" aria-pressed="${elegido}">
    <span class="mono">${m.codia}</span>
    <span class="cr-fila-t"><b>${esc(m.descripcion || 'Sin descripción')}</b><span class="sub">${esc([m.marca, m.grupo].filter(Boolean).join(' · '))}</span></span>
    <span class="cr-fila-f mono">${esc(rangoAnios(m))}</span></button>`;
}

/** La ficha de un vehículo: precio 0km y usados por año. `anio` resalta el año elegido. */
export function fichaVehiculo(m, precios, listPrice, anio) {
  const filas = preciosPorAnio(precios);
  const cero = enPesos(listPrice?.list_price);
  const tabla = filas.length
    ? `<div class="scrollx"><table class="tabla"><thead><tr><th>Año del modelo</th><th class="num">Precio de mercado</th></tr></thead><tbody>${filas.map((p) => `<tr${String(p.anio) === String(anio) ? ' class="fuerte"' : ''}><td class="mono">${p.anio}</td><td class="num mono">${esc(plata(p.pesos))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="hint m0">InfoAuto no informa precios usados para este modelo.</p>';
  return `<section class="card cr-resultado" id="crResultado">
    <div class="card-cab"><h3>${esc(m.descripcion || 'Vehículo')}</h3><span class="hint">CODIA ${m.codia}</span></div>
    <p class="hint">${esc([m.marca, m.grupo].filter(Boolean).join(' · '))}</p>
    <p class="m0">${cero ? `Precio 0km (lista): <b class="mono">${esc(plata(cero))}</b>` : 'Sin precio 0km informado.'}</p>
    ${tabla}
    <p class="hint m0">Precios de referencia de InfoAuto, en pesos. Los usados son los de mercado del año en curso.</p>
  </section>`;
}

// ───────────────────────── Simulador de crédito prendario ─────────────────────────
// Sistema francés (cuota fija) con interés sobre saldo. Los gastos de inscripción de prenda se financian
// dentro del crédito, y como el sellado y el arancel son un % del total del crédito (cuota × cantidad de
// cuotas) y ese total depende a su vez de los gastos, se resuelve la ecuación en vez de iterar:
// total = n·f·(capital + gastos), con gastos = sellado·total + max(arancel·total, mínimo) + fijos.
export const TASA_MENSUAL = 6; // % sobre saldo
export const CUOTAS_MAX = 120;
/** Gastos de inscripción de prenda tal como aparecen por defecto (textos, como se escriben en la pantalla). */
export const GASTOS_DEFECTO = { sellado: '1,2', arancel: '0,01', arancelMin: '13.000', contratos: '20.000', envio: '20.000', gestoria: '29.000', redondeo: '' }; // redondeo vacío = automático (el total de gastos al próximo $1.000)

/** `g`: sellado y arancel en %, el resto en pesos (números). Todo editable desde la pantalla. */
export function simularCredito(p) {
  const r = simularConRedondeo(p, p.g?.redondeo == null ? 0 : p.g.redondeo);
  if (!r || p.g.redondeo != null) return r;
  // Redondeo automático: el total de gastos sube al próximo múltiplo de $1.000. Como el sellado y el arancel
  // dependen del total del crédito, y este del redondeo, se busca el redondeo mínimo que llega a ese total y
  // después se ajusta el renglón para que cierre exacto (la diferencia es de centavos de la cuota entera).
  const meta = Math.ceil(r.gastos / PASO_REDONDEO) * PASO_REDONDEO;
  if (meta === r.gastos) return r;
  let lo = 0, hi = 2 * PASO_REDONDEO;
  while (lo < hi) { const m = (lo + hi) >> 1; if (simularConRedondeo(p, m).gastos >= meta) hi = m; else lo = m + 1; }
  const x = simularConRedondeo(p, lo), financiado = x.capital + meta;
  return { ...x, redondeo: x.redondeo + meta - x.gastos, gastos: meta, financiado, intereses: x.totalCredito - financiado };
}
const PASO_REDONDEO = 1000;

function simularConRedondeo({ capital, cuotas, g, tasa = TASA_MENSUAL }, redondeo) {
  const K = Number(capital), n = Math.trunc(Number(cuotas));
  if (!(K > 0) || !(n >= 1) || !(tasa >= 0) || n > CUOTAS_MAX || !g) return null;
  const i = tasa / 100, sel = Math.max(0, g.sellado) / 100, ar = Math.max(0, g.arancel) / 100, min = Math.max(0, g.arancelMin);
  const nf = i > 0 ? n * i / (1 - (1 + i) ** -n) : 1; // total del crédito por cada peso financiado
  const fijos = Math.max(0, g.contratos) + Math.max(0, g.envio) + Math.max(0, g.gestoria) + redondeo;
  let den = 1 - nf * sel, total = den > 0 ? nf * (K + fijos + min) / den : NaN; // con el arancel mínimo
  if (ar * total > min) { den = 1 - nf * (sel + ar); total = den > 0 ? nf * (K + fijos) / den : NaN; } // arancel proporcional
  if (!Number.isFinite(total) || total <= 0) return null;
  const cuota = Math.round(total / n), totalCredito = cuota * n;
  const sellado = Math.round(totalCredito * sel), arancel = Math.max(Math.round(totalCredito * ar), min);
  const gastos = sellado + arancel + fijos, financiado = K + gastos;
  return { capital: K, cuotas: n, tasa, cuota, totalCredito, sellado, arancel, contratos: Math.max(0, g.contratos), envio: Math.max(0, g.envio),
    gestoria: Math.max(0, g.gestoria), redondeo, gastos, financiado, intereses: totalCredito - financiado };
}

/** El valor de referencia para el crédito: el año elegido (o el más nuevo con precio) o el 0km. */
export function valorDeReferencia(precios, listPrice, sel) {
  const filas = preciosPorAnio(precios), cero = enPesos(listPrice?.list_price);
  if (sel === 'cero' && cero) return { clave: 'cero', etiqueta: '0km (lista)', pesos: cero };
  const f = filas.find((x) => String(x.anio) === String(sel)) || filas[0];
  if (f) return { clave: String(f.anio), etiqueta: `Año ${f.anio}`, pesos: f.pesos };
  return cero ? { clave: 'cero', etiqueta: '0km (lista)', pesos: cero } : null;
}

/** Los gastos escritos en la pantalla → números. */
export const gastosDe = (g) => ({ sellado: importe(g.sellado), arancel: importe(g.arancel), arancelMin: importe(g.arancelMin), contratos: importe(g.contratos),
  envio: importe(g.envio), gestoria: importe(g.gestoria), redondeo: String(g.redondeo ?? '').trim() === '' ? null : importe(g.redondeo) });

/** Lo que vale hoy el simulador: el capital propuesto (50% del valor) mientras la persona no lo escriba. */
export function estadoSimulador(precios, listPrice, sim) {
  const ref = valorDeReferencia(precios, listPrice, sim.valor);
  if (!ref) return null;
  const capitalTxt = sim.capitalManual ? sim.capital : enCelda(Math.round(ref.pesos / 2));
  const tasa = String(sim.tasa ?? '').trim() === '' ? NaN : importe(sim.tasa);
  const resultado = simularCredito({ capital: importe(capitalTxt), cuotas: sim.cuotas, g: gastosDe(sim.g), tasa });
  return { ref, capitalTxt, resultado };
}

const plano = (n) => String(n).replace('.', ',');

/** Lo que muestra el resultado de la simulación (el que se redibuja al escribir). */
export function htmlSimulacion(r) {
  if (!r) return '<p class="hint m0">Completá el monto, la cantidad de cuotas (de 1 a ' + CUOTAS_MAX + ') y la tasa.</p>';
  const f = (t, v, fuerte) => `<tr${fuerte ? ' class="fuerte"' : ''}><td>${esc(t)}</td><td class="num mono">${esc(plata(v))}</td></tr>`;
  return `<dl class="cifras grandes"><div><dt>Cuota mensual</dt><dd>${esc(plata(r.cuota))}</dd></div><div><dt>${r.cuotas} cuotas</dt><dd>${esc(plata(r.totalCredito))}</dd></div></dl>
    <div class="scrollx"><table class="tabla"><tbody>
      ${f('Capital a financiar', r.capital)}
      ${f('Sellado', r.sellado)}
      ${f('Arancel', r.arancel)}
      ${f('Contratos y gastos administrativos', r.contratos)}
      ${f('Envío de documentación', r.envio)}
      ${f('Gestoría', r.gestoria)}
      ${f('Redondeo', r.redondeo)}
      ${f('Total financiado (capital + gastos de inscripción)', r.financiado, true)}
      ${f(`Intereses (${plano(r.tasa)}% mensual sobre saldo)`, r.intereses)}
      ${f('Total del crédito (cuota × cuotas)', r.totalCredito, true)}
    </tbody></table></div>
    <p class="hint m0">Cuota fija, interés ${plano(r.tasa)}% mensual sobre saldo. Los gastos de inscripción están incluidos en el crédito y se pagan dentro de las cuotas. Es una simulación, no una oferta.</p>`;
}

const GASTOS_CAMPOS = [['sellado', 'Sellado', '% del total del crédito'], ['arancel', 'Arancel', '% del total del crédito'], ['arancelMin', 'Arancel: mínimo', '$'],
  ['contratos', 'Contratos y gastos administrativos', '$'], ['envio', 'Envío de documentación', '$'], ['gestoria', 'Gestoría', '$'], ['redondeo', 'Redondeo', '$ · vacío = automático']];

/** La tarjeta del simulador: el valor del vehículo, el capital, las cuotas, los gastos editables y el resultado. */
export function htmlSimulador(precios, listPrice, S) {
  const filas = preciosPorAnio(precios), cero = enPesos(listPrice?.list_price), est = estadoSimulador(precios, listPrice, S);
  if (!est) return '';
  const { ref } = est;
  const opciones = [...filas.map((x) => [String(x.anio), `Año ${x.anio} · ${plata(x.pesos)}`]), ...(cero ? [['cero', `0km (lista) · ${plata(cero)}`]] : [])];
  const gasto = ([k, t, u]) => `<label class="f">${esc(t)} <small class="hint">${esc(u)}</small><input id="si_g_${k}" data-k="cred.veh.sim.g.${k}" inputmode="decimal" autocomplete="off"${u.startsWith('$') ? ' data-importe' : ''} value="${esc(S.g[k])}"></label>`;
  return `<section class="card cr-simulador" id="crSimulador">
    <div class="card-cab"><h3>Simulador de crédito</h3><span class="hint">Prendario</span></div>
    <div class="cr-form">
      <label class="f">Valor del vehículo<select id="si_valor" data-k="cred.veh.sim.valor">${opciones.map(([k, t]) => `<option value="${esc(k)}"${k === ref.clave ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="f">Capital a financiar ($)<input id="si_capital" data-k="cred.veh.sim.capital" data-importe inputmode="decimal" autocomplete="off" value="${esc(est.capitalTxt)}"></label>
      <label class="f">Cantidad de cuotas<input id="si_cuotas" data-k="cred.veh.sim.cuotas" inputmode="numeric" autocomplete="off" maxlength="3" value="${esc(S.cuotas)}"></label>
      <label class="f">Tasa de interés mensual (% sobre saldo)<input id="si_tasa" data-k="cred.veh.sim.tasa" inputmode="decimal" autocomplete="off" value="${esc(S.tasa)}"></label>
    </div>
    <p class="hint m0" id="si_sugerido">Por defecto se financia el 50% del valor (${esc(plata(Math.round(ref.pesos / 2)))}); podés cambiarlo.</p>
    <h4>Gastos de inscripción de prenda</h4>
    <div class="cr-form cr-gastos">${GASTOS_CAMPOS.map(gasto).join('')}</div>
    <div id="simResultado">${htmlSimulacion(est.resultado)}</div>
  </section>`;
}
