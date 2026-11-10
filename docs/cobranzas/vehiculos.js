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
// Se arma como el programa del estudio, en dos pasos:
//  1) capital en n cuotas a la tasa mensual sobre saldo (cuota fija, sistema francés), más los "otros gastos";
//  2) a eso se le suman los gastos de inscripción de prenda, que SE FINANCIAN (entran al monto con interés).
// Los "otros gastos" (seguro, administrativos, cuota social e IGR) no llevan interés: se reparten en partes
// iguales en las cuotas. El IGR es un % de los intereses del crédito. El sellado y el arancel son un % del
// total del crédito (cuota final × cuotas), que depende de ellos mismos: se resuelve iterando hasta que cierra.
const plano = (n) => String(n).replace('.', ',');
export const TASA_MENSUAL = 7; // % sobre saldo
export const CUOTAS_MAX = 120;
export const PASO_REDONDEO = 1000;
/** Los gastos tal como aparecen por defecto (textos, como se escriben en la pantalla). */
export const GASTOS_DEFECTO = {
  // de inscripción de prenda (se financian)
  sellado: '1,2', arancel: '0,1', arancelMin: '13.000', contratos: '20.000', envio: '20.000', gestoria: '29.000',
  redondeo: '', // vacío = automático (el total de gastos de inscripción al próximo $1.000)
  // otros gastos (sin interés, repartidos en las cuotas)
  seguro: '0,1', // % del capital por cada cuota (el uno por mil: 10.000.000 × 0,1% × 24 = 240.000)
  administrativos: '50', cuotaSocial: '200', igr: '3', // administrativos y cuota social: $ por cada cuota
};

/** `g`: porcentajes en % y el resto en pesos (números). Todo editable desde la pantalla. */
export function simularCredito({ capital, cuotas, g, tasa = TASA_MENSUAL }) {
  const K = Number(capital), n = Math.trunc(Number(cuotas));
  if (!(K > 0) || !(n >= 1) || !(tasa >= 0) || n > CUOTAS_MAX || !g) return null;
  const pos = (x) => Math.max(0, Number(x) || 0);
  const i = tasa / 100, f = i > 0 ? i / (1 - (1 + i) ** -n) : 1 / n; // cuota por cada peso financiado
  const sel = pos(g.sellado) / 100, ar = pos(g.arancel) / 100, min = pos(g.arancelMin), igrPct = pos(g.igr) / 100;
  const seguro = Math.round(K * pos(g.seguro) / 100 * n); // sobre el capital pedido, no sobre el monto con gastos
  const administrativos = pos(g.administrativos) * n, cuotaSocial = pos(g.cuotaSocial) * n; // por cuota
  const otrosFijos = seguro + administrativos + cuotaSocial;
  const contratos = pos(g.contratos), envio = pos(g.envio), gestoria = pos(g.gestoria);
  const calc = (F) => { // un monto financiado F: su cuota, sus intereses, el IGR y lo que se reparte sin interés
    const cuotaF = F * f, intereses = cuotaF * n - F, igr = igrPct * intereses, otros = otrosFijos + igr;
    return { cuotaF, intereses, igr, otros, cuota: cuotaF + otros / n };
  };
  const paso1 = calc(K);
  let T = paso1.cuota * n, r;
  for (let k = 0; k < 100; k++) {
    const sellado = Math.round(T * sel), arancel = Math.max(Math.round(T * ar), min), sub = sellado + arancel + contratos + envio + gestoria;
    const redondeo = g.redondeo == null ? Math.ceil(sub / PASO_REDONDEO) * PASO_REDONDEO - sub : Number(g.redondeo) || 0;
    const gastos = sub + redondeo, financiado = K + gastos, c = calc(financiado);
    r = { sellado, arancel, redondeo, gastos, financiado, c };
    const nuevo = c.cuota * n;
    if (Math.abs(nuevo - T) < 0.01) break;
    T = nuevo;
  }
  const cuotaCapital = Math.round(r.c.cuotaF), cuotaOtros = Math.round(r.c.otros / n), cuota = cuotaCapital + cuotaOtros;
  return { capital: K, cuotas: n, tasa, cuotaPaso1: Math.round(paso1.cuota),
    sellado: r.sellado, arancel: r.arancel, contratos, envio, gestoria, redondeo: r.redondeo, gastos: r.gastos, financiado: r.financiado,
    cuotaCapital, intereses: Math.round(r.c.intereses), seguro, administrativos, cuotaSocial,
    igr: Math.round(r.c.igr), otros: Math.round(r.c.otros), cuotaOtros, cuota, totalCredito: cuota * n };
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
  envio: importe(g.envio), gestoria: importe(g.gestoria), seguro: importe(g.seguro), administrativos: importe(g.administrativos),
  cuotaSocial: importe(g.cuotaSocial), igr: importe(g.igr), redondeo: String(g.redondeo ?? '').trim() === '' ? null : importe(g.redondeo) });

/** Lo que vale hoy el simulador: el capital propuesto (50% del valor) mientras la persona no lo escriba. */
export function estadoSimulador(precios, listPrice, sim) {
  const ref = valorDeReferencia(precios, listPrice, sim.valor);
  if (!ref) return null;
  const capitalTxt = sim.capitalManual ? sim.capital : enCelda(Math.round(ref.pesos / 2));
  const tasa = String(sim.tasa ?? '').trim() === '' ? NaN : importe(sim.tasa);
  const resultado = simularCredito({ capital: importe(capitalTxt), cuotas: sim.cuotas, g: gastosDe(sim.g), tasa });
  return { ref, capitalTxt, resultado };
}

/** Lo que muestra el resultado de la simulación (el que se redibuja al escribir). Compacto: cifras arriba y tres cuadros chicos. */
export function htmlSimulacion(r) {
  if (!r) return '<p class="hint m0">Completá el monto, la cantidad de cuotas (de 1 a ' + CUOTAS_MAX + ') y la tasa.</p>';
  const f = (t, v, fuerte) => `<tr${fuerte ? ' class="fuerte"' : ''}><td>${esc(t)}</td><td class="num mono">${esc(plata(v))}</td></tr>`;
  const cuadro = (titulo, filas, extra = '') => `<div class="sim-cuadro"><h4>${esc(titulo)}</h4><table class="tabla sim-tabla"><tbody>${filas}</tbody></table>${extra}</div>`;
  const final = `<div class="sim-final"><span>Cuota final</span><b class="mono">${esc(plata(r.cuota))}</b></div>`;
  return `<dl class="cifras grandes sim-cifras"><div><dt>Total en ${r.cuotas} cuotas</dt><dd>${esc(plata(r.totalCredito))}</dd></div><div><dt>Monto financiado</dt><dd>${esc(plata(r.financiado))}</dd></div></dl>
    <div class="sim-cuadros">
      ${cuadro('1 · Sin gastos de inscripción', f(`${plata(r.capital)} · ${r.cuotas} cuotas · ${plano(r.tasa)}% mensual`, r.cuotaPaso1, true), final)}
      ${cuadro('2 · Inscripción de prenda (se financia)', `${f('Sellado', r.sellado)}${f('Arancel', r.arancel)}${f('Contratos y administrativos', r.contratos)}${f('Envío de documentación', r.envio)}${f('Gestoría', r.gestoria)}${f('Redondeo', r.redondeo)}${f('Total inscripción', r.gastos, true)}`)}
    </div>
    <details class="sim-otros-res"><summary>Otros gastos (sin interés) <b class="mono">${esc(plata(r.otros))}</b></summary>
      <table class="tabla sim-tabla"><tbody>${f('Seguro de vida', r.seguro)}${f('Administrativos', r.administrativos)}${f('Cuota social', r.cuotaSocial)}${f('IGR (sobre intereses)', r.igr)}${f('Total otros gastos', r.otros, true)}</tbody></table>
    </details>
    <p class="hint m0">Cuota fija sobre saldo. Es una simulación, no una oferta.</p>`;
}

const GASTOS_INSCRIPCION = [['sellado', 'Sellado', '% del total del crédito'], ['arancel', 'Arancel', '% del total del crédito'], ['arancelMin', 'Arancel: mínimo', '$'],
  ['contratos', 'Contratos y gastos administrativos', '$'], ['envio', 'Envío de documentación', '$'], ['gestoria', 'Gestoría', '$'], ['redondeo', 'Redondeo', '$ · vacío = automático']];
const GASTOS_OTROS = [['seguro', 'Seguro de vida', '% del capital por cuota'], ['administrativos', 'Gastos administrativos', '$ por cuota'], ['cuotaSocial', 'Cuota social', '$ por cuota'], ['igr', 'IGR', '% de los intereses']];

/** Los gastos editables y el resultado: lo mismo con vehículo y a mano; `pref` es la ruta (data-k) del simulador. */
function bloqueGastos(S, pref, resultado) {
  const gasto = ([k, t, u]) => `<label class="f">${esc(t)} <small class="hint">${esc(u)}</small><input id="si_g_${k}" data-k="${pref}.g.${k}" inputmode="decimal" autocomplete="off"${u.startsWith('$') ? ' data-importe' : ''} value="${esc(S.g[k])}"></label>`;
  return `<details class="sim-gastos">
      <summary>Gastos (editables)</summary>
      <h4>Inscripción de prenda</h4>
      <div class="sim-form sim-chico">${GASTOS_INSCRIPCION.map(gasto).join('')}</div>
      <details class="sim-otros">
        <summary><span>Otros gastos <small class="hint">sin interés</small></span><b class="mono" id="si_tot_otros">${resultado ? esc(plata(resultado.otros)) : ''}</b></summary>
        <div class="sim-form sim-chico">${GASTOS_OTROS.map(gasto).join('')}</div>
      </details>
    </details>
    <div id="simResultado">${htmlSimulacion(resultado)}</div>`;
}

/** Simulación a mano: el capital, las cuotas y la tasa se escriben; no hace falta ningún vehículo. */
export function estadoSimuladorManual(sim) {
  const tasa = String(sim.tasa ?? '').trim() === '' ? NaN : importe(sim.tasa);
  return { resultado: simularCredito({ capital: importe(sim.capital), cuotas: sim.cuotas, g: gastosDe(sim.g), tasa }) };
}

/** La tarjeta del simulador a mano (pestaña "Simulación", opción "A mano"). */
export function htmlSimuladorManual(S) {
  const est = estadoSimuladorManual(S);
  return `<section class="card cr-simulador cr-sim-vista" id="crSimulador">
    <div class="card-cab"><h3>Simulador de crédito</h3><span class="hint">Prendario · a mano</span></div>
    <div class="sim-form">
      <label class="f">Capital a financiar ($)<input id="si_capital" data-k="cred.simMan.capital" data-importe inputmode="decimal" autocomplete="off" value="${esc(S.capital)}"></label>
      <label class="f">Cuotas<input id="si_cuotas" data-k="cred.simMan.cuotas" inputmode="numeric" autocomplete="off" maxlength="3" value="${esc(S.cuotas)}"></label>
      <label class="f">Tasa mensual (%)<input id="si_tasa" data-k="cred.simMan.tasa" inputmode="decimal" autocomplete="off" value="${esc(S.tasa)}"></label>
    </div>
    ${bloqueGastos(S, 'cred.simMan', est.resultado)}
  </section>`;
}

/** La tarjeta del simulador (pestaña "Simulación"): el valor del vehículo, el capital, las cuotas, los gastos editables y el resultado. */
export function htmlSimulador(precios, listPrice, S, modelo) {
  const filas = preciosPorAnio(precios), cero = enPesos(listPrice?.list_price), est = estadoSimulador(precios, listPrice, S);
  if (!est) return '<section class="card cr-sim-vista"><p class="hint m0">InfoAuto no informa precios para este vehículo, así que no hay valor de referencia.</p></section>';
  const { ref } = est;
  const opciones = [...filas.map((x) => [String(x.anio), `Año ${x.anio} · ${plata(x.pesos)}`]), ...(cero ? [['cero', `0km (lista) · ${plata(cero)}`]] : [])];
  return `<section class="card cr-simulador cr-sim-vista" id="crSimulador">
    <div class="card-cab"><h3>${esc(modelo?.descripcion || 'Simulador de crédito')}</h3><span class="hint">Prendario${modelo ? ` · CODIA ${modelo.codia}` : ''}</span></div>
    <div class="sim-form">
      <label class="f sim-ancho">Valor del vehículo<select id="si_valor" data-k="cred.veh.sim.valor">${opciones.map(([k, t]) => `<option value="${esc(k)}"${k === ref.clave ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="f">Capital a financiar ($)<input id="si_capital" data-k="cred.veh.sim.capital" data-importe inputmode="decimal" autocomplete="off" value="${esc(est.capitalTxt)}"></label>
      <label class="f">Cuotas<input id="si_cuotas" data-k="cred.veh.sim.cuotas" inputmode="numeric" autocomplete="off" maxlength="3" value="${esc(S.cuotas)}"></label>
      <label class="f">Tasa mensual (%)<input id="si_tasa" data-k="cred.veh.sim.tasa" inputmode="decimal" autocomplete="off" value="${esc(S.tasa)}"></label>
    </div>
    <p class="hint m0" id="si_sugerido">Por defecto se financia el 50% del valor (${esc(plata(Math.round(ref.pesos / 2)))}); podés cambiarlo.</p>
    ${bloqueGastos(S, 'cred.veh.sim', est.resultado)}
  </section>`;
}
