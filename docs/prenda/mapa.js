// Mapa esquemático de la zona, dibujado con SVG y sin ninguna librería ni mapa de terceros: así
// ningún servidor externo se entera de dónde está un vehículo. Muestra rutas, río, manchas urbanas,
// el límite de provincia y las localidades; encima, los vehículos (o su zona aproximada).
//
// La geometría va en un <svg> con viewBox en kilómetros (se mueve y se agranda cambiando el
// viewBox). Las etiquetas, los círculos de zona y los marcadores van en una capa de HTML encima,
// que se reubica en cada movimiento para que el texto no se deforme.
import { MAPA } from './mapa-datos.js';
import { px, py, lonDe, latDe } from './geo.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONO_AUTO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.5 13.5l1.6-4.3a2.5 2.5 0 0 1 2.3-1.6h9.2a2.5 2.5 0 0 1 2.3 1.6l1.6 4.3c.9.3 1.5 1.1 1.5 2V18a1 1 0 0 1-1 1h-1.2a2.6 2.6 0 0 1-5.2 0H9.4a2.6 2.6 0 0 1-5.2 0H3a1 1 0 0 1-1-1v-2.5c0-.9.6-1.7 1.5-2zm2.6-.3h11.8l-1.2-3.3a1 1 0 0 0-.9-.7H8.2a1 1 0 0 0-.9.7z"/></svg>';

const polyA = (linea) => linea.map((p) => `${px(p[1]).toFixed(2)},${py(p[0]).toFixed(2)}`).join(' ');
const pathPoly = (anillo) => 'M' + anillo.map((p) => `${px(p[1]).toFixed(2)} ${py(p[0]).toFixed(2)}`).join(' L') + 'Z';

export function crearMapa(contenedor, { onSelect } = {}) {
  contenedor.classList.add('mapa');
  const svg = el('svg', { class: 'mapa-svg', preserveAspectRatio: 'none' });
  const gBase = el('g', {});
  svg.appendChild(gBase);
  const capa = document.createElement('div'); capa.className = 'mapa-capa';
  const controles = document.createElement('div'); controles.className = 'mapa-ctrl';
  controles.innerHTML = '<button type="button" data-z="1" aria-label="Acercar">+</button><button type="button" data-z="-1" aria-label="Alejar">−</button>';
  contenedor.append(svg, capa, controles);

  // ── Geometría de base (una vez) ──
  for (const p of MAPA.urban) gBase.appendChild(el('path', { class: 'm-urban', d: pathPoly(p) }));
  for (const l of MAPA.rivers) gBase.appendChild(el('polyline', { class: 'm-river', points: polyA(l) }));
  for (const l of MAPA.border) gBase.appendChild(el('polyline', { class: 'm-border', points: polyA(l) }));
  for (const r of MAPA.roads) {
    gBase.appendChild(el('polyline', { class: 'm-casing' + (r.major ? ' major' : ''), points: polyA(r.c) }));
    gBase.appendChild(el('polyline', { class: 'm-road' + (r.major ? ' major' : ''), points: polyA(r.c) }));
  }

  // Bordes del mundo, para encuadrar y limitar el paneo.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const ext = (wx, wy) => { minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy); };
  for (const t of MAPA.towns) ext(px(t.c[1]), py(t.c[0]));
  for (const r of MAPA.roads) for (const p of r.c) ext(px(p[1]), py(p[0]));
  const MARGEN = 12;
  const MUNDO = { x: minX - MARGEN, y: minY - MARGEN, w: maxX - minX + 2 * MARGEN, h: maxY - minY + 2 * MARGEN };
  const W_MIN = 3, W_MAX = Math.max(MUNDO.w, MUNDO.h) * 1.4;

  // ── Etiquetas fijas (localidades, escudos de ruta, provincias) ──
  const fijas = [];
  const etiqueta = (clase, html, lat, lon) => { const d = document.createElement('div'); d.className = clase; d.innerHTML = html; capa.appendChild(d); fijas.push({ el: d, wx: px(lon), wy: py(lat) }); return d; };
  for (const t of MAPA.towns) etiqueta('m-town' + (t.g ? ' mayor' : ' menor'), '<i></i>' + esc(t.n), t.c[0], t.c[1]);
  for (const p of MAPA.provincias) etiqueta('m-prov', esc(p.n), p.c[0], p.c[1]);
  for (const r of MAPA.roads) {
    if (!r.ref) continue;
    const c = r.c, mid = c[Math.floor(c.length / 2)];
    etiqueta('m-shield', esc(r.ref), mid[0], mid[1]);
  }

  // ── Estado de cámara ──
  let view = { x: MUNDO.x, y: MUNDO.y, w: MUNDO.w, h: MUNDO.h };
  let rect = { width: 1, height: 1 };
  let base = null, items = [], marcadores = {};

  function medir() { const r = contenedor.getBoundingClientRect(); rect = { width: Math.max(1, r.width), height: Math.max(1, r.height) }; }
  function aplicar() {
    view.h = view.w * (rect.height / rect.width);
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    reubicar();
  }
  const aPx = (wx, wy) => [((wx - view.x) / view.w) * rect.width, ((wy - view.y) / view.h) * rect.height];
  const aMundo = (sx, sy) => [view.x + (sx / rect.width) * view.w, view.y + (sy / rect.height) * view.h];
  const kmAPx = (km) => (km / view.w) * rect.width;

  function poner(d, wx, wy) { const [sx, sy] = aPx(wx, wy); d.style.left = sx + 'px'; d.style.top = sy + 'px'; }
  function reubicar() {
    const lejos = view.w > 55;
    contenedor.classList.toggle('lejos', lejos);
    for (const f of fijas) poner(f.el, f.wx, f.wy);
    if (base) { const b = marcadores.__zona; if (b) { poner(b, px(base.base_lon), py(base.base_lat)); const dpx = kmAPx(base.zona_km) * 2; b.style.width = b.style.height = dpx + 'px'; } }
    for (const it of items) {
      const m = marcadores[it.id]; if (!m) continue;
      poner(m.pin, m.wx, m.wy);
      if (m.zona) { const dpx = kmAPx(it.zkm) * 2; m.zona.style.width = m.zona.style.height = dpx + 'px'; poner(m.zona, m.wx, m.wy); }
    }
  }

  function limitar() {
    view.w = Math.max(W_MIN, Math.min(W_MAX, view.w));
    view.h = view.w * (rect.height / rect.width);
    const cx = Math.max(MUNDO.x, Math.min(MUNDO.x + MUNDO.w, view.x + view.w / 2));
    const cy = Math.max(MUNDO.y, Math.min(MUNDO.y + MUNDO.h, view.y + view.h / 2));
    view.x = cx - view.w / 2; view.y = cy - view.h / 2;
  }
  function zoomEn(sx, sy, factor) {
    const [wx, wy] = aMundo(sx, sy);
    view.w *= factor; limitar();
    view.h = view.w * (rect.height / rect.width);
    // mantener el punto bajo el cursor
    const [nx, ny] = aMundo(sx, sy);
    view.x += wx - nx; view.y += wy - ny; limitar(); aplicar();
  }

  // ── Interacción ──
  controles.addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) zoomEn(rect.width / 2, rect.height / 2, b.dataset.z === '1' ? 0.7 : 1 / 0.7); });
  svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = contenedor.getBoundingClientRect(); zoomEn(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 0.85 : 1 / 0.85); }, { passive: false });
  const punteros = new Map();
  let arrastre = null, pellizco = null, movido = false;
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId); punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movido = false;
    if (punteros.size === 1) arrastre = { x: e.clientX, y: e.clientY };
    else if (punteros.size === 2) { const [a, b] = [...punteros.values()]; pellizco = { d: Math.hypot(a.x - b.x, a.y - b.y), vw: view.w }; arrastre = null; }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!punteros.has(e.pointerId)) return;
    punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pellizco && punteros.size === 2) {
      const [a, b] = [...punteros.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = contenedor.getBoundingClientRect();
      view.w = pellizco.vw * (pellizco.d / Math.max(1, d)); limitar();
      zoomEn((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, 1); movido = true;
    } else if (arrastre) {
      const dx = e.clientX - arrastre.x, dy = e.clientY - arrastre.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) movido = true;
      view.x -= (dx / rect.width) * view.w; view.y -= (dy / rect.height) * view.h;
      arrastre = { x: e.clientX, y: e.clientY }; limitar(); aplicar();
    }
  });
  const soltar = (e) => { punteros.delete(e.pointerId); if (punteros.size < 2) pellizco = null; if (punteros.size === 0) arrastre = null; };
  svg.addEventListener('pointerup', soltar); svg.addEventListener('pointercancel', soltar);

  if ('ResizeObserver' in window) new ResizeObserver(() => { medir(); aplicar(); }).observe(contenedor);

  // ── Dibujo de vehículos ──
  function marcador(it) {
    const pin = document.createElement('button');
    pin.type = 'button'; pin.className = 'vm vm--' + it.sit + (it.sel ? ' sel' : '');
    pin.innerHTML = `<span class="vm-dot">${ICONO_AUTO}</span>${it.alerta ? `<span class="vm-al vm-al--${it.alerta}"></span>` : ''}<span class="vm-plate">${esc(it.plate)}</span>`;
    pin.addEventListener('click', (e) => { e.stopPropagation(); if (!movido && onSelect) onSelect(it.id); });
    return pin;
  }
  function marcadorZona(it) {
    const z = document.createElement('button');
    z.type = 'button'; z.className = 'vz vz--' + it.sit + (it.sel ? ' sel' : '');
    z.innerHTML = `<span class="vz-lbl">${esc(it.plate)}<small>zona aprox.</small></span>`;
    z.addEventListener('click', (e) => { e.stopPropagation(); if (!movido && onSelect) onSelect(it.id); });
    return z;
  }

  function draw(nuevos) {
    items = nuevos.filter((it) => it.modo !== 'hidden' && it.lat != null);
    for (const k in marcadores) { if (k !== '__zona') { marcadores[k].pin.remove(); marcadores[k].zona?.remove(); delete marcadores[k]; } }
    for (const it of items) {
      const wx = px(it.lon), wy = py(it.lat);
      const m = { wx, wy };
      if (it.modo === 'zone') { const z = marcadorZona(it); capa.appendChild(z); m.pin = z; m.zona = document.createElement('div'); m.zona.className = 'vz-circ vz--' + it.sit + (it.sel ? ' sel' : ''); capa.insertBefore(m.zona, capa.firstChild); }
      else { m.pin = marcador(it); capa.appendChild(m.pin); }
      marcadores[it.id] = m;
    }
    reubicar();
  }

  return {
    setBase(aj) {
      base = aj;
      if (!marcadores.__zona) { const c = document.createElement('div'); c.className = 'zona-hab'; capa.insertBefore(c, capa.firstChild); marcadores.__zona = c; }
      medir(); aplicar();
    },
    draw,
    reubicar() { medir(); aplicar(); },
    fitRegion() { view = { x: MUNDO.x, y: MUNDO.y, w: MUNDO.w, h: MUNDO.h }; limitar(); aplicar(); },
    fitAll(lista) {
      const pts = [[base ? px(base.base_lon) : MUNDO.x + MUNDO.w / 2, base ? py(base.base_lat) : MUNDO.y + MUNDO.h / 2]];
      for (const it of (lista || items)) if (it.modo !== 'hidden' && it.lat != null) pts.push([px(it.lon), py(it.lat)]);
      if (pts.length < 2) return this.fitRegion();
      let aX = Infinity, bX = -Infinity, aY = Infinity, bY = -Infinity;
      for (const [x, y] of pts) { aX = Math.min(aX, x); bX = Math.max(bX, x); aY = Math.min(aY, y); bY = Math.max(bY, y); }
      const w = Math.max(bX - aX, (bY - aY) * (rect.width / rect.height)) * 1.35 + 6;
      view = { x: (aX + bX) / 2 - w / 2, y: (aY + bY) / 2 - (w * rect.height / rect.width) / 2, w, h: w };
      limitar(); aplicar();
    },
    focus(it) {
      if (!it || it.lat == null) return;
      const w = Math.min(view.w, it.modo === 'zone' ? Math.max(it.zkm * 4, 10) : 8);
      view = { x: px(it.lon) - w / 2, y: py(it.lat) - (w * rect.height / rect.width) / 2, w, h: w };
      limitar(); aplicar();
    },
    destroy() { try { contenedor.replaceChildren(); } catch { /* nada */ } },
  };
}
