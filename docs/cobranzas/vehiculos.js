// Cotización de vehículos: lo que se muestra de una consulta a InfoAuto (precio 0km y usados por año).
// Arma HTML (todo dato pasa por esc) y textos; no toca la pantalla ni la red. Las consultas las hace la
// función `infoauto` de Supabase (supabase/functions/infoauto), que guarda el token y las credenciales.
// InfoAuto informa los precios en miles de pesos.
import { esc, plata } from './textos.js';

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
