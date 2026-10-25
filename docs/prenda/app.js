// Interfaz de Prenda. Los datos y la red viven en datos.js; el mapa, en mapa.js; las cuentas de
// coordenadas y la simulación, en geo.js; el formato, en textos.js.
import {
  D, iniciar, reconectar, entrar, salir, cambiarClave, alCambiar, mensaje, ajustes, SIT_TXT, SITUACIONES,
  crearVehiculo, cambiarVehiculo, borrarVehiculo, guardarAjustes, ubicar, ubicacionesDe, ultimaUbicacion,
} from './datos.js';
import { simular, referencia, zonaDe, distKm } from './geo.js';
import { crearMapa } from './mapa.js';
import { esc, hoy, fmtFecha, fmtMomento, fmtHora, fmtDiaMes, hace, nf1 } from './textos.js';

const VERSION = '1.0.0';
const CLAVE_MIN = 10;
const MOTIVOS = ['Control de la garantía por mora', 'Diligencia de secuestro ordenada', 'Alerta del equipo', 'Pedido del deudor por robo o extravío', 'Otro motivo'];
const VISTAS = { mapa: 'Mapa', vehiculos: 'Vehículos', alertas: 'Alertas', bitacora: 'Bitácora' };
const REVELADO_MS = 15 * 60e3;
const DIA = 864e5;
const JUICIOS = '../', COBRANZAS = '../cobranzas/';

const S = {
  pantalla: 'arranque', vista: 'mapa', sel: null, panel: '', form: null, menu: false,
  ocupado: false, reveal: {}, motivo: {}, recorrido: false, falla: '',
};
try { S.vista = VISTAS[localStorage.getItem('pr.vista')] ? localStorage.getItem('pr.vista') : 'mapa'; } catch { /* sin almacenamiento */ }

const $ = (s) => document.querySelector(s);
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const veh = (id) => D.vehiculos.find((x) => x.id === id);
const base = () => { const a = ajustes(); return [a.base_lat, a.base_lon]; };

// ───────────────────────── Posición, visibilidad, alertas ─────────────────────────
function posDe(v) {
  if (v.traccar_id) { const u = ultimaUbicacion(v.id); return u && u.resultado && u.resultado.lat != null ? { ...u.resultado, momento: u.resultado.momento_reporte } : null; }
  if (v.sim) return simular(v.sim, base());
  return null;
}
const grupoDe = (v) => (v.consentimiento ? v.situacion : 'sinconsent');
function visDe(v) {
  if (!v.consentimiento) return 'hidden';
  const p = posDe(v); if (!p) return 'hidden';
  if (ajustes().politica === 'siempre' || v.situacion !== 'al_dia') return 'exact';
  return (S.reveal[v.id] || 0) > Date.now() ? 'exact' : 'zone';
}
const zonaKm = (v) => (+v.zona_km || ajustes().zona_km);
function alertasDe(v) {
  if (!v.consentimiento) return [];
  const p = posDe(v); if (!p) return [];
  const out = [], ahora = Date.now();
  if (p.motor === 'cortado') out.push({ sev: 'crit', at: p.momento, titulo: 'Desconectaron el GPS de la batería del auto', detalle: 'El equipo sigue informando con su batería interna. Puede ser un intento de esconder el vehículo.' });
  if (p.senal === 'sin' || ahora - (typeof p.momento === 'number' ? p.momento : Date.parse(p.momento)) > DIA) out.push({ sev: 'warn', at: p.momento, titulo: 'Sin señal ' + hace(p.momento), detalle: 'Puede ser un chip sin saldo, una cochera subterránea o un equipo dañado.' });
  const d = distKm([p.lat, p.lon], base());
  if (d > zonaKm(v)) out.push({ sev: 'warn', at: p.momento, titulo: 'Fuera de la zona habitual', detalle: `Está a ${Math.round(d)} km de ${referencia(base()[0], base()[1]).replace(/^En /, '')}. La zona habitual es de ${zonaKm(v)} km.` });
  return out;
}
const todasAlertas = () => D.vehiculos.flatMap((v) => alertasDe(v).map((a) => ({ ...a, v }))).sort((a, b) => (a.sev === b.sev ? bms(b.at) - bms(a.at) : a.sev === 'crit' ? -1 : 1));
const bms = (x) => (typeof x === 'number' ? x : Date.parse(x));

function itemMapa(v) {
  const modo = visDe(v); if (modo === 'hidden') return { id: v.id, modo: 'hidden' };
  const p = posDe(v), al = alertasDe(v), crit = al.some((a) => a.sev === 'crit');
  return { id: v.id, plate: v.dominio, sit: v.situacion, modo, lat: p.lat, lon: p.lon, zkm: zonaKm(v) + 1, alerta: al.length ? (crit ? 'crit' : 'warn') : '', sel: S.sel === v.id };
}

// ───────────────────────── Utilidades de interfaz ─────────────────────────
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, Math.min(9000, Math.max(3200, msg.length * 55))); }
async function conBoton(boton, textoOcupado, tarea) {
  if (S.ocupado) return; S.ocupado = true;
  const antes = boton ? boton.textContent : '';
  if (boton) { boton.disabled = true; boton.textContent = textoOcupado; }
  try { await tarea(); } finally { S.ocupado = false; if (boton && boton.isConnected) { boton.disabled = false; boton.textContent = antes; } }
}
function poner(ruta, valor) { const ks = ruta.split('.'); let o = S; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } o[ks[ks.length - 1]] = valor; }
const valor = (ruta) => ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), S);
const atar = (ruta, extra = '') => `data-k="${esc(ruta)}" value="${esc(valor(ruta) ?? '')}"${extra}`;
function guardarFoco(caja) { const a = document.activeElement; if (!a || !caja || !caja.contains(a) || !(a.dataset?.k || a.id)) return null; let sel = null; try { if (a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch { /* nada */ } return { k: a.dataset.k, id: a.id, sel }; }
function devolverFoco(f) { if (!f) return; const el = f.k ? document.querySelector(`[data-k="${CSS.escape(f.k)}"]`) : document.getElementById(f.id); if (!el || el === document.activeElement) return; el.focus({ preventScroll: true }); if (f.sel) try { el.setSelectionRange(f.sel[0], f.sel[1]); } catch { /* nada */ } }
const opciones = (valores, actual) => valores.map((v) => { const [val, txt] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(val)}"${String(val) === String(actual) ? ' selected' : ''}>${esc(txt)}</option>`; }).join('');
const pill = (txt, clase) => `<span class="pill ${clase}">${esc(txt)}</span>`;
const plate = (d, lg) => `<span class="plate${lg ? ' lg' : ''}" aria-label="Dominio ${esc(d)}"><b>ARGENTINA</b><span>${esc(d)}</span></span>`;
const SITCLASE = { al_dia: 's-ok', mora: 's-warn', ejecucion: 's-bad', sinconsent: 's-mut' };
const SITFULL = { ...SIT_TXT, sinconsent: 'Sin consentimiento' };

// ───────────────────────── Pantallas de ingreso ─────────────────────────
function mostrar(pantalla) {
  S.pantalla = pantalla; const enApp = pantalla === 'listo';
  $('#vArranque').hidden = true; $('#vApp').hidden = !enApp; $('#vIngreso').hidden = enApp;
  if (enApp) { $('#ingresoCuerpo').innerHTML = ''; render(); return; }
  cerrarFicha(); S.menu = false; renderMenu();
  $('#main').innerHTML = ''; $('#sub').textContent = '';
  renderIngreso();
}
function renderIngreso() {
  const c = $('#ingresoCuerpo'), email = esc(D.usuario?.email || '');
  const err = '<p class="error" id="i_error" role="alert" hidden></p>';
  if (S.pantalla === 'ingreso') {
    c.innerHTML = `<form id="fIngreso" novalidate>
      <label class="f">Email<input id="i_email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"></label>
      <label class="f">Contraseña<input id="i_clave" type="password" autocomplete="current-password"></label>${err}
      <button class="btn primary" type="submit">Ingresar</button></form>
      <p class="pie hint">Es el mismo usuario que el del gestor de juicios y cobranzas.</p>`;
    $('#i_email').focus();
  } else if (S.pantalla === 'clave-temporal') {
    c.innerHTML = `<div><b>Elegí tu contraseña</b><p class="hint m0">La clave con la que entraste es temporal. Elegí una que solo vos conozcas, de ${CLAVE_MIN} caracteres o más.</p></div>
      <form id="fClave" novalidate><input type="email" autocomplete="username" value="${email}" hidden>
      <label class="f">Contraseña nueva<input id="n_clave" type="password" autocomplete="new-password"></label>
      <label class="f">Repetila<input id="n_clave2" type="password" autocomplete="new-password"></label>${err}
      <button class="btn primary" type="submit">Guardar contraseña</button></form>
      <p class="pie hint">Ingresaste como ${email}. <button class="btn small" data-ing="salir">Cerrar sesión</button></p>`;
    $('#n_clave').focus();
  } else if (S.pantalla === 'sin-acceso') {
    c.innerHTML = `<div><b>Esta cuenta no está autorizada</b><p class="hint m0">Ingresaste como ${email}, pero esa cuenta no tiene permiso para usar la app.</p></div>
      <div class="acc"><button class="btn" data-ing="reintentar">Volver a comprobar</button><button class="btn" data-ing="salir">Cerrar sesión</button></div>`;
  } else if (S.pantalla === 'sin-red') {
    c.innerHTML = `<div><b>No se pudo conectar con la base de datos</b><p class="hint m0">Revisá tu conexión. Si hace más de una semana que no se usa, la base puede estar en pausa: pedile a Claude que la reactive.</p></div>
      <div class="acc"><button class="btn primary" data-ing="reintentar">Reintentar</button></div>`;
  } else if (S.pantalla === 'en-marco') {
    c.innerHTML = `<div><b>La app no se abre dentro de otra página</b><p class="hint m0">Por seguridad solo funciona en su propia pestaña o instalada.</p></div>
      <div class="acc"><a class="btn primary" href="./" target="_top" rel="noopener">Abrir Prenda</a></div>`;
  } else if (S.pantalla === 'sin-configurar') {
    c.innerHTML = `<div><b>Falta conectar la app con su base de datos</b><p class="hint m0">Todavía no se cargaron la dirección y la clave pública del proyecto en config.js.</p></div>`;
  } else {
    c.innerHTML = `<div><b>No se pudo abrir la app</b><p class="hint m0">${esc(S.falla || '')}</p></div><div class="acc"><button class="btn primary" data-ing="reintentar">Reintentar</button></div>`;
  }
}
function errorIngreso(t) { const e = $('#i_error'); if (e) { e.textContent = t; e.hidden = !t; } }
async function reintentar(boton) { await conBoton(boton, 'Conectando…', async () => { try { mostrar(await reconectar()); } catch (err) { S.falla = mensaje(err, 'no se pudo abrir'); mostrar('error'); } }); }

$('#vIngreso').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'fIngreso') {
    errorIngreso('');
    const email = $('#i_email').value.trim(), clave = $('#i_clave').value;
    if (!email || !clave) return errorIngreso('Completá email y contraseña');
    await conBoton(e.submitter, 'Ingresando…', async () => { try { mostrar(await entrar(email, clave)); } catch (err) { errorIngreso(mensaje(err)); } });
  } else if (e.target.id === 'fClave') {
    errorIngreso('');
    const a = $('#n_clave').value, b = $('#n_clave2').value;
    if (a.length < CLAVE_MIN) return errorIngreso(`La contraseña tiene que tener ${CLAVE_MIN} caracteres o más`);
    if (a !== b) return errorIngreso('Las dos contraseñas no coinciden');
    await conBoton(e.submitter, 'Guardando…', async () => { try { mostrar(await cambiarClave(a)); } catch (err) { errorIngreso(mensaje(err)); } });
  }
});
$('#vIngreso').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ing]'); if (!b) return;
  if (b.dataset.ing === 'salir') salir().then(() => mostrar('ingreso'));
  else if (b.dataset.ing === 'reintentar') reintentar(b);
});

// ───────────────────────── Armado general ─────────────────────────
function subtitulo(t) {
  const partes = [esc(t)];
  if (D.leido && D.enLinea) partes.push('actualizado ' + fmtHora(D.leido));
  $('#sub').innerHTML = partes.join(' · ') + (D.enVivo && D.enLinea ? ' · <span class="vivo">en vivo</span>' : '');
}
function insignia(sel, n, clase) { const b = $(sel); if (!b) return; b.hidden = !n; b.className = 'badge' + (clase ? ' ' + clase : ''); b.textContent = n || ''; }

let mapWrap = null, mapaInst = null;
function render() {
  if (S.pantalla !== 'listo') return;
  const main = $('#main'), foco = guardarFoco(main);
  for (const v of Object.keys(VISTAS)) $('#v_' + v).setAttribute('aria-pressed', S.vista === v);
  $('#tVista').textContent = VISTAS[S.vista];
  $('#btnCuenta').textContent = (D.acceso?.nombre || D.usuario?.email || '?').trim().charAt(0).toUpperCase();
  renderFranja();
  const nAl = todasAlertas().length;
  insignia('#nAlertas', nAl, 'urg');
  if (!D.activo) { main.innerHTML = vacio('Falta activar la geolocalización', 'La base todavía no tiene las tablas de Prenda. Pedile a Claude que aplique la migración.'); subtitulo(''); return; }
  if (!D.cargado) { main.innerHTML = vacio('Cargando…', 'Un momento.'); subtitulo('Cargando…'); return; }
  if (S.vista === 'mapa') renderMapa(main);
  else { if (mapWrap && mapWrap.parentNode === main) mapWrap.remove(); main.innerHTML = { vehiculos: vistaVehiculos, alertas: vistaAlertas, bitacora: vistaBitacora }[S.vista](); }
  devolverFoco(foco);
}
const vacio = (t, s) => `<div class="empty"><b>${esc(t)}</b>${esc(s)}</div>`;

function renderFranja() {
  let h = '';
  if (!D.enLinea) h = `<div class="franja"><div><b>Sin conexión.</b> ${D.deCache && D.leido ? 'Estás viendo lo guardado en este dispositivo. ' : ''}Para ubicar o guardar cambios hace falta conexión.</div><button class="btn small" data-ing="reintentar">Reintentar</button></div>`;
  $('#franja').innerHTML = h;
}

// ───────────────────────── Vista Mapa ─────────────────────────
function renderMapa(main) {
  if (!mapWrap) {
    mapWrap = document.createElement('div'); mapWrap.className = 'mapa-wrap';
    const canvas = document.createElement('div'); canvas.id = 'mapaCanvas';
    const legend = document.createElement('div'); legend.className = 'leyenda'; legend.setAttribute('aria-hidden', 'true');
    legend.innerHTML = '<span><i class="lg mora"></i>En mora</span><span><i class="lg ejecucion"></i>En ejecución</span><span><i class="lg al_dia"></i>Al día · zona aprox.</span>';
    const ver = document.createElement('button'); ver.type = 'button'; ver.className = 'btn small mapa-ver'; ver.textContent = 'Ver todos';
    ver.addEventListener('click', () => mapaInst && mapaInst.fitAll(D.vehiculos.map(itemMapa)));
    mapWrap.append(canvas, legend, ver);
    mapaInst = crearMapa(canvas, { onSelect: abrir });
    mapaInst.setBase(ajustes());
  }
  main.innerHTML = ''; main.appendChild(mapWrap);
  subtitulo(resumenVehiculos());
  mapaInst.setBase(ajustes());
  actualizarMapa();
  requestAnimationFrame(() => mapaInst && mapaInst.reubicar());
}
function resumenVehiculos() {
  const n = D.vehiculos.length; if (!n) return 'Todavía no hay vehículos cargados';
  const c = { al_dia: 0, mora: 0, ejecucion: 0, sinconsent: 0 };
  D.vehiculos.forEach((v) => c[grupoDe(v)]++);
  const ps = []; if (c.ejecucion) ps.push(c.ejecucion + ' en ejecución'); if (c.mora) ps.push(c.mora + ' en mora'); if (c.al_dia) ps.push(c.al_dia + ' al día'); if (c.sinconsent) ps.push(c.sinconsent + ' sin consentimiento');
  return `${n} ${n === 1 ? 'vehículo' : 'vehículos'} · ${ps.join(' · ')}`;
}
function actualizarMapa() { if (mapaInst) mapaInst.draw(D.vehiculos.map(itemMapa)); }

// ───────────────────────── Vista Vehículos ─────────────────────────
const ORD = { ejecucion: 0, mora: 1, al_dia: 2, sinconsent: 3 };
function vistaVehiculos() {
  subtitulo(resumenVehiculos());
  if (!D.vehiculos.length) return vacio('Todavía no hay vehículos cargados', 'Usá “+ Nuevo vehículo”, o pedile a Claude que cargue algunos de ejemplo para probar.');
  const list = [...D.vehiculos].sort((a, b) => (ORD[grupoDe(a)] - ORD[grupoDe(b)]) || (alertasDe(b).length - alertasDe(a).length) || a.dominio.localeCompare(b.dominio));
  return '<ul class="vlist">' + list.map(filaVehiculo).join('') + '</ul>';
}
function filaVehiculo(v) {
  const g = grupoDe(v), al = alertasDe(v), crit = al.some((a) => a.sev === 'crit'), p = posDe(v);
  const flag = al.length ? `<span class="flag ${crit ? 'crit' : 'warn'}">${al.length === 1 ? esc(al[0].titulo) : al.length + ' alertas'}</span>` : '';
  const donde = !v.consentimiento ? 'Falta el consentimiento' : !p ? 'Equipo sin vincular todavía' : visDe(v) === 'zone' ? 'Zona aprox.: ' + zonaDe(p.lat, p.lon).label : referencia(p.lat, p.lon);
  return `<li><button type="button" class="vrow" data-id="${v.id}">${plate(v.dominio)}
    <span class="vrow-body"><span class="vrow-t">${esc(v.marca)} ${esc(v.modelo)} ${v.anio ? `<span class="muted">${v.anio}</span>` : ''}</span>
    <span class="vrow-m">${esc(v.deudor)}${v.operacion ? ' · N° ' + esc(v.operacion) : ''}</span>
    <span class="vrow-s">${pill(SITFULL[g], SITCLASE[g])}${flag}</span>
    <span class="vrow-w" data-donde="${v.id}">${esc(donde)}</span></span>
    <span class="vrow-time" data-ago="${v.id}">${v.consentimiento && p ? hace(p.momento) : ''}</span></button></li>`;
}

// ───────────────────────── Vista Alertas ─────────────────────────
function vistaAlertas() {
  subtitulo('Equipos que piden atención');
  const al = todasAlertas();
  if (!al.length) return vacio('No hay alertas', 'Todos los equipos informan con normalidad.');
  return '<p class="nota">Las alertas llegan aunque el crédito esté al día: avisan si alguien toca el equipo o si la garantía se aleja.</p><ul class="alist">' +
    al.map((a) => `<li><button type="button" class="arow ${a.sev}" data-id="${a.v.id}"><span class="arow-ic">${a.sev === 'crit' ? IC.rayo : IC.alerta}</span>
      <span class="arow-b"><span class="arow-t">${esc(a.titulo)}</span><span class="arow-d">${esc(a.detalle)}</span><span class="arow-m">${esc(a.v.dominio)} · ${hace(a.at)}</span></span></button></li>`).join('') + '</ul>';
}

// ───────────────────────── Vista Bitácora ─────────────────────────
function vistaBitacora() {
  subtitulo(D.ubicaciones.length + ' consultas registradas');
  if (!D.ubicaciones.length) return vacio('Todavía no hay consultas', 'Cada vez que ubiques un vehículo, queda anotado acá: quién, cuándo, qué vehículo y por qué.');
  return '<p class="nota">Cada consulta queda anotada y no se puede borrar ni modificar.</p><ol class="loglist">' +
    D.ubicaciones.map((u) => `<li class="logrow"><span class="logrow-t">${fmtDiaMes(u.momento)} ${fmtHora(u.momento)}</span>
      <span class="logrow-b"><b>${esc(u.dominio || '—')}</b> · ${esc(u.resultado?.referencia || (u.exito ? '' : 'el equipo no respondió'))}<br>
      <span class="logrow-mo">${esc(u.motivo || 'Sin motivo')}${u.nota ? ' · ' + esc(u.nota) : ''}</span></span>
      <span class="logrow-u">${esc(u.consultado_por || '')}</span></li>`).join('') + '</ol>';
}

// ───────────────────────── Ficha (drawer) ─────────────────────────
function abrir(id) { S.sel = id; S.recorrido = false; renderFicha(); if (S.vista === 'mapa') { actualizarMapa(); const it = itemMapa(veh(id)); if (it.modo !== 'hidden') mapaInst.focus(it); } }
function cerrarFicha() { const d = $('#drawer'); if (d) { d.hidden = true; d.innerHTML = ''; } S.sel = null; S.recorrido = false; }
function renderFicha() {
  const v = veh(S.sel); const d = $('#drawer'); if (!v) { d.hidden = true; d.innerHTML = ''; return; }
  const g = grupoDe(v), al = alertasDe(v);
  d.hidden = false;
  d.innerHTML = `<div class="dr-pane" role="dialog" aria-modal="true" aria-label="Vehículo ${esc(v.dominio)}">
    <div class="dr-head"><button type="button" class="dr-x" data-cerrar aria-label="Cerrar">${IC.volver}<span>Volver</span></button>
      <button type="button" class="btn small" data-act="editar">Editar</button></div>
    <div class="dr-body">
      <div class="f-hero">${plate(v.dominio, true)}<div><h2 class="f-title">${esc(v.marca)} ${esc(v.modelo)}</h2>
        <p class="f-sub">${v.anio ? 'Modelo ' + v.anio + ' · ' : ''}${pill(SITFULL[g], SITCLASE[g])}</p></div></div>
      ${al.map((a) => `<div class="aviso ${a.sev}" role="alert"><span>${a.sev === 'crit' ? IC.rayo : IC.alerta}</span><div><b>${esc(a.titulo)}</b><p>${esc(a.detalle)}</p><small>${hace(a.at)}</small></div></div>`).join('')}
      ${tarjetaUbicacion(v)}${tarjetaCredito(v)}${tarjetaEquipo(v)}${tarjetaConsent(v)}
    </div></div>`;
}
function tarjetaUbicacion(v) {
  const modo = visDe(v), p = posDe(v);
  if (!v.consentimiento) return `<section class="card punteada"><h3>Ubicación</h3><p class="lock">${IC.candado}<span>La ubicación queda oculta hasta registrar el consentimiento firmado por el tomador.</span></p><div class="acc"><button type="button" class="btn primary" data-act="consent">Registrar consentimiento</button></div></section>`;
  if (!p) return `<section class="card punteada"><h3>Ubicación</h3><p class="lock">${IC.candado}<span>El equipo todavía no está vinculado. Cuando el instalador lo coloque y tengas el IMEI, se conecta y empieza a informar.</span></p></section>`;
  const lat = p.lat.toFixed(5), lon = p.lon.toFixed(5);
  const tr = ubicacionesDe(v.id).filter((u) => u.resultado?.lat != null).slice(0, 8).map((u) => [u.resultado.lat, u.resultado.lon]);
  if (modo === 'zone') {
    const z = zonaDe(p.lat, p.lon);
    return `<section class="card"><h3>Ubicación</h3><p class="donde-big">Zona aproximada: ${esc(z.label)}</p>
      <p class="muted">Crédito al día: se muestra la zona. Para ver el punto exacto, indicá un motivo (queda en la bitácora).</p>
      <p class="sello">Última señal <span data-ago="${v.id}">${hace(p.momento)}</span></p>
      <div class="acc"><button type="button" class="btn primary" data-act="locate">${IC.target}Ver ubicación exacta</button></div></section>`;
  }
  const revelado = v.situacion === 'al_dia' && ajustes().politica !== 'siempre' && S.reveal[v.id];
  return `<section class="card"><h3>Última posición</h3>
    <p class="donde-big" data-donde="${v.id}">${esc(referencia(p.lat, p.lon))}${p.velocidad ? ' · ' + p.velocidad + ' km/h' : ''}</p>
    <dl class="kv"><dt>Reporte</dt><dd><span data-abs="${v.id}">${fmtMomento(p.momento)}</span> · <span data-ago="${v.id}">${hace(p.momento)}</span></dd>
      <dt>Coordenadas</dt><dd class="mono" data-coord="${v.id}">${lat}, ${lon}</dd>
      <dt>Origen</dt><dd>${p.origen === 'traccar' ? 'Equipo GPS' : 'Simulado (sin equipo todavía)'}</dd></dl>
    ${revelado ? `<p class="muted small">Punto exacto visible hasta las ${fmtHora(S.reveal[v.id])}.</p>` : ''}
    <div class="acc">
      <button type="button" class="btn primary" data-act="locate">${IC.target}Ubicar ahora</button>
      ${tr.length > 1 ? `<button type="button" class="btn" data-act="recorrido" aria-pressed="${S.recorrido}">${IC.ruta}${S.recorrido ? 'Ocultar recorrido' : 'Ver recorrido'}</button>` : ''}
      <a class="btn" data-gmaps="${v.id}" href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">${IC.ext}Google Maps</a>
      <button type="button" class="btn" data-act="compartir">${IC.copiar}Copiar para WhatsApp</button>
      <button type="button" class="btn" data-act="constancia">${IC.doc}Constancia</button>
    </div></section>`;
}
function tarjetaCredito(v) {
  return `<section class="card"><h3>Crédito</h3><dl class="kv">
    <dt>Deudor</dt><dd>${esc(v.deudor) || '—'}${v.dni ? ' · DNI ' + esc(v.dni) : ''}</dd>
    ${v.operacion ? `<dt>Operación</dt><dd>Ayuda económica con garantía prendaria N° ${esc(v.operacion)}</dd>` : ''}
    ${v.expte ? `<dt>Juicio</dt><dd>Expte. ${esc(v.expte)} · <a href="${JUICIOS}" target="_blank" rel="noopener">abrir en el gestor</a></dd>` : ''}
    ${v.telefono ? `<dt>Teléfono</dt><dd>${esc(v.telefono)}</dd>` : ''}</dl></section>`;
}
function tarjetaEquipo(v) {
  const p = posDe(v), cut = p && p.motor === 'cortado';
  return `<section class="card"><h3>Equipo GPS</h3><dl class="kv">
    ${p ? `<dt>Alimentación</dt><dd class="${cut ? 'bad' : 'good'}">${cut ? 'Desconectado de la batería del auto' : 'Conectado a la batería'}</dd>
    ${p.bateria != null ? `<dt>Batería interna</dt><dd data-batt="${v.id}">${p.bateria} %</dd>` : ''}
    <dt>Señal</dt><dd>${p.senal === 'sin' ? 'Sin señal' : p.senal === 'regular' ? 'Regular' : 'Buena'}</dd>` : ''}
    <dt>Equipo</dt><dd>${esc(v.equipo || 'Teltonika FMC920')}${v.imei ? ' · IMEI …' + esc(v.imei.slice(-4)) : ''}</dd>
    ${v.instalado ? `<dt>Instalado</dt><dd>${fmtFecha(v.instalado)}</dd>` : ''}
    <dt>Vínculo</dt><dd>${v.traccar_id ? 'Equipo vinculado (' + esc(v.traccar_id) + ')' : 'Sin equipo: la ubicación se simula para probar'}</dd></dl></section>`;
}
function tarjetaConsent(v) {
  if (!v.consentimiento) return '';
  const c = v.consentimiento;
  return `<section class="card"><h3>Consentimiento</h3><dl class="kv">
    <dt>Firmado</dt><dd>${fmtFecha(c.fecha)}</dd>
    <dt>Cláusula</dt><dd>Geolocalización del bien prendado, ${esc(c.version || 'v1.0')}</dd>
    <dt>Documento</dt><dd>${esc(c.archivo || 'Anexo firmado al contrato de prenda')}</dd></dl>
    <div class="acc"><button type="button" class="btn small" data-act="consent">Actualizar</button></div></section>`;
}

// ───────────────────────── Acciones de la ficha ─────────────────────────
$('#drawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-cerrar]')) { cerrarFicha(); if (S.vista === 'mapa') actualizarMapa(); else render(); return; }
  const act = e.target.closest('[data-act]'); const v = veh(S.sel); if (!act || !v) return;
  const a = act.dataset.act;
  if (a === 'locate') pedirMotivo(v, 'locate');
  else if (a === 'constancia') conMotivo(v, 'constancia');
  else if (a === 'compartir') conMotivo(v, 'compartir');
  else if (a === 'consent') abrirConsent(v);
  else if (a === 'editar') abrirVehiculo(v);
  else if (a === 'recorrido') { S.recorrido = !S.recorrido; renderFicha(); }
});

function defecto(v) { if (v.situacion === 'ejecucion') return MOTIVOS[1]; if (v.situacion === 'mora') return MOTIVOS[0]; if (alertasDe(v).length) return MOTIVOS[2]; return null; }
function conMotivo(v, accion) { const m = S.motivo[v.id]; if (m && Date.now() - m.at < REVELADO_MS) return correr(v, accion, m); pedirMotivo(v, accion); }
function pedirMotivo(v, accion) {
  const tit = { locate: (visDe(v) === 'zone' ? 'Ver ubicación exacta · ' : 'Ubicar ') + v.dominio, constancia: 'Constancia · ' + v.dominio, compartir: 'Compartir ubicación · ' + v.dominio }[accion];
  const go = { locate: 'Ubicar ahora', constancia: 'Emitir constancia', compartir: 'Copiar ubicación' }[accion];
  const def = defecto(v);
  abrirHoja(`<form id="fMot" novalidate><h2 class="hoja-t">${esc(tit)}</h2>
    <p class="muted">${esc(v.marca)} ${esc(v.modelo)} · ${esc(v.deudor)}. La consulta queda anotada en la bitácora con el motivo.</p>
    <fieldset class="opts"><legend>Motivo de la consulta</legend>
    ${MOTIVOS.map((m, i) => `<label class="opt" for="mo${i}"><input type="radio" name="mot" id="mo${i}" value="${esc(m)}"${m === def ? ' checked' : ''}><span>${esc(m)}</span></label>`).join('')}
    </fieldset><label class="fld" for="mNota">Nota (opcional)</label><textarea id="mNota" rows="2" placeholder="Ej.: pedido del martillero para la diligencia"></textarea>
    <p class="error" id="mErr" hidden></p>
    <div class="hoja-acc"><button type="button" class="btn" data-cerrar-hoja>Cancelar</button><button type="submit" class="btn primary">${esc(go)}</button></div></form>`);
  $('#fMot').addEventListener('submit', (e) => {
    e.preventDefault();
    const r = $('#fMot').querySelector('input[name="mot"]:checked'), nota = $('#mNota').value.trim(), er = $('#mErr');
    if (!r) { er.textContent = 'Falta elegir un motivo.'; er.hidden = false; return; }
    if (r.value === 'Otro motivo' && !nota) { er.textContent = 'Para «Otro motivo» hace falta una nota.'; er.hidden = false; return; }
    const m = { text: r.value, nota, at: Date.now() }; S.motivo[v.id] = m; correr(v, accion, m);
  });
}
async function correr(v, accion, m) {
  if (accion === 'locate') return hacerUbicar(v, m);
  cerrarHoja();
  if (accion === 'compartir') return compartir(v, m);
  if (accion === 'constancia') return constancia(v, m);
}
async function hacerUbicar(v, m) {
  abrirHoja(`<div class="progreso" role="status"><span class="spin" aria-hidden="true"></span><div><p class="hoja-t">Pidiendo la posición al equipo…</p><p class="muted">El pedido viaja por el chip 4G y el aparato contesta con su ubicación.</p></div></div>`);
  try {
    const u = await ubicar(v.id, m.text, m.nota);
    if (v.situacion === 'al_dia' && ajustes().politica !== 'siempre') S.reveal[v.id] = Date.now() + REVELADO_MS;
    cerrarHoja();
    toast(u.resultado?.motor === 'cortado' ? 'Respondió con su batería interna. Posición actualizada.' : 'Posición actualizada.');
    renderFicha(); if (S.vista === 'mapa') { actualizarMapa(); const it = itemMapa(v); if (it.modo !== 'hidden') mapaInst.focus(it); }
  } catch (err) {
    cerrarHoja();
    if (err.codigo === 'sin_consentimiento') { toast('Falta registrar el consentimiento.'); renderFicha(); }
    else toast(mensaje(err, 'no se pudo ubicar'));
  }
}
function textoCompartir(v, p) {
  const lat = p.lat.toFixed(5), lon = p.lon.toFixed(5);
  return `Vehículo dominio ${v.dominio} (${v.marca} ${v.modelo}${v.anio ? ', ' + v.anio : ''})\nLugar: ${referencia(p.lat, p.lon)}\nReporte del equipo: ${fmtMomento(p.momento)}\nMapa: https://www.google.com/maps?q=${lat},${lon}`;
}
function compartir(v, m) { const p = posDe(v); if (!p) return; copiar(textoCompartir(v, p), 'Ubicación copiada, lista para pegar en WhatsApp.'); }
async function sha(txt) {
  try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join(''); }
  catch { let h = 2166136261; for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0).toString(16)).repeat(2); }
}
async function constancia(v, m) {
  const p = posDe(v); if (!p) return;
  const emit = Date.now(), lat = p.lat.toFixed(5), lon = p.lon.toFixed(5);
  const filas = [
    ['Emitida', fmtMomento(emit) + ' (hora de Córdoba)'],
    ['Bien', `${v.marca} ${v.modelo}${v.anio ? ', modelo ' + v.anio : ''}, dominio ${v.dominio}`],
    ['Deudor', v.deudor], v.operacion ? ['Operación', 'Ayuda económica con garantía prendaria N° ' + v.operacion] : null,
    ['Coordenadas', `${lat}, ${lon} (WGS84)`], ['Referencia', referencia(p.lat, p.lon)],
    ['Último reporte del equipo', fmtMomento(p.momento)],
    ['Consentimiento', 'Firmado el ' + fmtFecha(v.consentimiento.fecha) + ', cláusula ' + (v.consentimiento.version || 'v1.0')],
    ['Motivo de la consulta', m.text + (m.nota ? ' (' + m.nota + ')' : '')],
  ].filter(Boolean);
  const texto = ['CONSTANCIA DE UBICACIÓN DEL BIEN PRENDADO'].concat(filas.map((f) => f[0] + ': ' + f[1])).join('\n');
  const cod = (await sha(texto)).slice(0, 12).toUpperCase().match(/.{4}/g).join(' ');
  const full = texto + '\nCódigo de control: ' + cod;
  abrirHoja(`<article class="doc"><p class="doc-k">Prenda · Estudio Soler</p><h2 class="doc-t">Constancia de ubicación del bien prendado</h2>
    <dl class="doc-r">${filas.map((f) => `<dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd>`).join('')}</dl>
    <p class="doc-h">Código de control<span class="mono">${cod}</span></p></article>
    <p class="muted small">El código de control permite comprobar que la constancia no se modificó después de emitida.</p>
    <div class="hoja-acc"><button type="button" class="btn" id="docCopy">${IC.copiar}Copiar texto</button><button type="button" class="btn primary" data-cerrar-hoja autofocus>Listo</button></div>`);
  $('#docCopy').addEventListener('click', () => copiar(full, 'Texto de la constancia copiado.'));
}

// ───────────────────────── Consentimiento ─────────────────────────
function abrirConsent(v) {
  const c = v.consentimiento || {};
  abrirHoja(`<form id="fCon" novalidate><h2 class="hoja-t">${c.fecha ? 'Actualizar' : 'Registrar'} consentimiento · ${esc(v.dominio)}</h2>
    <p class="muted">${esc(v.deudor)}${v.operacion ? ' · Ayuda económica con garantía prendaria N° ' + esc(v.operacion) : ''}</p>
    <label class="fld" for="cFecha">Fecha de firma</label><input type="date" id="cFecha" value="${esc(c.fecha || hoy())}" max="${hoy()}">
    <label class="fld" for="cVer">Cláusula firmada</label><select id="cVer"><option value="v1.0"${(c.version || 'v1.0') === 'v1.0' ? ' selected' : ''}>Geolocalización del bien prendado, v1.0</option></select>
    <label class="fld" for="cArch">Documento (nombre del archivo, opcional)</label><input type="text" id="cArch" value="${esc(c.archivo || '')}" placeholder="Anexo firmado al contrato de prenda">
    <label class="chk" for="cInfo"><input type="checkbox" id="cInfo"${c.informado ? ' checked' : ''}><span>Se le informó para qué se usa la ubicación, quién la guarda y cómo ejercer sus derechos (art. 6, Ley 25.326).</span></label>
    <label class="chk" for="cCopia"><input type="checkbox" id="cCopia"${c.copia ? ' checked' : ''}><span>Recibió una copia firmada.</span></label>
    <p class="error" id="cErr" hidden></p>
    <div class="hoja-acc"><button type="button" class="btn" data-cerrar-hoja>Cancelar</button><button type="submit" class="btn primary">Guardar consentimiento</button></div></form>`);
  $('#fCon').addEventListener('submit', async (e) => {
    e.preventDefault(); const er = $('#cErr');
    const fecha = $('#cFecha').value;
    if (!fecha) { er.textContent = 'Falta la fecha de firma.'; er.hidden = false; return; }
    if (!$('#cInfo').checked || !$('#cCopia').checked) { er.textContent = 'Faltan marcar las dos casillas.'; er.hidden = false; return; }
    await conBoton(e.submitter, 'Guardando…', async () => {
      try {
        await cambiarVehiculo(v.id, { consentimiento: { fecha, version: $('#cVer').value, archivo: $('#cArch').value.trim(), informado: true, copia: true } });
        cerrarHoja(); toast('Consentimiento registrado.'); renderFicha(); if (S.vista === 'mapa') actualizarMapa();
      } catch (err) { er.textContent = mensaje(err); er.hidden = false; }
    });
  });
}

// ───────────────────────── Nuevo / editar vehículo ─────────────────────────
function abrirVehiculo(v) {
  const e0 = v || {};
  abrirHoja(`<form id="fVeh" novalidate><h2 class="hoja-t">${v ? 'Editar vehículo' : 'Nuevo vehículo'}</h2>
    <div class="grid2">
      <label class="fld">Dominio (patente)<input id="vDom" value="${esc(e0.dominio || '')}" autocapitalize="characters" autocomplete="off" required></label>
      <label class="fld">Situación<select id="vSit">${opciones(SITUACIONES.map((s) => [s, SIT_TXT[s]]), e0.situacion || 'al_dia')}</select></label>
      <label class="fld">Marca<input id="vMar" value="${esc(e0.marca || '')}"></label>
      <label class="fld">Modelo<input id="vMod" value="${esc(e0.modelo || '')}"></label>
      <label class="fld">Año<input id="vAnio" type="number" inputmode="numeric" value="${esc(e0.anio || '')}"></label>
      <label class="fld">N° de operación<input id="vOp" value="${esc(e0.operacion || '')}"></label>
      <label class="fld">Deudor<input id="vDeu" value="${esc(e0.deudor || '')}"></label>
      <label class="fld">DNI<input id="vDni" value="${esc(e0.dni || '')}"></label>
      <label class="fld">Teléfono<input id="vTel" value="${esc(e0.telefono || '')}"></label>
      <label class="fld">Expediente (opcional)<input id="vExp" value="${esc(e0.expte || '')}"></label>
      <label class="fld">IMEI del equipo<input id="vImei" value="${esc(e0.imei || '')}" inputmode="numeric" placeholder="14 a 17 dígitos"></label>
      <label class="fld">Instalado<input id="vInst" type="date" value="${esc(e0.instalado || '')}" max="${hoy()}"></label>
    </div>
    <p class="hint">El consentimiento del tomador se registra aparte, desde la ficha.</p>
    <p class="error" id="vErr" hidden></p>
    <div class="hoja-acc">${v ? `<button type="button" class="btn danger" data-borrar>Eliminar</button>` : ''}<span class="sep"></span>
      <button type="button" class="btn" data-cerrar-hoja>Cancelar</button><button type="submit" class="btn primary">${v ? 'Guardar cambios' : 'Agregar vehículo'}</button></div></form>`);
  if (v) $('#fVeh').querySelector('[data-borrar]').addEventListener('click', () => borrar(v));
  $('#fVeh').addEventListener('submit', async (e) => {
    e.preventDefault(); const er = $('#vErr');
    const dom = $('#vDom').value.trim().toUpperCase();
    if (!dom) { er.textContent = 'Falta el dominio (patente).'; er.hidden = false; return; }
    const imei = $('#vImei').value.replace(/\D/g, '');
    if (imei && (imei.length < 14 || imei.length > 17)) { er.textContent = 'El IMEI tiene entre 14 y 17 dígitos.'; er.hidden = false; return; }
    const campos = { dominio: dom, situacion: $('#vSit').value, marca: $('#vMar').value.trim(), modelo: $('#vMod').value.trim(),
      anio: $('#vAnio').value ? +$('#vAnio').value : null, operacion: $('#vOp').value.trim(), deudor: $('#vDeu').value.trim(),
      dni: $('#vDni').value.trim(), telefono: $('#vTel').value.trim(), expte: $('#vExp').value.trim(), imei, instalado: $('#vInst').value || null };
    await conBoton(e.submitter, 'Guardando…', async () => {
      try {
        if (v) { const r = await cambiarVehiculo(v.id, campos); if (r.conflicto) { er.textContent = 'El vehículo cambió desde otro lugar. Cerrá y volvé a abrir.'; er.hidden = false; return; } toast('Cambios guardados.'); renderFicha(); }
        else { const nv = await crearVehiculo(campos); toast('Vehículo agregado.'); abrir(nv.id); }
        cerrarHoja(); if (S.vista === 'mapa') actualizarMapa(); else render();
      } catch (err) { er.textContent = mensaje(err); er.hidden = false; }
    });
  });
}
function borrar(v) {
  abrirHoja(`<h2 class="hoja-t">Eliminar ${esc(v.dominio)}</h2>
    <p>Se quita el vehículo de la app. La bitácora de consultas que ya tenga se conserva. Esto se puede deshacer pidiéndoselo a Claude.</p>
    <div class="hoja-acc"><button type="button" class="btn" data-cerrar-hoja>Cancelar</button><button type="button" class="btn danger" id="bSi">Eliminar</button></div>`);
  $('#bSi').addEventListener('click', (e) => conBoton(e.target, 'Eliminando…', async () => {
    try { await borrarVehiculo(v.id); cerrarHoja(); cerrarFicha(); toast('Vehículo eliminado.'); if (S.vista === 'mapa') { S.vista = 'vehiculos'; } render(); }
    catch (err) { toast(mensaje(err)); }
  }));
}

// ───────────────────────── Ajustes ─────────────────────────
function abrirAjustes() {
  const a = ajustes();
  abrirHoja(`<form id="fAj" novalidate><h2 class="hoja-t">Ajustes</h2>
    <h3 class="hoja-h3">Ubicación exacta</h3>
    <div class="opts" role="radiogroup" aria-label="Ubicación exacta">
      <label class="opt" for="po1"><input type="radio" name="pol" id="po1" value="mora"${a.politica === 'mora' ? ' checked' : ''}><span><b>Solo créditos en mora o en ejecución</b><br><small>Los créditos al día se ven como zona aproximada; el punto exacto se ve indicando un motivo.</small></span></label>
      <label class="opt" for="po2"><input type="radio" name="pol" id="po2" value="siempre"${a.politica === 'siempre' ? ' checked' : ''}><span><b>Todos los créditos con consentimiento</b><br><small>Como «Encontrar» del iPhone: todos los vehículos con su punto exacto.</small></span></label>
    </div>
    <label class="fld" for="ajZona">Zona habitual (km)<input id="ajZona" type="number" inputmode="numeric" min="1" value="${esc(a.zona_km)}"></label>
    <p class="hint">Avisa cuando un vehículo se aleja más de esa distancia del centro de la zona.</p>
    <p class="error" id="ajErr" hidden></p>
    <div class="hoja-acc"><button type="button" class="btn" data-cerrar-hoja>Cancelar</button><button type="submit" class="btn primary">Guardar ajustes</button></div></form>`);
  $('#fAj').addEventListener('submit', async (e) => {
    e.preventDefault(); const er = $('#ajErr');
    const zona = +$('#ajZona').value; if (!(zona > 0)) { er.textContent = 'La zona tiene que ser mayor que cero.'; er.hidden = false; return; }
    const pol = $('#fAj').querySelector('input[name="pol"]:checked').value;
    await conBoton(e.submitter, 'Guardando…', async () => {
      try { const r = await guardarAjustes(a.rev, { politica: pol, zona_km: zona }); if (r.conflicto) { er.textContent = 'Los ajustes cambiaron desde otro lugar. Cerrá y volvé a abrir.'; er.hidden = false; return; } cerrarHoja(); toast('Ajustes guardados.'); if (S.vista === 'mapa') { mapaInst.setBase(ajustes()); actualizarMapa(); } else render(); }
      catch (err) { er.textContent = mensaje(err); er.hidden = false; }
    });
  });
}

// ───────────────────────── Hojas (modales), menú, copiar ─────────────────────────
let focoPrevio = null;
function abrirHoja(html) {
  const ov = $('#hoja'); if (ov.hidden) focoPrevio = document.activeElement;
  ov.querySelector('.hoja').innerHTML = html; ov.hidden = false;
  const f = ov.querySelector('[autofocus]') || ov.querySelector('input:checked') || ov.querySelector('input,select,textarea,button'); if (f) f.focus();
}
function cerrarHoja() { const ov = $('#hoja'); ov.hidden = true; ov.querySelector('.hoja').innerHTML = ''; if (focoPrevio && document.contains(focoPrevio)) focoPrevio.focus({ preventScroll: true }); }
$('#hoja').addEventListener('click', (e) => { if (e.target.id === 'hoja' || e.target.closest('[data-cerrar-hoja]')) cerrarHoja(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#hoja').hidden) cerrarHoja(); else if (S.sel && S.vista === 'mapa') { cerrarFicha(); actualizarMapa(); } else if (S.sel) { cerrarFicha(); render(); } } });

function copiar(texto, ok) {
  const fallback = () => { abrirHoja(`<h2 class="hoja-t">Copiar el texto</h2><p class="muted">Copialo con el menú o con Ctrl+C.</p><textarea class="cpy" id="cpy" rows="8" readonly>${esc(texto)}</textarea><div class="hoja-acc"><button type="button" class="btn primary" data-cerrar-hoja>Listo</button></div>`); const t = $('#cpy'); t.focus(); t.select(); };
  try { navigator.clipboard.writeText(texto).then(() => toast(ok), fallback); } catch { fallback(); }
}

function renderMenu() {
  const m = $('#menu'); if (!S.menu) { m.hidden = true; m.innerHTML = ''; return; }
  m.hidden = false;
  m.innerHTML = `<div class="menu-pane"><div class="menu-id">${esc(D.acceso?.nombre || '')}<small>${esc(D.usuario?.email || '')}</small></div>
    <button type="button" class="menu-it" data-m="ajustes">Ajustes</button>
    <button type="button" class="menu-it" data-m="clave">Cambiar contraseña</button>
    <a class="menu-it" href="${JUICIOS}" target="_blank" rel="noopener">Ir al gestor de juicios</a>
    <a class="menu-it" href="${COBRANZAS}" target="_blank" rel="noopener">Ir a cobranzas</a>
    <button type="button" class="menu-it danger" data-m="salir">Cerrar sesión</button>
    <p class="menu-v">Prenda v${VERSION}</p></div>`;
}
$('#menu').addEventListener('click', (e) => {
  if (e.target.id === 'menu') { S.menu = false; return renderMenu(); }
  const b = e.target.closest('[data-m]'); if (!b) return;
  S.menu = false; renderMenu();
  if (b.dataset.m === 'ajustes') abrirAjustes();
  else if (b.dataset.m === 'salir') salir().then(() => mostrar('ingreso'));
  else if (b.dataset.m === 'clave') abrirClave();
});
function abrirClave() {
  abrirHoja(`<form id="fCl" novalidate><h2 class="hoja-t">Cambiar contraseña</h2>
    <input type="email" autocomplete="username" value="${esc(D.usuario?.email || '')}" hidden>
    <label class="fld">Contraseña nueva<input id="clA" type="password" autocomplete="new-password"></label>
    <label class="fld">Repetila<input id="clB" type="password" autocomplete="new-password"></label>
    <p class="error" id="clErr" hidden></p>
    <div class="hoja-acc"><button type="button" class="btn" data-cerrar-hoja>Cancelar</button><button type="submit" class="btn primary">Guardar</button></div></form>`);
  $('#fCl').addEventListener('submit', async (e) => {
    e.preventDefault(); const er = $('#clErr'), a = $('#clA').value, b = $('#clB').value;
    if (a.length < CLAVE_MIN) { er.textContent = `La contraseña tiene que tener ${CLAVE_MIN} caracteres o más`; er.hidden = false; return; }
    if (a !== b) { er.textContent = 'Las dos contraseñas no coinciden'; er.hidden = false; return; }
    await conBoton(e.submitter, 'Guardando…', async () => { try { await cambiarClave(a); cerrarHoja(); toast('Contraseña cambiada.'); } catch (err) { er.textContent = mensaje(err); er.hidden = false; } });
  });
}

// ───────────────────────── Eventos del cascarón ─────────────────────────
document.querySelector('#vistas').addEventListener('click', (e) => {
  const b = e.target.closest('button[id^="v_"]'); if (!b) return;
  S.vista = b.id.slice(2); try { localStorage.setItem('pr.vista', S.vista); } catch { /* nada */ }
  cerrarFicha(); render();
});
$('#main').addEventListener('click', (e) => { const row = e.target.closest('.vrow, .arow'); if (row) abrir(row.dataset.id); });
$('#btnCuenta').addEventListener('click', () => { S.menu = !S.menu; renderMenu(); });
$('#btnNuevo').addEventListener('click', () => abrirVehiculo(null));
$('#fabNuevo').addEventListener('click', () => abrirVehiculo(null));
$('#btnAjustes').addEventListener('click', abrirAjustes);
$('#franja').addEventListener('click', (e) => { if (e.target.closest('[data-ing="reintentar"]')) reintentar(e.target.closest('button')); });

// ───────────────────────── Actualización dinámica ─────────────────────────
function refrescar() {
  document.querySelectorAll('[data-ago]').forEach((el) => { const v = veh(el.dataset.ago); const p = v && posDe(v); if (p) el.textContent = hace(p.momento); });
  document.querySelectorAll('[data-donde]').forEach((el) => { const v = veh(el.dataset.donde); const p = v && posDe(v); if (p) el.textContent = referencia(p.lat, p.lon) + (p.velocidad ? ' · ' + p.velocidad + ' km/h' : ''); });
  document.querySelectorAll('[data-coord]').forEach((el) => { const v = veh(el.dataset.coord); const p = v && posDe(v); if (p) el.textContent = p.lat.toFixed(5) + ', ' + p.lon.toFixed(5); });
  document.querySelectorAll('[data-gmaps]').forEach((el) => { const v = veh(el.dataset.gmaps); const p = v && posDe(v); if (p) el.href = `https://www.google.com/maps?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`; });
}
setInterval(() => {
  const haySim = D.vehiculos.some((v) => !v.traccar_id && v.sim && v.sim.modo === 'ruta' && v.consentimiento);
  if (!haySim || document.visibilityState !== 'visible') return;
  if (S.vista === 'mapa' && mapaInst) actualizarMapa();
  refrescar();
}, 8000);

// ───────────────────────── Íconos ─────────────────────────
const IC = {
  volver: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  ruta: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="2.2" fill="currentColor"/><circle cx="18" cy="6" r="2.2" fill="currentColor"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copiar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  candado: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  rayo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  alerta: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/></svg>',
};

// ───────────────────────── Arranque ─────────────────────────
alCambiar((que, detalle) => {
  if (que === 'sesion') { mostrar(detalle === 'listo' ? 'listo' : detalle === 'clave-temporal' ? 'clave-temporal' : detalle === 'sin-acceso' ? 'sin-acceso' : detalle === 'sin-red' ? 'sin-red' : 'ingreso'); return; }
  if (S.pantalla !== 'listo') return;
  if (que === 'datos') { if (S.sel) renderFicha(); if (S.vista === 'mapa') { subtitulo(resumenVehiculos()); actualizarMapa(); } else render(); }
  else { renderFranja(); subtitulo(S.vista === 'mapa' ? resumenVehiculos() : $('#sub').textContent.split(' · ')[0]); }
});
(async () => { try { mostrar(await iniciar()); } catch (err) { S.falla = mensaje(err, 'no se pudo abrir'); mostrar('error'); } })();

// Service worker: abre sin conexión y toma la última versión en la siguiente apertura.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin él */ });
