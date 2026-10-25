// Formato de fechas, horas e importes para la app Prenda. Todo en hora de Córdoba.
const TZ = 'America/Argentina/Cordoba';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fDT = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fHM = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fDM = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' });

const ms = (x) => (typeof x === 'number' ? x : Date.parse(x));
export const fmtMomento = (x) => fDT.format(ms(x)).replace(',', '');
export const fmtHora = (x) => fHM.format(ms(x));
export const fmtDiaMes = (x) => fDM.format(ms(x));
export function hoy() { const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now()); return p; }
export function fmtFecha(iso) { if (!iso) return ''; const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; }

export function hace(x) {
  const d = Date.now() - ms(x);
  if (d < 0) return 'recién';
  if (d < 45e3) return 'hace instantes';
  const m = Math.round(d / 60e3);
  if (m < 60) return 'hace ' + m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return 'hace ' + h + ' h' + (h < 3 && m % 60 ? ' ' + (m % 60) + ' min' : '');
  const dd = Math.floor(h / 24);
  return dd === 1 ? 'hace 1 día' : 'hace ' + dd + ' días';
}
export const nf1 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
