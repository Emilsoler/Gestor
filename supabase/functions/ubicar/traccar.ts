// Ubicación de un vehículo: la posición real (desde Traccar) o, mientras no haya equipo, una
// simulada para poder probar. Y el texto de referencia ("En Bell Ville", "6 km al este de …")
// y el código de control de la constancia. No usa nada de la red salvo el propio Traccar.

export type Pos = {
  lat: number; lon: number; momento: string; origen: 'traccar' | 'simulado';
  velocidad: number; rumbo: number; motor: 'ok' | 'cortado' | 'desconocido';
  bateria: number | null; senal: 'buena' | 'regular' | 'sin';
};

// Localidades de referencia (las mismas del mapa de la app; coordenadas aproximadas, dominio
// público). Alcanzan para describir dónde está un punto sin depender de ningún servicio externo.
const TOWNS: Array<{ n: string; c: [number, number]; r: number }> = [
  { n: 'Bell Ville', c: [-32.6259, -62.6887], r: 3.2 },
  { n: 'Villa María', c: [-32.4075, -63.2402], r: 4.5 },
  { n: 'Marcos Juárez', c: [-32.6975, -62.1061], r: 2.5 },
  { n: 'Morrison', c: [-32.5947, -62.8356], r: 1.4 },
  { n: 'Ballesteros', c: [-32.5447, -62.9839], r: 1.4 },
  { n: 'San Marcos Sud', c: [-32.6278, -62.4836], r: 1.4 },
  { n: 'Leones', c: [-32.6614, -62.2969], r: 1.6 },
  { n: 'Noetinger', c: [-32.3667, -62.3111], r: 1.4 },
  { n: 'Justiniano Posse', c: [-32.8833, -62.6833], r: 1.5 },
  { n: 'Cintra', c: [-32.3072, -62.6522], r: 1.2 },
  { n: 'Tío Pujio', c: [-32.2875, -63.3553], r: 1.2 },
];
const KX = 111.2 * Math.cos((32.6 * Math.PI) / 180), KY = 111.2;
const distKm = (a: number[], b: number[]) => Math.hypot((a[1] - b[1]) * KX, (a[0] - b[0]) * KY);
const DIRS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];

/** Texto para la persona: "En Bell Ville" o "6,2 km al este de Bell Ville". */
export function referencia(lat: number, lon: number): string {
  let best = TOWNS[0], bd = Infinity;
  for (const t of TOWNS) { const d = distKm([lat, lon], t.c); if (d < bd) { bd = d; best = t; } }
  if (bd <= best.r) return 'En ' + best.n;
  let a = (Math.atan2((lon - best.c[1]) * KX, (lat - best.c[0]) * KY) * 180) / Math.PI;
  if (a < 0) a += 360;
  const dir = DIRS[Math.round(a / 45) % 8];
  const km = bd < 10 ? bd.toFixed(1).replace('.', ',') : String(Math.round(bd));
  return `${km} km al ${dir} de ${best.n}`;
}

// ───────────────────────── Simulación (sin equipo) ─────────────────────────
// La misma cuenta que hace el mapa de la app, para que coincidan. `sim` puede ser:
//   {modo:"quieto", pos:[lat,lon]}  |  {modo:"ruta", ruta:[[lat,lon],…], v, t0}
// y opcionalmente motor:"cortado", bateria, senal, silencio_min.
export function simular(sim: any, base: [number, number], ahora = Date.now()): Pos {
  const s = sim || { modo: 'quieto', pos: base };
  let lat: number, lon: number, vel = 0, rumbo = 0;
  if (s.modo === 'ruta' && Array.isArray(s.ruta) && s.ruta.length > 1) {
    const r = s.ruta as [number, number][];
    const cum = [0];
    for (let i = 1; i < r.length; i++) cum.push(cum[i - 1] + distKm(r[i - 1], r[i]));
    const largo = cum[cum.length - 1];
    const horas = Math.max(0, (ahora - (+s.t0 || ahora)) / 3_600_000);
    let d = (+s.v || 80) * horas;
    const movil = d < largo;
    d = Math.min(d, largo);
    let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
    const a = r[i - 1], b = r[i], seg = (cum[i] - cum[i - 1]) || 1, t = (d - cum[i - 1]) / seg;
    lat = a[0] + (b[0] - a[0]) * t; lon = a[1] + (b[1] - a[1]) * t;
    if (movil) { vel = +s.v || 80; let g = (Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) * 180) / Math.PI; rumbo = (g + 360) % 360; }
  } else {
    const p = Array.isArray(s.pos) ? s.pos : base;
    lat = p[0]; lon = p[1];
  }
  const silencio = Math.max(0, +s.silencio_min || 0);
  return {
    lat, lon, momento: new Date(ahora - silencio * 60_000).toISOString(), origen: 'simulado',
    velocidad: Math.round(vel), rumbo: Math.round(rumbo),
    motor: s.motor === 'cortado' ? 'cortado' : 'ok',
    bateria: s.bateria == null ? 100 : +s.bateria,
    senal: s.senal === 'sin' ? 'sin' : s.senal === 'regular' ? 'regular' : 'buena',
  };
}

// ───────────────────────── Traccar (con equipo) ─────────────────────────
export class ErrorTraccar extends Error {
  constructor(msg: string, public tipo: 'red' | 'auth' | 'sin_posicion' | 'traccar') { super(msg); }
}

/** Última posición del dispositivo en Traccar. cfg = { url, token }. */
export async function posicionTraccar(cfg: { url: string; token: string }, deviceId: string): Promise<Pos> {
  let r: Response;
  try {
    r = await fetch(`${cfg.url.replace(/\/$/, '')}/api/positions`, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json' },
    });
  } catch (e) {
    throw new ErrorTraccar('No se pudo conectar con el servidor de rastreo. ' + String(e), 'red');
  }
  if (r.status === 401 || r.status === 403) throw new ErrorTraccar('El servidor de rastreo rechazó la credencial.', 'auth');
  if (!r.ok) throw new ErrorTraccar(`El servidor de rastreo respondió ${r.status}.`, 'traccar');
  let lista: any[];
  try { lista = await r.json(); } catch { throw new ErrorTraccar('El servidor de rastreo devolvió una respuesta ilegible.', 'traccar'); }
  const p = (Array.isArray(lista) ? lista : []).find((x) => String(x.deviceId) === String(deviceId));
  if (!p) throw new ErrorTraccar('El equipo todavía no reportó ninguna posición.', 'sin_posicion');
  const at = p.attributes || {};
  const ign = at.ignition;
  return {
    lat: +p.latitude, lon: +p.longitude, momento: p.deviceTime || p.fixTime || new Date().toISOString(), origen: 'traccar',
    velocidad: Math.round((+p.speed || 0) * 1.852), // Traccar informa en nudos
    rumbo: Math.round(+p.course || 0),
    motor: typeof ign === 'boolean' ? (ign ? 'ok' : 'cortado') : 'desconocido',
    bateria: at.batteryLevel != null ? Math.round(+at.batteryLevel) : null,
    senal: at.rssi != null ? (+at.rssi >= 20 ? 'buena' : 'regular') : 'buena',
  };
}

/** Código de control de la constancia: primeros 12 hex del SHA-256 del texto, en grupos de 4. */
export async function codigoControl(texto: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 12).toUpperCase().match(/.{4}/g)!.join(' ');
  } catch {
    let h = 2166136261; for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0).toString(16).padStart(8, '0')).slice(0, 8).toUpperCase().replace(/(.{4})/, '$1 ');
  }
}
