// Cuentas con coordenadas: distancia, el texto de referencia ("En Bell Ville", "6 km al este
// de …"), la zona aproximada y la simulación de la posición (la misma que hace la función
// `ubicar` en el servidor, para que el mapa y las consultas coincidan). Todo con los datos de
// mapa-datos.js; nada sale a la red.
import { MAPA } from './mapa-datos.js';

const LAT0 = -32.6, LON0 = -62.7;              // origen de la proyección (centro de la zona)
export const COS0 = Math.cos((LAT0 * Math.PI) / 180);
export const KX = 111.2 * COS0, KY = 111.2;    // km por grado

// Proyección a un plano en kilómetros (x al este, y al sur), para dibujar el mapa.
export const px = (lon) => (lon - LON0) * KX;
export const py = (lat) => -(lat - LAT0) * KY;
export const lonDe = (x) => LON0 + x / KX;
export const latDe = (y) => LAT0 - y / KY;

export const distKm = (a, b) => Math.hypot((a[1] - b[1]) * KX, (a[0] - b[0]) * KY);
const DIRS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
const kmTxt = (d) => (d < 10 ? d.toFixed(1).replace('.', ',') : String(Math.round(d)));

export function townCercano(lat, lon) {
  let best = MAPA.towns[0], bd = Infinity;
  for (const t of MAPA.towns) { const d = distKm([lat, lon], t.c); if (d < bd) { bd = d; best = t; } }
  return { t: best, d: bd };
}
/** "En Bell Ville" o "6,2 km al este de Bell Ville" (+ ruta si pasa muy cerca). */
export function referencia(lat, lon) {
  const n = townCercano(lat, lon);
  if (n.d <= n.t.r) return 'En ' + n.t.n;
  let road = null;
  for (const r of MAPA.roads) {
    if (!r.ref) continue;
    const d = distLinea([lat, lon], r.c);
    if (d < 1.6 && (!road || d < road.d)) road = { ref: r.ref, d };
  }
  let a = (Math.atan2((lon - n.t.c[1]) * KX, (lat - n.t.c[0]) * KY) * 180) / Math.PI;
  if (a < 0) a += 360;
  const s = `${kmTxt(n.d)} km al ${DIRS[Math.round(a / 45) % 8]} de ${n.t.n}`;
  return road ? `${road.ref}, ${s}` : s;
}
/** Zona aproximada para los vehículos al día: el pueblo más cercano, o una grilla de ~5 km. */
export function zonaDe(lat, lon) {
  const n = townCercano(lat, lon);
  if (n.d <= n.t.r + 2.5) return { c: n.t.c, r: n.t.r + 2.5, label: n.t.n };
  const g = 0.05;
  return { c: [Math.round(lat / g) * g, Math.round(lon / g) * g], r: 5, label: 'cerca de ' + n.t.n };
}

function proy(p, kx, ky) { return [p[1] * kx, p[0] * ky]; }
function distLinea(p, linea) {
  const kx = KX, ky = KY; let m = Infinity;
  const P = proy(p, kx, ky);
  for (let i = 0; i < linea.length - 1; i++) {
    const A = proy(linea[i], kx, ky), B = proy(linea[i + 1], kx, ky);
    const vx = B[0] - A[0], vy = B[1] - A[1], L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, ((P[0] - A[0]) * vx + (P[1] - A[1]) * vy) / L)) : 0;
    m = Math.min(m, Math.hypot(P[0] - (A[0] + t * vx), P[1] - (A[1] + t * vy)));
  }
  return m;
}

// ───────────────────────── Simulación (sin equipo) ─────────────────────────
// Igual que supabase/functions/ubicar/traccar.ts: con esto, lo que muestra el mapa coincide con
// lo que devuelve una consulta. `sim` = {modo:"quieto",pos} | {modo:"ruta",ruta,v,t0}.
export function simular(sim, base, ahora = Date.now()) {
  const s = sim || { modo: 'quieto', pos: base };
  let lat, lon, vel = 0, rumbo = 0, movil = false;
  if (s.modo === 'ruta' && Array.isArray(s.ruta) && s.ruta.length > 1) {
    const r = s.ruta, cum = [0];
    for (let i = 1; i < r.length; i++) cum.push(cum[i - 1] + distKm(r[i - 1], r[i]));
    const largo = cum[cum.length - 1];
    const horas = Math.max(0, (ahora - (+s.t0 || ahora)) / 3_600_000);
    let d = (+s.v || 80) * horas;
    movil = d < largo; d = Math.min(d, largo);
    let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
    const a = r[i - 1], b = r[i], seg = (cum[i] - cum[i - 1]) || 1, t = (d - cum[i - 1]) / seg;
    lat = a[0] + (b[0] - a[0]) * t; lon = a[1] + (b[1] - a[1]) * t;
    if (movil) { vel = +s.v || 80; rumbo = ((Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) * 180) / Math.PI + 360) % 360; }
  } else {
    const p = Array.isArray(s.pos) ? s.pos : base; lat = p[0]; lon = p[1];
  }
  const silencio = Math.max(0, +s.silencio_min || 0);
  return {
    lat, lon, velocidad: Math.round(vel), rumbo: Math.round(rumbo), movil,
    momento: ahora - silencio * 60_000, origen: 'simulado',
    motor: s.motor === 'cortado' ? 'cortado' : 'ok',
    bateria: s.bateria == null ? 100 : +s.bateria,
    senal: s.senal === 'sin' ? 'sin' : s.senal === 'regular' ? 'regular' : 'buena',
  };
}
