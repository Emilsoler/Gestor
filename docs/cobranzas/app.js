// Interfaz de cobranzas. Los datos y la red viven en datos.js; las cuentas, en calculo.js; los
// textos y mensajes, en textos.js; lo que se muestra de una consulta al BCRA, en creditos.js.
import {
  D, iniciar, reconectar, entrar, salir, cambiarClave, alCambiar, mensaje, ajustes, ESTADOS,
  crearDeudor, cambiarDeudor, borrarDeudor, crearModelo, guardarModelo, borrarModelo, guardarAjustes,
  consultarBCRA, detalleConsulta, detalleGuardado, borrarConsulta, consultarCheque, entidadesCheques, borrarConsultaCheque, probarArca,
} from './datos.js';
import {
  avisoCuit, soloDigitos, cuitTexto, fichaConsulta, filaConsulta, textoConsulta, deudoresDelCuit,
  avisoCheque, numeroCheque, bancosRecientes, opcionesBancos, bancoEnLista, fichaCheque, textoCheque, filaCheque,
} from './creditos.js';
import {
  liquidar, resumen, armarPlan, estadoPlan, planVigente, sumarMeses, totalPago, TRAMOS, tramoDe, CADAS, nombrePropio, detalleCuotas, ES_FECHA,
} from './calculo.js';
import {
  esc, hoy, fmt, fmtLargo, fmtDia, nombreMes, mesDe, mesMas, plata, compacto, porciento, cuantos, telefonos, TIPOS_OPERACION,
  vehiculoTexto, operacionTexto, CAMPOS_MENSAJE, planDetalle, contextoMensaje, completar, SITUACION_PLAN, frecuencia,
} from './textos.js';
import { ALIAS_ARCA, armarSolicitud } from './certificado.js';
import { importe, enCelda, idNuevo, r2 } from '../liquidacion.js';
import { xlsx } from '../excel.js';

const VERSION = '1.4.0';
const CLAVE_MIN = 10;
const TIPOS_GESTION = ['Llamada', 'WhatsApp', 'Visita', 'Email', 'Carta documento', 'Promesa de pago', 'Nota'];
const MEDIOS = ['Efectivo', 'Transferencia', 'Depósito', 'Cheque', 'Débito', 'Otro'];
const CONCEPTOS = ['Tasa de justicia', 'Aportes Caja de Abogados', 'Martillero', 'Gastos de secuestro', 'Carta documento', 'Honorarios abogado'];
const TABS = [['resumen', 'Resumen'], ['liquidacion', 'Liquidación'], ['pagos', 'Pagos'], ['plan', 'Plan'], ['gestiones', 'Gestiones'], ['mensaje', 'WhatsApp'], ['datos', 'Datos']];
const CLASE = { mora: 's-bad', plan: 's-ok', 'plan-atrasado': 's-warn', 'plan-caer': 's-bad', 'plan-cumplido': 's-ok', juicio: 's-violet', 'al-dia': 's-info' };
const CHIPS = [['activos', 'Activos'], ['mora', 'En mora'], ['plan', 'Con plan'], ['atrasados', 'Planes atrasados'], ['promesas', 'Promesas'], ['juicio', 'En juicio'], ['cerrados', 'Cancelados y archivados']];
const VISTAS = { inicio: 'Inicio', deudores: 'Deudores', planes: 'Planes', cobros: 'Cobros', creditos: 'Aprobación de créditos' };
const AYUDA_CUIT = 'La situación en cada banco o financiera, los últimos 24 meses y los cheques rechazados.';
const AYUDA_CHEQUE = 'Si el cheque fue denunciado como extraviado, robado o adulterado.';
const MODOS_CREDITO = [['cuit', 'Deudas por CUIT'], ['cheque', 'Cheques denunciados']];
const JUICIOS = '../'; // el gestor de juicios, en la misma base

const S = {
  pantalla: 'arranque', vista: 'inicio', q: '', chip: 'activos', tramo: '', orden: 'deuda', mes: mesDe(hoy()),
  abierto: null, tab: 'resumen', f: null, confirmar: '', // la ficha abierta y lo que se escribe en ella
  panel: '', nuevo: null, aj: null, modelos: {}, arca: null, // paneles: 'nuevo' | 'mensajes' | 'ajustes' | 'clave' | 'arca'
  menu: false, instalar: null, ocupado: false, maxi: false,
  // Aprobación de créditos: por CUIT (el que se escribe, la consulta que se está viendo y su estado) o
  // por cheque (ch…: el banco y el número que se escriben, la consulta abierta, la lista de bancos).
  cred: {
    modo: 'cuit', cuit: '', abierta: null, consultando: false, confirmar: false, error: '', errorDetalle: '', filtro: '',
    entidad: '', numero: '', chAbierta: null, chConsultando: false, chConfirmar: false, chError: '', chFiltro: '',
    bancos: null, bancosCargando: false, bancosError: '',
  },
};
try { S.vista = VISTAS[localStorage.getItem('cb.vista')] ? localStorage.getItem('cb.vista') : 'inicio'; } catch { /* sin almacenamiento */ }
try { if (localStorage.getItem('cb.credModo') === 'cheque') S.cred.modo = 'cheque'; } catch { /* sin almacenamiento */ }
try { S.maxi = localStorage.getItem('cb.maxi') === '1'; } catch { /* sin almacenamiento */ }

// ───────────────────────── Utilidades ─────────────────────────

const $ = (s) => document.querySelector(s);
const movil = window.matchMedia('(max-width: 720px)');
const deudor = (id) => D.deudores.find((x) => x.id === id);
const nombre = (d) => nombrePropio(d.nombre);
const suma = (xs, f = (x) => x) => r2(xs.reduce((a, x) => a + (+f(x) || 0), 0));
const ahora = () => new Date().toISOString(); // cuándo se anotó algo: ordena lo del mismo día
const porc = (s) => { const n = Number(String(s ?? '').replace(/[%\s]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const vacio = (titulo, texto) => `<div class="empty"><b>${esc(titulo)}</b>${esc(texto)}</div>`;
const pill = (texto, clase = '') => `<span class="pill ${clase}">${esc(texto)}</span>`;
const hora = (d) => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const cuando = (d) => (d.toDateString() === new Date().toDateString() ? 'hoy' : 'el ' + d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })) + ' a las ' + hora(d);
const opciones = (valores, actual) => valores.map((v) => { const [val, txt] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(val)}" ${String(val) === String(actual) ? 'selected' : ''}>${esc(txt)}</option>`; }).join('');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, Math.min(12000, Math.max(3200, msg.length * 55)));
}

async function conBoton(boton, textoOcupado, tarea) { // evita dobles envíos y muestra que está trabajando
  if (S.ocupado) return;
  S.ocupado = true;
  const antes = boton ? boton.textContent : '';
  if (boton) { boton.disabled = true; boton.textContent = textoOcupado; }
  try { await tarea(); } finally {
    S.ocupado = false;
    if (boton && boton.isConnected) { boton.disabled = false; boton.textContent = antes; }
  }
}

/** Lo que se escribe en los formularios vive en S (data-k="f.pago.monto"), así sobrevive a los redibujos. */
function poner(ruta, valor) {
  const ks = ruta.split('.'); let o = S;
  for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[ks[ks.length - 1]] = valor;
}
const valor = (ruta) => ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), S);
/** Atributos de un campo atado a S. */
const atar = (ruta, extra = '') => `data-k="${esc(ruta)}" value="${esc(valor(ruta) ?? '')}"${extra}`;

function guardarFoco(caja) {
  const a = document.activeElement;
  if (!a || !caja || !caja.contains(a) || !(a.dataset?.k || a.id)) return null;
  let sel = null; try { if (a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch { /* sin selección */ }
  return { k: a.dataset.k, id: a.id, sel };
}
function devolverFoco(f) {
  if (!f) return;
  const el = f.k ? document.querySelector(`[data-k="${CSS.escape(f.k)}"]`) : document.getElementById(f.id);
  if (!el || el === document.activeElement) return;
  el.focus({ preventScroll: true });
  if (f.sel) try { el.setSelectionRange(f.sel[0], f.sel[1]); } catch { /* tipos sin selección */ }
}
/** Las barras se dibujan sin estilos en línea (la política de seguridad no los deja): el ancho va después. */
function aplicarAnchos(caja) { caja.querySelectorAll('[data-ancho]').forEach((el) => { el.style.width = Math.max(0, Math.min(100, +el.dataset.ancho || 0)) + '%'; }); }

// Cada deudor se resume una vez por versión (y por día): la liquidación no se recalcula en cada dibujo.
const memo = new Map();
function res(d) {
  const aj = ajustes(), dia = hoy(), k = `${d.rev}|${dia}|${aj.rev}|${aj.gracia}|${aj.caducidad}`;
  const m = memo.get(d.id);
  if (m && m.k === k && m.d === d) return m.r;
  const r = resumen(d, dia, aj);
  memo.set(d.id, { k, d, r });
  return r;
}

/** Lo que hay que hacer con un deudor: próxima acción, promesa de pago y cuotas del plan. */
function pendientesDe(d, r) {
  const xs = [];
  if ((d.proxima || '').trim()) xs.push({ fecha: d.vence || '', texto: d.proxima, tipo: 'Acción', tab: 'gestiones' });
  if (r.prom && ['pendiente', 'incumplida'].includes(r.prom.estado)) {
    const monto = r.prom.monto ? ' ' + plata(r.prom.monto) : '';
    xs.push(r.prom.estado === 'incumplida'
      ? { fecha: r.prom.fecha, texto: `No cumplió la promesa de pagar${monto}`, tipo: 'Promesa', tarde: true, tab: 'gestiones' }
      : { fecha: r.prom.fecha, texto: `Prometió pagar${monto}`, tipo: 'Promesa', tab: 'gestiones' });
  }
  if (r.ep && r.ep.situacion !== 'cumplido') {
    if (r.ep.impagas) {
      const primera = r.ep.items.find((x) => x.atrasada);
      xs.push({ fecha: primera?.vto || '', texto: `${cuantos(r.ep.impagas, 'cuota atrasada', 'cuotas atrasadas')} del plan · ${plata(r.ep.atrasado)}`, tipo: 'Plan', tarde: true, tab: 'plan' });
    } else if (r.ep.proxima?.vto) {
      xs.push({ fecha: r.ep.proxima.vto, texto: `${r.ep.proxima.n === 0 ? 'Anticipo' : 'Cuota ' + r.ep.proxima.n} del plan · ${plata(r.ep.proxima.importe)}`, tipo: 'Plan', tab: 'plan' });
    }
  }
  return xs.sort((a, b) => (b.tarde ? 1 : 0) - (a.tarde ? 1 : 0) || (a.fecha || '9999').localeCompare(b.fecha || '9999'));
}
const dueClase = (x, dia) => (x.tarde || (x.fecha && x.fecha < dia) ? 'late' : x.fecha && x.fecha <= mesMasDias(dia, 2) ? 'soon' : '');
function mesMasDias(dia, n) { const d = new Date(dia + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

// ───────────────────────── Pantallas de ingreso ─────────────────────────

function mostrar(pantalla) {
  S.pantalla = pantalla;
  const enApp = pantalla === 'listo';
  $('#vArranque').hidden = true;
  $('#vApp').hidden = !enApp;
  $('#vIngreso').hidden = enApp;
  if (enApp) { $('#ingresoCuerpo').innerHTML = ''; render(); return; }
  cerrarFicha(); S.menu = false; renderMenu();
  for (const k of ['#main', '#chips', '#franja', '#nPlanes', '#nDeudores']) $(k).innerHTML = '';
  $('#sub').textContent = ''; $('#q').value = ''; S.q = '';
  renderIngreso();
}

function renderIngreso() {
  const c = $('#ingresoCuerpo'), email = esc(D.usuario?.email || '');
  const error = '<p class="error" id="i_error" role="alert" hidden></p>';
  if (S.pantalla === 'ingreso') {
    c.innerHTML = `<form id="fIngreso" novalidate>
      <label class="f">Email<input id="i_email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"></label>
      <label class="f">Contraseña<input id="i_clave" type="password" autocomplete="current-password"></label>
      ${error}
      <button class="btn primary" type="submit">Ingresar</button>
    </form>
    <p class="pie hint">Es el mismo usuario que el del gestor de juicios.</p>`;
    $('#i_email').focus();
  } else if (S.pantalla === 'clave-temporal') {
    c.innerHTML = `<div><b>Elegí tu contraseña</b>
      <p class="hint m0">La clave con la que entraste es temporal. Elegí una que solo vos conozcas, de ${CLAVE_MIN} caracteres o más.</p></div>
    <form id="fClave" novalidate>
      <input type="email" autocomplete="username" value="${email}" hidden>
      <label class="f">Contraseña nueva<input id="n_clave" type="password" autocomplete="new-password"></label>
      <label class="f">Repetila<input id="n_clave2" type="password" autocomplete="new-password"></label>
      ${error}
      <button class="btn primary" type="submit">Guardar contraseña</button>
    </form>
    <p class="pie hint">Ingresaste como ${email}. <button class="btn small" data-ing="salir">Cerrar sesión</button></p>`;
    $('#n_clave').focus();
  } else if (S.pantalla === 'sin-acceso') {
    c.innerHTML = `<div><b>Esta cuenta no está autorizada</b>
      <p class="hint m0">Ingresaste como ${email}, pero esa cuenta no tiene permiso para usar la app.</p></div>
    <div class="actions"><button class="btn" data-ing="reintentar">Volver a comprobar</button><button class="btn" data-ing="salir">Cerrar sesión</button></div>`;
  } else if (S.pantalla === 'sin-red') {
    c.innerHTML = `<div><b>No se pudo conectar con la base de datos</b>
      <p class="hint m0">Revisá tu conexión a internet. Si hace más de una semana que no se usa, la base puede estar en pausa: pedile a Claude que la reactive.</p></div>
    <div class="actions"><button class="btn primary" data-ing="reintentar">Reintentar</button></div>`;
  } else if (S.pantalla === 'en-marco') {
    c.innerHTML = `<div><b>La app no se abre dentro de otra página</b>
      <p class="hint m0">Por seguridad solo funciona en su propia pestaña o instalada.</p></div>
    <div class="actions"><a class="btn primary" href="./" target="_top" rel="noopener">Abrir cobranzas</a></div>`;
  } else if (S.pantalla === 'sin-configurar') {
    c.innerHTML = `<div><b>Falta conectar la app con su base de datos</b>
      <p class="hint m0">Todavía no se cargaron la dirección y la clave pública del proyecto en config.js.</p></div>`;
  } else {
    c.innerHTML = `<div><b>No se pudo abrir la app</b><p class="hint m0">${esc(S.falla || '')}</p></div>
    <div class="actions"><button class="btn primary" data-ing="reintentar">Reintentar</button></div>`;
  }
}
function errorIngreso(texto) { const e = $('#i_error'); if (e) { e.textContent = texto; e.hidden = !texto; } }
function claveValida(a, b) {
  if (a.length < CLAVE_MIN) return `La contraseña tiene que tener ${CLAVE_MIN} caracteres o más`;
  if (a !== b) return 'Las dos contraseñas no coinciden';
  return '';
}
async function reintentar(boton) {
  await conBoton(boton, 'Conectando…', async () => {
    try { mostrar(await reconectar()); } catch (err) { console.error(err); S.falla = mensaje(err, 'no se pudo abrir'); mostrar('error'); }
  });
}

// ───────────────────────── Armado general ─────────────────────────

function subtitulo(texto) {
  const partes = [esc(texto)];
  if (D.leido && D.enLinea) partes.push('actualizado ' + hora(D.leido));
  $('#sub').innerHTML = partes.join(' · ') + (D.enVivo && D.enLinea ? ' · <span class="vivo">en vivo</span>' : '');
}
function renderFranja() {
  let h = '';
  if (!D.enLinea) {
    const detalle = D.deCache && D.leido ? `Estás viendo lo guardado en este dispositivo ${cuando(D.leido)}. ` : '';
    h = `<div class="franja"><div><b>Sin conexión.</b> ${detalle}Para guardar cambios hace falta conexión.</div><button class="btn small" id="btnReintentar">Reintentar</button></div>`;
  }
  $('#franja').innerHTML = h;
}
function insignia(sel, n, clase, texto) {
  const b = $(sel); if (!b) return;
  b.hidden = !n; b.className = 'badge' + (clase ? ' ' + clase : '');
  b.innerHTML = n ? `${n}<span class="vh"> ${texto}</span>` : '';
}

function render() {
  if (S.pantalla !== 'listo') return;
  const main = $('#main'), foco = guardarFoco(main);
  for (const v of Object.keys(VISTAS)) $('#v_' + v).setAttribute('aria-pressed', S.vista === v);
  $('#tVista').textContent = VISTAS[S.vista];
  $('#btnCuenta').textContent = (D.acceso?.nombre || D.usuario?.email || '?').trim().charAt(0).toUpperCase();
  renderFranja();
  $('#toolbar').hidden = !['deudores', 'planes'].includes(S.vista);
  $('#fOrden').hidden = S.vista !== 'deudores';
  $('#chips').hidden = S.vista !== 'deudores';
  if (!D.cargado) {
    main.innerHTML = vacio('Cargando tus deudores…', 'Acá vas a ver la deuda, los cobros y lo que hay que hacer.');
    subtitulo('Cargando…'); return;
  }
  const todos = D.deudores.map((d) => ({ d, r: res(d) }));
  // Insignias: planes que piden atención (atrasados o para caer) y deudores con algo vencido para hacer.
  const atrasados = todos.filter((x) => ['plan-atrasado', 'plan-caer'].includes(x.r.clave)).length;
  insignia('#nPlanes', atrasados, 'urg', atrasados === 1 ? 'plan atrasado' : 'planes atrasados');
  const dia = hoy(), urgentes = todos.filter((x) => x.r.activo && pendientesDe(x.d, x.r).some((p) => p.tarde || (p.fecha && p.fecha <= dia))).length;
  insignia('#nDeudores', urgentes, 'pend', urgentes === 1 ? 'deudor con algo para hoy o atrasado' : 'deudores con algo para hoy o atrasado');
  main.innerHTML = { inicio: vistaInicio, deudores: vistaDeudores, planes: vistaPlanes, cobros: vistaCobros, creditos: vistaCreditos }[S.vista](todos);
  aplicarAnchos(main);
  $('#fabNuevo').hidden = S.vista === 'creditos'; // en el celular taparía el resultado, y ahí no hace falta
  // Los 24 meses se ven desde el más reciente: si no entran (celular), el corrimiento arranca a la derecha.
  main.querySelectorAll('.historia-caja').forEach((el) => { el.scrollLeft = el.scrollWidth; });
  devolverFoco(foco);
}

// ───────────────────────── Inicio: el tablero ─────────────────────────

function vistaInicio(todos) {
  const dia = hoy();
  subtitulo(`Al ${fmtLargo(dia)}`);
  if (!todos.length) return vacio('Todavía no hay deudores cargados', 'Usá “+ Nuevo deudor” para cargar el primero, o pedile a Claude que importe el listado de la Mutual.');
  const activos = todos.filter((x) => x.r.activo);
  const deuda = suma(activos, (x) => x.r.saldo);
  const mes = mesDe(dia), mesAnt = mesMas(mes, -1);
  const pagos = todos.flatMap(({ d }) => d.pagos.map((p) => ({ d, p, total: totalPago(p) })));
  const delMes = pagos.filter((x) => mesDe(x.p.fecha) === mes), cobrado = suma(delMes, (x) => x.total), anterior = suma(pagos.filter((x) => mesDe(x.p.fecha) === mesAnt), (x) => x.total);
  const enMora = activos.filter((x) => !x.r.plan && x.r.liq.vencidas > 0);
  const conPlan = activos.filter((x) => x.r.plan), planesAtras = conPlan.filter((x) => ['plan-atrasado', 'plan-caer'].includes(x.r.clave)).length;
  const promHoy = activos.filter((x) => x.r.prom?.estado === 'pendiente' && x.r.prom.hoy).length;
  const promMal = activos.filter((x) => x.r.prom?.estado === 'incumplida').length;

  let delta = `<span class="kpi-s">${cuantos(delMes.length, 'pago', 'pagos')}</span>`;
  if (anterior > 0) {
    const v = Math.round((cobrado - anterior) / anterior * 100);
    delta = `<span class="kpi-s ${v >= 0 ? 'sube' : 'baja'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}% <span class="hint">vs ${esc(nombreMes(mesAnt).split(' ')[0])}</span></span>`;
  }
  const kpis = [
    { ir: 'deudores:activos', l: 'Deuda en gestión', v: compacto(deuda), s: `<span class="kpi-s">${cuantos(activos.length, 'deudor activo', 'deudores activos')}</span>`, i: 'balanza' },
    { ir: 'cobros:', l: `Cobrado en ${nombreMes(mes).split(' ')[0]}`, v: compacto(cobrado), s: delta, i: 'billete' },
    { ir: 'deudores:mora', l: 'En mora, sin plan', v: String(enMora.length), s: `<span class="kpi-s">${compacto(suma(enMora, (x) => x.r.saldo))}</span>`, i: 'alarma' },
    { ir: 'planes:', l: 'Planes vigentes', v: String(conPlan.length), s: `<span class="kpi-s ${planesAtras ? 'baja' : ''}">${planesAtras ? cuantos(planesAtras, 'atrasado', 'atrasados') : 'todos al día'}</span>`, i: 'cuotas' },
    { ir: 'deudores:promesas', l: 'Promesas para hoy', v: String(promHoy), s: `<span class="kpi-s ${promMal ? 'baja' : ''}">${promMal ? cuantos(promMal, 'incumplida', 'incumplidas') : 'ninguna incumplida'}</span>`, i: 'apreton' },
  ];
  const tiles = `<section class="kpis" aria-label="Resumen">${kpis.map((k) => `<button class="kpi" data-ir="${k.ir}" data-i="${k.i}"><span class="kpi-l">${esc(k.l)}</span><b class="kpi-v">${esc(k.v)}</b>${k.s}</button>`).join('')}</section>`;

  // Mora por antigüedad: deudores sin plan con cuotas vencidas, por los días de la cuota más vieja.
  const filas = TRAMOS.map((t) => { const xs = enMora.filter((x) => tramoDe(x.r.liq.dias_mora).id === t.id); return { t, n: xs.length, monto: suma(xs, (x) => x.r.saldo) }; });
  const max = Math.max(1, ...filas.map((f) => f.monto));
  const mora = `<section class="card">
    <div class="card-cab"><h3>Mora por antigüedad</h3><span class="hint">${cuantos(enMora.length, 'deudor', 'deudores')} · ${compacto(suma(enMora, (x) => x.r.saldo))}</span></div>
    <div class="tramos">${filas.map((f) => `<button class="tramo" data-tramo="${f.t.id}" ${f.n ? '' : 'disabled'} aria-label="${esc(f.t.nombre)}: ${cuantos(f.n, 'deudor', 'deudores')}, ${esc(plata(f.monto))}" title="${esc(f.t.nombre)}: ${cuantos(f.n, 'deudor', 'deudores')} · ${esc(plata(f.monto))}">
      <span class="tramo-n">${esc(f.t.nombre)}</span><span class="tramo-b"><i data-ancho="${(f.monto / max * 100).toFixed(1)}"></i></span><span class="tramo-v">${f.n ? esc(compacto(f.monto)) : '—'}</span><span class="tramo-c">${f.n || ''}</span></button>`).join('')}</div>
  </section>`;

  // Para hacer: lo atrasado, lo de hoy y lo de los próximos siete días.
  const limite = mesMasDias(dia, 7);
  const items = activos.flatMap(({ d, r }) => pendientesDe(d, r).map((x) => ({ ...x, d })))
    .filter((x) => x.tarde || !x.fecha || x.fecha <= limite);
  const grupo = (x) => (x.tarde || (x.fecha && x.fecha < dia) ? 'Atrasado' : x.fecha === dia ? 'Hoy' : x.fecha ? 'Próximos días' : 'Sin fecha');
  const grupos = ['Atrasado', 'Hoy', 'Próximos días', 'Sin fecha'].map((g) => [g, items.filter((x) => grupo(x) === g).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''))]).filter(([, xs]) => xs.length);
  const hacer = `<section class="card">
    <div class="card-cab"><h3>Para hacer</h3><span class="hint">${cuantos(items.length, 'pendiente', 'pendientes')}</span></div>
    ${grupos.length ? grupos.map(([g, xs]) => `<div class="pgrupo ${g === 'Atrasado' ? 'tarde' : ''}"><h4>${esc(g)}</h4>${xs.map((x) => `<button class="pitem" data-abrir="${esc(x.d.id)}" data-tab="${x.tab}">
        <span class="pitem-t"><b>${esc(nombre(x.d))}</b><span>${esc(x.texto)}</span></span>
        <span class="pitem-f"><span class="tag">${esc(x.tipo)}</span>${x.fecha ? `<span class="due ${dueClase(x, dia)}">${esc(x.fecha === dia ? 'hoy' : fmtDia(x.fecha))}</span>` : ''}</span></button>`).join('')}</div>`).join('')
      : '<p class="hint m0">Nada atrasado ni para los próximos días. Las próximas acciones, promesas de pago y cuotas de planes aparecen acá.</p>'}
  </section>`;

  const ultimos = pagos.filter((x) => ES_FECHA.test(x.p.fecha || '')).sort((a, b) => b.p.fecha.localeCompare(a.p.fecha)).slice(0, 6);
  const cobros = `<section class="card">
    <div class="card-cab"><h3>Últimos cobros</h3><button class="btn small" data-ir="cobros:">Ver cobros</button></div>
    ${ultimos.length ? `<div class="mini">${ultimos.map((x) => `<button class="mini-f" data-abrir="${esc(x.d.id)}" data-tab="pagos"><span class="mono">${fmt(x.p.fecha)}</span><span class="mini-n">${esc(nombre(x.d))}</span><b class="mono">${esc(plata(x.total))}</b></button>`).join('')}</div>`
      : '<p class="hint m0">Todavía no registraste cobros. Se cargan desde la ficha de cada deudor, en “Pagos”.</p>'}
  </section>`;
  return `${tiles}<div class="tablero">${mora}${hacer}${cobros}</div>`;
}

// ───────────────────────── Deudores ─────────────────────────

function enChip(x, chip) {
  const { r } = x;
  if (chip === 'cerrados') return !r.activo;
  if (!r.activo) return false;
  if (chip === 'mora') return !r.plan && r.liq.vencidas > 0;
  if (chip === 'plan') return !!r.plan;
  if (chip === 'atrasados') return ['plan-atrasado', 'plan-caer'].includes(r.clave);
  if (chip === 'promesas') return !!r.prom && ['pendiente', 'incumplida'].includes(r.prom.estado);
  if (chip === 'juicio') return x.d.estado === 'En juicio';
  return true;
}
function busca(d, q) {
  if (!q) return true;
  const op = d.operaciones.map((o) => [o.numero, o.vehiculo?.dominio, o.vehiculo?.marca, o.vehiculo?.modelo].join(' ')).join(' ');
  return [d.nombre, d.trato, d.dni, d.socio, d.domicilio, d.notas, d.expte, op, ...d.telefonos.map((t) => t.numero)].join(' ').toLowerCase().includes(q);
}
const proximo = (x) => pendientesDe(x.d, x.r)[0] || null;
/** El último pago: el más reciente entre los registrados acá y el que traía el listado de la Mutual. */
function ultimoPago(d, r) {
  const app = r.ultimo?.fecha || '', mutual = d.operaciones.map((o) => o.ultimo_pago).filter((x) => ES_FECHA.test(x || '')).sort().pop() || '';
  if (!app && !mutual) return null;
  return { fecha: app >= mutual ? app : mutual };
}

function filtrados(todos) {
  const q = S.q.trim().toLowerCase();
  const xs = todos.filter((x) => enChip(x, S.chip) && busca(x.d, q) && (!S.tramo || (!x.r.plan && x.r.liq.vencidas > 0 && tramoDe(x.r.liq.dias_mora).id === S.tramo)));
  const por = {
    deuda: (a, b) => b.r.saldo - a.r.saldo,
    mora: (a, b) => b.r.liq.dias_mora - a.r.liq.dias_mora || b.r.saldo - a.r.saldo,
    nombre: (a, b) => a.d.nombre.localeCompare(b.d.nombre, 'es'),
    pago: (a, b) => (ultimoPago(a.d, a.r)?.fecha || '0').localeCompare(ultimoPago(b.d, b.r)?.fecha || '0'),
    proximo: (a, b) => { const pa = proximo(a), pb = proximo(b); return (pa ? (pa.tarde ? '0' : pa.fecha || '9') : 'z').localeCompare(pb ? (pb.tarde ? '0' : pb.fecha || '9') : 'z'); },
  }[S.orden] || (() => 0);
  return xs.sort((a, b) => por(a, b) || a.d.nombre.localeCompare(b.d.nombre, 'es'));
}

function vistaDeudores(todos) {
  const q = S.q.trim().toLowerCase();
  $('#chips').innerHTML = CHIPS.map(([k, l]) => `<button class="chip" data-chip="${k}" aria-pressed="${S.chip === k}">${esc(l)} · ${todos.filter((x) => enChip(x, k) && busca(x.d, q)).length}</button>`).join('')
    + (S.tramo ? `<button class="chip quitar" data-tramo-x="1" aria-label="Quitar el filtro de antigüedad">Mora: ${esc(TRAMOS.find((t) => t.id === S.tramo)?.nombre.toLowerCase() || '')} ×</button>` : '');
  $('#fOrden').value = S.orden;
  const xs = filtrados(todos);
  subtitulo(`${xs.length} de ${cuantos(todos.length, 'deudor', 'deudores')}`);
  if (!todos.length) return vacio('Todavía no hay deudores cargados', 'Usá “+ Nuevo deudor” para cargar el primero.');
  if (!xs.length) return vacio('Ningún deudor coincide', 'Probá con otra búsqueda o con otro filtro.');
  const dia = hoy();
  const sit = (r) => pill(r.texto, CLASE[r.clave] || '');
  const venc = (r) => (r.liq.vencidas ? `<span>${cuantos(r.liq.vencidas, 'cuota', 'cuotas')}</span><small>${esc(detalleCuotas(r.liq).replace(/^las? /, ''))}</small>` : '<span class="hint">—</span>');
  const ult = (d, r) => { const u = ultimoPago(d, r); return u ? `<span class="mono">${fmt(u.fecha)}</span>` : '<span class="hint">—</span>'; };
  const prox = (x) => { const p = proximo(x); return p ? `<span class="next">${esc(p.texto)}</span>${p.fecha ? `<small class="due ${dueClase(p, dia)}">${esc(p.fecha === dia ? 'hoy' : fmt(p.fecha))}</small>` : ''}` : '<span class="hint">—</span>'; };
  if (movil.matches) {
    return `<div class="filas">${xs.map((x) => { const { d, r } = x; return `<article class="fila" data-abrir="${esc(d.id)}" tabindex="0" role="button" aria-label="Abrir la ficha de ${esc(nombre(d))}">
      <div class="fila-top"><b>${esc(nombre(d))}</b><b class="mono monto">${esc(plata(r.saldo))}</b></div>
      <div class="fila-sub">${sit(r)}${d.socio ? `<span class="mono">Socio ${esc(d.socio)}</span>` : ''}</div>
      ${r.liq.vencidas ? `<div class="hint">${esc(detalleCuotas(r.liq))}</div>` : ''}
      ${proximo(x) ? `<div class="fila-prox">${prox(x)}</div>` : ''}</article>`; }).join('')}</div>`;
  }
  return `<div class="tablebox"><table class="lista"><thead><tr><th>Deudor</th><th>Situación</th><th>Cuotas vencidas</th><th class="num">Deuda</th><th>Último pago</th><th>Próximo</th></tr></thead><tbody>
    ${xs.map((x) => { const { d, r } = x; return `<tr data-abrir="${esc(d.id)}" tabindex="0">
      <td class="car"><b>${esc(nombre(d))}</b><small>${esc([d.socio ? 'Socio ' + d.socio : '', operacionCorta(d)].filter(Boolean).join(' · '))}</small></td>
      <td>${sit(r)}</td><td class="venc">${venc(r)}</td>
      <td class="num"><b class="mono">${esc(plata(r.saldo))}</b>${r.plan ? '<small>saldo del plan</small>' : ''}</td>
      <td class="ult">${ult(d, r)}</td><td class="prox">${prox(x)}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}
function operacionCorta(d) {
  const op = d.operaciones[0]; if (!op) return '';
  const v = op.vehiculo || {};
  return [op.numero ? 'Op. ' + op.numero : '', [v.marca, v.dominio].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

// ───────────────────────── Planes ─────────────────────────

function vistaPlanes(todos) {
  const q = S.q.trim().toLowerCase();
  const conPlan = todos.filter((x) => x.r.plan && busca(x.d, q));
  const orden = { 'para-caer': 0, atrasado: 1, cumplido: 2, 'al-dia': 3 };
  conPlan.sort((a, b) => (orden[a.r.ep.situacion] ?? 9) - (orden[b.r.ep.situacion] ?? 9) || (a.r.ep.proxima?.vto || '9').localeCompare(b.r.ep.proxima?.vto || '9'));
  const cerrados = todos.flatMap(({ d }) => d.planes.filter((p) => p.estado !== 'vigente').map((p) => ({ d, p, ep: estadoPlan(p, d.pagos, hoy()) }))).filter((x) => busca(x.d, q))
    .sort((a, b) => (b.p.cierre?.fecha || b.p.fecha || '').localeCompare(a.p.cierre?.fecha || a.p.fecha || ''));
  subtitulo(`${cuantos(conPlan.length, 'plan vigente', 'planes vigentes')}`);
  const dia = hoy();
  const tarjeta = ({ d, r }) => {
    const ep = r.ep, [txt, cls] = SITUACION_PLAN[ep.situacion] || [ep.situacion, ''];
    const pct = ep.total ? ep.pagado / ep.total * 100 : 0;
    const prox = ep.proxima ? `${ep.proxima.n === 0 ? 'Anticipo' : `Cuota ${ep.proxima.n} de ${r.plan.cuotas.length}`} · ${plata(ep.proxima.importe)}` : 'Todo pagado';
    return `<article class="plan-card">
      <div class="fila-top"><button class="enlace" data-abrir="${esc(d.id)}" data-tab="plan"><b>${esc(nombre(d))}</b></button>${pill(ep.situacion === 'atrasado' ? `${txt} · ${cuantos(ep.impagas, 'cuota', 'cuotas')}` : txt, cls)}</div>
      <div class="hint">${esc(planDetalle(r.plan))}</div>
      <div class="progreso"><span class="barra"><i data-ancho="${pct.toFixed(1)}"></i></span><span class="mono">${esc(plata(ep.pagado))} de ${esc(plata(ep.total))}</span></div>
      <div class="plan-prox"><span>${esc(prox)}</span>${ep.proxima?.vto ? `<span class="due ${ep.impagas ? 'late' : ep.proxima.vto <= dia ? 'soon' : ''}">vence ${esc(ep.proxima.vto === dia ? 'hoy' : fmt(ep.proxima.vto))}</span>` : ''}</div>
      <div class="actions"><button class="btn small primary" data-abrir="${esc(d.id)}" data-tab="pagos" data-con="pago-plan">Registrar pago</button><button class="btn small" data-abrir="${esc(d.id)}" data-tab="mensaje" data-con="${ep.impagas ? 'atraso' : 'recordatorio'}">${ep.impagas ? 'Avisar atraso' : 'Recordar cuota'}</button></div>
    </article>`;
  };
  return `${conPlan.length ? `<div class="planes">${conPlan.map(tarjeta).join('')}</div>` : vacio('No hay planes vigentes', 'Los planes de pago se arman desde la ficha de cada deudor, en “Plan”.')}
    ${cerrados.length ? `<section class="card cerrados"><div class="card-cab"><h3>Planes cerrados</h3><span class="hint">${cerrados.length}</span></div>
      <div class="mini">${cerrados.map(({ d, p, ep }) => `<button class="mini-f" data-abrir="${esc(d.id)}" data-tab="plan"><span class="mono">${fmt(p.cierre?.fecha || p.fecha)}</span><span class="mini-n">${esc(nombre(d))} · ${esc((SITUACION_PLAN[p.estado] || [p.estado])[0])}</span><span class="mono">${esc(plata(ep.pagado))} de ${esc(plata(ep.total))}</span></button>`).join('')}</div></section>` : ''}`;
}

// ───────────────────────── Cobros ─────────────────────────

/** Los pagos de un mes, con lo imputado a cada grupo de rubros (los gastos y honorarios fijos van por su tipo). */
function cobrosDelMes(mes) {
  return D.deudores.flatMap((d) => d.pagos.filter((p) => mesDe(p.fecha) === mes).map((p) => {
    const g = { capital: 0, intereses: 0, honorarios: 0, gastos: 0 };
    for (const [k, v] of Object.entries(p.imp || {})) {
      if (k in g && k !== 'gastos') g[k] += +v || 0;
      else { const gasto = d.gastos.find((x) => x.id === k); g[gasto?.tipo === 'honorarios' ? 'honorarios' : 'gastos'] += +v || 0; }
    }
    return { d, p, ...g, total: totalPago(p) };
  })).sort((a, b) => a.p.fecha.localeCompare(b.p.fecha) || nombre(a.d).localeCompare(nombre(b.d), 'es'));
}

function vistaCobros() {
  const xs = cobrosDelMes(S.mes), tot = (k) => suma(xs, (x) => x[k]);
  subtitulo(`${cuantos(xs.length, 'pago', 'pagos')} en ${nombreMes(S.mes)}`);
  const esteMes = S.mes >= mesDe(hoy());
  const cab = `<div class="mes-nav"><button class="btn small" data-mes="-1" aria-label="Mes anterior">‹</button><b>${esc(nombreMes(S.mes))}</b><button class="btn small" data-mes="1" aria-label="Mes siguiente" ${esteMes ? 'disabled' : ''}>›</button>
    <span class="sep"></span>${xs.length ? '<button class="btn small" data-a="excel-cobros">Descargar en Excel</button>' : ''}</div>`;
  const cifras = `<dl class="cifras grandes"><div><dt>Total cobrado</dt><dd>${esc(plata(tot('total')))}</dd></div><div><dt>Capital</dt><dd>${esc(plata(tot('capital')))}</dd></div><div><dt>Intereses</dt><dd>${esc(plata(tot('intereses')))}</dd></div><div><dt>Honorarios</dt><dd>${esc(plata(tot('honorarios')))}</dd></div><div><dt>Gastos</dt><dd>${esc(plata(tot('gastos')))}</dd></div></dl>`;
  if (!xs.length) return `${cab}${vacio(`No hay cobros en ${nombreMes(S.mes)}`, 'Los pagos se registran desde la ficha de cada deudor, en “Pagos”.')}`;
  const fila = (x) => `<tr data-abrir="${esc(x.d.id)}" data-tab="pagos" tabindex="0"><td class="mono">${fmt(x.p.fecha)}</td><td class="car"><b>${esc(nombre(x.d))}</b><small>${esc([x.p.recibo ? 'Recibo ' + x.p.recibo : '', x.p.medio].filter(Boolean).join(' · '))}</small></td>
    ${['capital', 'intereses', 'honorarios', 'gastos', 'total'].map((k) => `<td class="num mono${k === 'total' ? ' fuerte' : ''}">${x[k] ? esc(plata(x[k])) : '<span class="hint">—</span>'}</td>`).join('')}</tr>`;
  return `${cab}<section class="sec">${cifras}</section>
    <div class="tablebox"><table class="lista cobros"><thead><tr><th>Fecha</th><th>Deudor</th><th class="num">Capital</th><th class="num">Intereses</th><th class="num">Honorarios</th><th class="num">Gastos</th><th class="num">Total</th></tr></thead>
    <tbody>${xs.map(fila).join('')}</tbody>
    <tfoot><tr><td></td><td>Total</td>${['capital', 'intereses', 'honorarios', 'gastos', 'total'].map((k) => `<td class="num mono">${esc(plata(tot(k)))}</td>`).join('')}</tr></tfoot></table></div>`;
}

// ───────────────────────── Aprobación de créditos ─────────────────────────
// Dos consultas al BCRA, cada una en su pestaña: por CUIT (la función `bcra` pregunta a la Central de
// Deudores, arma el semáforo y guarda la consulta) y por cheque (si fue denunciado como extraviado, robado
// o adulterado). Las anteriores quedan en el historial de cada una, como constancia de ese día.

function vistaCreditos() {
  const modos = `<nav class="tabs cr-modos" role="tablist" aria-label="Qué consultar">${MODOS_CREDITO.map(([k, l]) => `<button role="tab" data-cr-modo="${k}" aria-selected="${S.cred.modo === k}">${esc(l)}</button>`).join('')}</nav>`;
  return `<div class="creditos">${modos}${S.cred.modo === 'cheque' ? vistaCheques() : vistaCuit()}</div>`;
}

function cambiarModo(m) {
  if (S.cred.modo === m) return;
  S.cred.modo = m;
  try { localStorage.setItem('cb.credModo', m); } catch { /* sin almacenamiento */ }
  render();
}

function vistaCuit() {
  const C = S.cred, xs = D.consultas_bcra;
  subtitulo(xs.length ? cuantos(xs.length, 'consulta guardada', 'consultas guardadas') : 'Consulta en la Central de Deudores del BCRA');
  if (!D.creditos) return vacio('Falta activar la aprobación de créditos', 'La base todavía no tiene dónde guardar las consultas al BCRA. Pedile a Claude que la active.');
  const aviso = avisoCuit(C.cuit);
  const form = `<section class="card cr-consulta">
    <div class="card-cab"><h3>Consultar en el BCRA</h3></div>
    <form id="fCredito" class="cr-form" novalidate>
      <label class="f">CUIT o CUIL<input id="cr_cuit" ${atar('cred.cuit')} inputmode="numeric" autocomplete="off" placeholder="Ej.: 20-12345678-6" maxlength="20"></label>
      <button class="btn primary" type="submit" id="cr_ir" ${C.consultando || !aviso.ok ? 'disabled' : ''}>${C.consultando ? 'Consultando…' : 'Consultar BCRA'}</button>
    </form>
    <p class="hint m0${aviso.mal ? ' malo' : ''}" id="cr_aviso" aria-live="polite">${esc(aviso.texto || AYUDA_CUIT)}</p>
    ${C.error ? `<p class="aviso-chico" role="alert">${esc(C.error)}</p>` : ''}
  </section>`;

  const c = C.abierta ? xs.find((x) => x.id === C.abierta) : null;
  const resultado = c
    ? `<section class="card cr-resultado" id="crResultado">${fichaConsulta(c, detalleGuardado(c.id), { deudores: deudoresDelCuit(D.deudores, c.cuit), confirmar: C.confirmar, error: C.errorDetalle })}</section>`
    : `<section class="card cr-resultado cr-vacio"><b>Elegí una consulta o hacé una nueva</b><span class="hint">Vas a ver el semáforo, la situación de la persona en cada entidad, los últimos 24 meses y los cheques rechazados.</span></section>`;

  const q = C.filtro.trim().toLowerCase(), qd = soloDigitos(C.filtro);
  const vistas = xs.filter((x) => !q || (x.denominacion || '').toLowerCase().includes(q) || (qd.length >= 3 && x.cuit.includes(qd)));
  const historial = `<section class="card cr-historial">
    <div class="card-cab"><h3>Consultas anteriores</h3>${xs.length ? `<span class="hint">${xs.length}</span>` : ''}</div>
    ${xs.length > 6 ? `<input type="search" class="cr-filtro" ${atar('cred.filtro')} placeholder="Buscar por nombre o CUIT" aria-label="Buscar entre las consultas anteriores">` : ''}
    ${vistas.length ? `<div class="cr-lista">${vistas.slice(0, 200).map((x) => filaConsulta(x, x.id === C.abierta)).join('')}</div>`
      : `<p class="hint m0">${xs.length ? 'Ninguna consulta coincide.' : 'Las consultas que hagas quedan acá, con la fecha y lo que informaba el BCRA ese día.'}</p>`}
  </section>`;
  return `${form}${resultado}${historial}`;
}

function vistaCheques() {
  const C = S.cred, xs = D.consultas_cheques;
  subtitulo(xs.length ? cuantos(xs.length, 'cheque consultado', 'cheques consultados') : 'Consulta en la Central de Cheques Denunciados del BCRA');
  if (!D.denunciados) return vacio('Falta activar la consulta de cheques', 'La base todavía no tiene dónde guardar las consultas de cheques. Pedile a Claude que la active.');
  if (!C.bancos && !C.bancosCargando && !C.bancosError) setTimeout(pedirBancos, 0);
  // Los bancos usados hace poco salen del historial: se pueden elegir aunque la lista del BCRA no llegue.
  const recientes = bancosRecientes(xs), todos = C.bancos || [];
  if (C.entidad && !C.bancosCargando && !bancoEnLista(todos, recientes, C.entidad)) C.entidad = '';
  const sinBancos = !todos.length && !recientes.length;
  const aviso = avisoCheque(C.numero), listo = aviso.ok && !!C.entidad;
  const form = `<section class="card cr-consulta">
    <div class="card-cab"><h3>Consultar un cheque</h3></div>
    <form id="fCheque" class="cr-form cr-form-cheque" novalidate>
      <label class="f banco">Banco del cheque<select id="ch_banco" data-k="cred.entidad" ${sinBancos ? 'disabled' : ''}>${sinBancos
        ? `<option value="">${C.bancosError ? 'No se pudo traer la lista' : 'Cargando bancos…'}</option>` : opcionesBancos(todos, recientes, C.entidad)}</select></label>
      <label class="f">Número de cheque<input id="ch_numero" ${atar('cred.numero')} inputmode="numeric" autocomplete="off" placeholder="Ej.: 12345678" maxlength="24"></label>
      <button class="btn primary" type="submit" id="ch_ir" ${C.chConsultando || !listo ? 'disabled' : ''}>${C.chConsultando ? 'Consultando…' : 'Consultar cheque'}</button>
    </form>
    <p class="hint m0${aviso.mal ? ' malo' : ''}" id="ch_aviso" aria-live="polite">${esc(aviso.texto || AYUDA_CHEQUE)}</p>
    ${C.bancosError ? `<div class="aviso-chico cr-reintentar"><span>${esc(C.bancosError)}</span><button class="btn small" type="button" data-a="ch-bancos">Reintentar</button></div>` : ''}
    ${C.chError ? `<p class="aviso-chico" role="alert">${esc(C.chError)}</p>` : ''}
  </section>`;

  const c = C.chAbierta ? xs.find((x) => x.id === C.chAbierta) : null;
  const resultado = c
    ? `<section class="card cr-resultado" id="crResultado">${fichaCheque(c, { confirmar: C.chConfirmar })}</section>`
    : `<section class="card cr-resultado cr-vacio"><b>Elegí una consulta o hacé una nueva</b><span class="hint">Vas a ver si el cheque figura como extraviado, robado o adulterado y, si figura, quién hizo la denuncia.</span></section>`;

  const q = C.chFiltro.trim().toLowerCase(), qd = soloDigitos(C.chFiltro);
  const vistas = xs.filter((x) => !q || (x.entidad_nombre || '').toLowerCase().includes(q) || (qd.length >= 3 && x.numero.includes(qd)));
  const historial = `<section class="card cr-historial">
    <div class="card-cab"><h3>Cheques consultados</h3>${xs.length ? `<span class="hint">${xs.length}</span>` : ''}</div>
    ${xs.length > 6 ? `<input type="search" class="cr-filtro" ${atar('cred.chFiltro')} placeholder="Buscar por número o banco" aria-label="Buscar entre los cheques consultados">` : ''}
    ${vistas.length ? `<div class="cr-lista">${vistas.slice(0, 200).map((x) => filaCheque(x, x.id === C.chAbierta)).join('')}</div>`
      : `<p class="hint m0">${xs.length ? 'Ningún cheque coincide.' : 'Los cheques que consultes quedan acá, con la fecha y lo que informaba el BCRA ese día.'}</p>`}
  </section>`;
  return `${form}${resultado}${historial}`;
}

/** La lista de bancos del BCRA para elegir el del cheque (queda guardada unos días: ver datos.js). */
function pedirBancos() {
  const C = S.cred;
  if (C.bancos || C.bancosCargando) return;
  C.bancosCargando = true; C.bancosError = '';
  entidadesCheques()
    .then((l) => { C.bancos = l; })
    .catch((e) => {
      C.bancosError = e.sinRed ? 'Sin conexión: no se pudo traer la lista de bancos.' : e.sinSesion ? mensaje(e) : `No se pudo traer la lista de bancos. ${e.message || ''}`.trim();
    })
    .finally(() => { C.bancosCargando = false; if (S.vista === 'creditos' && C.modo === 'cheque') render(); });
}

/** Mientras se escribe el número o se elige el banco: el aviso y el botón, sin redibujar. */
function actualizarCheque() {
  const a = avisoCheque(S.cred.numero), p = $('#ch_aviso'), b = $('#ch_ir');
  if (p) { p.textContent = a.texto || AYUDA_CHEQUE; p.classList.toggle('malo', !!a.mal); }
  if (b && !S.cred.chConsultando) b.disabled = !(a.ok && S.cred.entidad);
  if (S.cred.chError) { S.cred.chError = ''; $('.cr-consulta .aviso-chico[role=alert]')?.remove(); }
}

async function consultarChequeDe(entidad, numero) {
  const C = S.cred, e = +entidad || 0, n = numeroCheque(numero);
  if (!e) { toast('Elegí el banco del cheque'); return; }
  if (!n) { toast(avisoCheque(numero).texto || 'Escribí el número del cheque'); return; }
  if (C.chConsultando) return;
  C.chConsultando = true; C.chError = ''; render();
  try {
    const c = await consultarCheque(e, n);
    Object.assign(C, { chAbierta: c.id, numero: '', chConfirmar: false });
    toast('Consulta guardada');
  } catch (err) {
    C.chError = err.sinSesion ? mensaje(err) : err.message || 'No se pudo consultar al BCRA';
  } finally {
    C.chConsultando = false;
    render();
  }
  if (!C.chError) verResultado();
}

function abrirCheque(id) {
  Object.assign(S.cred, { chAbierta: id, chConfirmar: false });
  render(); verResultado();
}

async function accionCheque(act, b) {
  const C = S.cred;
  if (act === 'ch-bancos') { pedirBancos(); render(); return; }
  if (act === 'ch-a-cuit') { cambiarModo('cuit'); $('#cr_cuit')?.focus(); return; }
  const c = D.consultas_cheques.find((x) => x.id === C.chAbierta);
  if (!c) return;
  if (act === 'ch-copiar') copiar(textoCheque(c));
  else if (act === 'ch-repetir') await consultarChequeDe(c.entidad, c.numero);
  else if (act === 'ch-confirmar' || act === 'ch-no') { C.chConfirmar = act === 'ch-confirmar'; render(); }
  else if (act === 'ch-borrar') {
    try { await borrarConsultaCheque(c.id); Object.assign(C, { chAbierta: null, chConfirmar: false }); toast('Consulta eliminada'); } catch (e) { toast(mensaje(e, 'no se eliminó')); }
    render();
  }
}

/** Mientras se escribe el CUIT: el aviso y el botón, sin redibujar (para no perder lo que se escribe). */
function actualizarCuit() {
  const a = avisoCuit(S.cred.cuit), p = $('#cr_aviso'), b = $('#cr_ir');
  if (p) { p.textContent = a.texto || AYUDA_CUIT; p.classList.toggle('malo', !!a.mal); }
  if (b && !S.cred.consultando) b.disabled = !a.ok;
  if (S.cred.error) { S.cred.error = ''; $('.cr-consulta .aviso-chico')?.remove(); }
}
const verResultado = () => { if (movil.matches) $('#crResultado')?.scrollIntoView({ block: 'start' }); };

async function consultarCuit(cuit) {
  const d = soloDigitos(cuit), a = avisoCuit(d);
  if (!a.ok) { toast(a.texto || 'Escribí el CUIT o CUIL'); return; }
  if (S.cred.consultando) return;
  S.cred.consultando = true; S.cred.error = ''; render();
  try {
    const c = await consultarBCRA(d);
    Object.assign(S.cred, { abierta: c.id, cuit: '', confirmar: false, errorDetalle: '' });
    toast('Consulta guardada');
  } catch (e) {
    S.cred.error = e.sinSesion ? mensaje(e) : e.message || 'No se pudo consultar al BCRA';
  } finally {
    S.cred.consultando = false;
    render();
  }
  if (!S.cred.error) verResultado();
}

async function abrirConsulta(id) {
  Object.assign(S.cred, { abierta: id, confirmar: false, errorDetalle: '' });
  render(); verResultado();
  if (detalleGuardado(id)) return;
  try { await detalleConsulta(id); } catch (e) {
    if (S.cred.abierta === id) S.cred.errorDetalle = e.sinRed ? 'Sin conexión: no se pudo leer el detalle de esta consulta.' : e.message || mensaje(e);
  }
  if (S.cred.abierta === id) render();
}

async function accionCredito(act, b) {
  if (act === 'cr-repetir') { await consultarCuit(b.dataset.cuit); return; }
  const c = D.consultas_bcra.find((x) => x.id === S.cred.abierta);
  if (!c) return;
  if (act === 'cr-copiar') copiar(textoConsulta(c, detalleGuardado(c.id)));
  else if (act === 'cr-confirmar' || act === 'cr-no') { S.cred.confirmar = act === 'cr-confirmar'; render(); }
  else if (act === 'cr-borrar') {
    try { await borrarConsulta(c.id); Object.assign(S.cred, { abierta: null, confirmar: false }); toast('Consulta eliminada'); } catch (e) { toast(mensaje(e, 'no se eliminó')); }
    render();
  }
}

// ───────────────────────── Ficha del deudor ─────────────────────────

function fichaNueva(d) {
  return {
    liq: { fecha: hoy(), aVencer: false },
    pago: null, plan: null, msg: null, edit: null, gasto: null, trasPago: false,
    gest: { tipo: 'Llamada', fecha: hoy(), texto: '', pfecha: '', pmonto: '' },
    prox: { texto: d.proxima || '', vence: d.vence || '' },
    tasa: String(d.tasa), hon: String(d.hon_pct),
  };
}
function abrirDeudor(id, tab = 'resumen', con = '') {
  const d = deudor(id); if (!d) return;
  S.abierto = id; S.tab = tab; S.f = fichaNueva(d); S.confirmar = ''; S.panel = '';
  if (con === 'pago-plan' || con === 'pago') S.f.pago = pagoNuevo(d, con === 'pago-plan');
  if (con === 'plan') S.f.plan = planNuevo(d);
  if (['atraso', 'recordatorio', 'recibo', 'aviso', 'contado', 'plan-msg'].includes(con)) S.f.msg = msgNuevo(d, con === 'plan-msg' ? 'plan' : con);
  if (tab === 'mensaje' && !S.f.msg) S.f.msg = msgNuevo(d);
  renderFicha(true);
}
function cerrarFicha() {
  S.abierto = null; S.f = null; S.confirmar = ''; S.panel = ''; S.nuevo = null; S.aj = null;
  S.arca = null; // la clave de ARCA solo vive mientras su panel está abierto
  const dr = $('#drawer'); dr.hidden = true; dr.innerHTML = ''; document.body.style.overflow = '';
}
function irATab(tab) {
  const d = deudor(S.abierto); if (!d) return;
  S.tab = tab; S.confirmar = '';
  if (tab === 'mensaje' && !S.f.msg) S.f.msg = msgNuevo(d);
  renderFicha(false, true);
}

function renderFicha(entra = false, arriba = false) {
  const d = deudor(S.abierto), box = $('#drawer');
  if (!d) { cerrarFicha(); return; }
  const r = res(d), panelAntes = box.querySelector('.panel'), sc = panelAntes ? panelAntes.scrollTop : 0, foco = guardarFoco(box);
  box.hidden = false; document.body.style.overflow = 'hidden';
  const sub = [d.socio ? `Socio N° ${d.socio}` : '', d.dni ? `DNI ${d.dni}` : '', d.acreedor].filter(Boolean).join(' · ');
  const meta = d.actualizado ? `Último cambio ${cuando(new Date(d.actualizado))}${d.actualizado_por ? ' (' + d.actualizado_por + ')' : ''}` : '';
  box.innerHTML = `<div class="scrim" data-a="cerrar"></div><aside class="panel ficha${entra ? ' entra' : ''}${S.maxi ? ' max' : ''}" role="dialog" aria-modal="true" aria-label="Ficha de ${esc(nombre(d))}">
    <div class="phead"><div><div class="hint">${esc(sub)}</div><h2>${esc(nombre(d))}</h2>
      <div class="tags">${pill(r.texto, CLASE[r.clave] || '')}${d.expte ? `<a class="tag t-juicio" href="${JUICIOS}" target="_blank" rel="noopener">Juicio · expte. ${esc(d.expte)}</a>` : ''}</div></div>
      <div class="btns"><button class="btn small" data-a="maxi" aria-pressed="${S.maxi}">${S.maxi ? 'Restaurar' : 'Maximizar'}</button><button class="btn small" data-a="cerrar">Cerrar</button></div></div>
    <nav class="tabs" role="tablist" aria-label="Secciones de la ficha">${TABS.map(([k, l]) => `<button role="tab" data-tab-ir="${k}" aria-selected="${S.tab === k}">${esc(l)}${k === 'plan' && r.plan ? ' <span class="punto"></span>' : ''}</button>`).join('')}</nav>
    <div class="tabcuerpo" role="tabpanel">${{ resumen: tabResumen, liquidacion: tabLiquidacion, pagos: tabPagos, plan: tabPlan, gestiones: tabGestiones, mensaje: tabMensaje, datos: tabDatos }[S.tab](d, r)}</div>
    <p class="hint pmeta">${esc(meta)}</p><div class="pfin"></div>
  </aside>`;
  aplicarAnchos(box);
  const p = box.querySelector('.panel');
  if (!entra && !arriba) p.scrollTop = sc;
  devolverFoco(foco);
  if (S.tab === 'pagos' && S.f.pago) actualizarPie();
  if (S.tab === 'plan' && S.f.plan) actualizarVistaPlan();
  if (S.tab === 'mensaje' && S.f.msg) actualizarEnlace();
}
const rerender = () => { if (S.abierto) renderFicha(); else if (S.panel) renderPanel(); };

// ── Resumen ──

function tabResumen(d, r) {
  const liq = r.liq, u = ultimoPago(d, r), tels = telefonos(d).filter((t) => t.wa);
  const aVencer = liq.capital_a_vencer > 0 ? ` Además hay ${plata(liq.capital_a_vencer)} de cuotas a vencer.` : '';
  const extras = [d.hon_pct ? `${porciento(d.hon_pct)} de honorarios` : '', liq.rubros.some((rb) => !['capital', 'intereses', 'honorarios'].includes(rb.id)) ? 'los gastos cargados' : ''].filter(Boolean);
  const ult = d.gestiones.slice(-3).reverse();
  return `<div class="sec">
    <dl class="cifras grandes">
      <div><dt>Deuda al ${fmt(liq.fecha)}</dt><dd>${esc(plata(Math.max(0, liq.total.saldo)))}</dd></div>
      ${r.plan ? `<div><dt>Saldo del plan</dt><dd>${esc(plata(r.ep.saldo))}</dd></div>` : ''}
      <div><dt>Mora</dt><dd>${liq.vencidas ? esc(cuantos(liq.dias_mora, 'día', 'días')) : '—'}</dd></div>
      <div><dt>Último pago</dt><dd>${u ? esc(fmt(u.fecha)) : '—'}</dd></div>
    </dl>
    <p class="m0">${liq.vencidas ? `Debe ${esc(detalleCuotas(liq))}.` : 'No tiene cuotas vencidas.'}${esc(aVencer)}</p>
    <p class="hint m0">La deuda es el saldo de las cuotas vencidas más sus intereses, al ${porciento(d.tasa)} mensual simple${extras.length ? `, más ${esc(extras.join(' y '))}` : ''}.</p>
    <div class="actions acciones">
      <button class="btn primary" data-a="ir-pago">Registrar pago</button>
      <button class="btn" data-a="ir-mensaje">Mandar WhatsApp</button>
      <button class="btn" data-tab-ir="plan">${r.plan ? 'Ver el plan' : 'Armar un plan'}</button>
      <button class="btn" data-tab-ir="gestiones">Anotar gestión</button>
    </div>
  </div>
  ${r.plan ? planResumenHtml(d, r) : ''}
  ${proximaHtml(d)}
  <div class="sec"><div class="sec-cab"><h4>Últimas gestiones</h4>${d.gestiones.length > 3 ? `<button class="btn small" data-tab-ir="gestiones">Ver todas (${d.gestiones.length})</button>` : ''}</div>
    ${ult.length ? `<ul class="hist">${ult.map((g) => gestionLi(g, false)).join('')}</ul>` : '<p class="hint m0">Todavía no hay gestiones anotadas.</p>'}</div>
  <div class="sec"><h4>Contacto</h4>
    ${telefonosHtml(d)}
    ${d.domicilio ? `<p class="m0">${esc(d.domicilio)}</p>` : ''}
    ${d.operaciones.map((o) => `<p class="m0 hint">${esc([o.tipo, o.numero ? 'N° ' + o.numero : ''].filter(Boolean).join(' '))}${o.vehiculo && vehiculoTexto(o.vehiculo) ? ' · ' + esc(vehiculoTexto(o.vehiculo)) : ''}</p>`).join('')}
    ${tels.length ? '' : '<p class="hint m0">Sin celular con código de área: cargalo en “Datos” para poder mandarle WhatsApp.</p>'}
  </div>`;
}
function telefonosHtml(d) {
  const ts = telefonos(d);
  if (!ts.length) return '<p class="hint m0">Sin teléfonos cargados.</p>';
  return `<ul class="tels">${ts.map((t) => `<li><span class="mono">${esc(t.numero)}</span>${t.nota ? ` <span class="hint">${esc(t.nota)}</span>` : ''}${t.wa ? `<a class="btn small wa" href="https://wa.me/${t.wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</li>`).join('')}</ul>`;
}
function proximaHtml(d) {
  return `<div class="sec"><h4>Próxima acción</h4>
    <div class="addrow"><input ${atar('f.prox.texto')} placeholder="Ej.: Llamarlo el lunes" aria-label="Qué hay que hacer"><input type="date" ${atar('f.prox.vence')} aria-label="Para cuándo"><button class="btn small primary" data-a="prox-guardar">Guardar</button></div>
    ${(d.proxima || '').trim() ? `<div class="actions"><span class="hint">Anotada: “${esc(d.proxima)}”${d.vence ? ' para el ' + esc(fmt(d.vence)) : ''}.</span><button class="btn small donebtn" data-a="prox-hecha">✓ Realizada</button></div>` : ''}
  </div>`;
}

// ── Liquidación ──

function tabLiquidacion(d) {
  const L = S.f.liq;
  const liq = liquidar(d, ES_FECHA.test(L.fecha || '') ? L.fecha : hoy(), { aVencer: L.aVencer });
  const cuotas = liq.cuotas.filter((c) => c.incluida || c.pagado > 0);
  const nq = (c) => (c.n == null ? '—' : c.de == null ? `${c.n} (saldo)` : `${c.n} de ${c.de}`);
  const filaRubro = (rb) => `<tr><td>${esc(rb.nombre)}${rb.tipo === 'honorarios' && rb.id === 'honorarios' ? ` <span class="hint">(${porciento(d.hon_pct)})</span>` : rb.tipo === 'honorarios' ? ' <span class="hint">(honorarios)</span>' : ''}</td><td class="num mono">${esc(plata(rb.devengado))}</td><td class="num mono">${rb.pagado ? esc(plata(rb.pagado)) : '—'}</td><td class="num mono fuerte">${esc(plata(rb.saldo))}</td></tr>`;
  const extra = [
    !L.aVencer && liq.capital_a_vencer > 0 ? `Cuotas a vencer (no incluidas): ${plata(liq.capital_a_vencer)}.` : '',
    liq.capital_anticipado > 0 ? `Pagado por adelantado a cuenta de cuotas a vencer: ${plata(liq.capital_anticipado)}.` : '',
    liq.capital_sin_cuotas > 0 ? `Imputado a capital de más (no hay cuotas que cubra): ${plata(liq.capital_sin_cuotas)}.` : '',
  ].filter(Boolean);
  return `<div class="sec">
    <div class="grid4">
      <label class="f">Liquidar al<input type="date" ${atar('f.liq.fecha')} data-re="1"></label>
      <label class="f">Interés (% mensual)<input id="f_tasa" ${atar('f.tasa')} inputmode="decimal" autocomplete="off"></label>
      <label class="f">Honorarios (%)<input id="f_hon" ${atar('f.hon')} inputmode="decimal" autocomplete="off"></label>
      <label class="chk"><input type="checkbox" data-k="f.liq.aVencer" data-re="1" ${L.aVencer ? 'checked' : ''}> Incluir las cuotas a vencer</label>
    </div>
    <p class="hint m0">Interés simple: ${porciento(d.tasa)} por cada 30 días, cuota por cuota desde su vencimiento. Un pago a capital deja de generar interés desde su fecha. La tasa y los honorarios se guardan al salir del campo.</p>
    ${cuotas.length ? `<div class="scrollx"><table class="tabla"><thead><tr><th>Cuota</th><th>Vence</th><th class="num">Importe</th><th class="num">Pagado</th><th class="num">Saldo</th><th class="num">Días</th><th class="num">Interés</th></tr></thead><tbody>
      ${cuotas.map((c) => `<tr class="${c.incluida ? '' : 'apagada'}"><td>${esc(nq(c))}${c.doc ? ` <span class="hint">doc. ${esc(c.doc)}</span>` : ''}</td><td class="mono">${fmt(c.vto)}</td><td class="num mono">${esc(plata(c.importe))}</td><td class="num mono">${c.pagado ? esc(plata(c.pagado)) : '—'}</td><td class="num mono">${esc(plata(c.saldo))}</td><td class="num mono">${c.dias || '—'}</td><td class="num mono">${c.interes ? esc(plata(c.interes)) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint m0">No hay cuotas vencidas a esa fecha.</p>'}
    <div class="scrollx"><table class="tabla rubros"><thead><tr><th>Rubro</th><th class="num">Devengado</th><th class="num">Pagado</th><th class="num">Saldo</th></tr></thead>
      <tbody>${liq.rubros.map(filaRubro).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="num mono">${esc(plata(liq.total.devengado))}</td><td class="num mono">${esc(plata(liq.total.pagado))}</td><td class="num mono fuerte">${esc(plata(liq.total.saldo))}</td></tr></tfoot></table></div>
    ${extra.map((t) => `<p class="hint m0">${esc(t)}</p>`).join('')}
    <div class="actions"><button class="btn small" data-a="excel-liq">Descargar en Excel</button><button class="btn small" data-a="copiar-liq">Copiar resumen</button></div>
  </div>
  ${gastosHtml(d, liq)}`;
}

function gastosHtml(d, liq) {
  const g = S.f.gasto;
  return `<div class="sec"><div class="sec-cab"><h4>Gastos y honorarios fijos</h4>${g ? '' : '<button class="btn small" data-a="gasto-nuevo">+ Gasto u honorario</button>'}</div>
    ${d.gastos.length ? `<ul class="hist">${d.gastos.map((x) => { const rb = liq.rubros.find((y) => y.id === x.id); return `<li><span class="mono">${fmt(x.fecha)}</span><span>${esc(x.concepto || 'Gasto')} <span class="hint">${x.tipo === 'honorarios' ? 'honorarios' : 'gasto'}</span> · <b class="mono">${esc(plata(+x.monto || 0))}</b>${rb && rb.pagado ? ` <span class="hint">· pagado ${esc(plata(rb.pagado))}</span>` : ''}</span>${S.confirmar === 'gasto:' + x.id ? `<span class="confirma"><button class="btn small danger" data-a="gasto-borrar" data-id="${esc(x.id)}">Quitar</button><button class="btn small" data-a="no">No</button></span>` : `<button class="x" data-a="confirmar" data-que="gasto:${esc(x.id)}" aria-label="Quitar ${esc(x.concepto)}">×</button>`}</li>`; }).join('')}</ul>` : '<p class="hint m0">Tasa de justicia, aportes, martillero, honorarios regulados… Cada uno es un rubro al que se le pueden imputar pagos.</p>'}
    ${g ? `<div class="grid4">
      <label class="f">Concepto<input ${atar('f.gasto.concepto')} list="conceptos" placeholder="Ej.: Tasa de justicia"></label>
      <label class="f">Tipo<select data-k="f.gasto.tipo">${opciones([['gasto', 'Gasto'], ['honorarios', 'Honorarios']], g.tipo)}</select></label>
      <label class="f">Importe ($)<input ${atar('f.gasto.monto')} inputmode="decimal" data-importe autocomplete="off"></label>
      <label class="f">Fecha<input type="date" ${atar('f.gasto.fecha')}></label>
    </div><datalist id="conceptos">${CONCEPTOS.map((c) => `<option>${esc(c)}`).join('')}</datalist>
    <div class="actions"><button class="btn small primary" data-a="gasto-guardar">Agregar</button><button class="btn small" data-a="gasto-cancelar">Cancelar</button></div>` : ''}
  </div>`;
}

// ── Pagos ──

function pagoNuevo(d, delPlan = false) {
  const r = res(d), ep = r.ep;
  return { fecha: hoy(), monto: delPlan && ep?.proxima ? enCelda(ep.proxima.importe) : '', recibo: '', medio: 'Efectivo', plan: !!(delPlan && r.plan), nota: '', imp: {} };
}
/** La liquidación a la fecha del pago, sin ese pago: el saldo de cada rubro para imputar. */
function liqDelPago(d) {
  const f = ES_FECHA.test(S.f.pago?.fecha || '') ? S.f.pago.fecha : hoy();
  return liquidar(d, f, { aVencer: true });
}

function tabPagos(d, r) {
  const P = S.f.pago, lista = d.pagos.map((p, i) => ({ p, i })).sort((a, b) => (b.p.fecha || '').localeCompare(a.p.fecha || '') || b.i - a.i);
  const nombreRubro = (k) => (k === 'capital' ? 'Capital' : k === 'intereses' ? 'Intereses' : k === 'honorarios' ? 'Honorarios' : d.gastos.find((g) => g.id === k)?.concepto || 'Gasto');
  let form = '';
  if (P) {
    const liq = liqDelPago(d);
    form = `<div class="sec pago-form"><h4>Registrar pago</h4>
      <div class="grid4">
        <label class="f">Fecha<input type="date" ${atar('f.pago.fecha')} max="${hoy()}" data-re="1"></label>
        <label class="f">Monto ($)<input ${atar('f.pago.monto')} inputmode="decimal" data-importe autocomplete="off" placeholder="0"></label>
        <label class="f">N° de recibo u OP<input ${atar('f.pago.recibo')} autocomplete="off"></label>
        <label class="f">Medio<select data-k="f.pago.medio">${opciones(MEDIOS, P.medio)}</select></label>
      </div>
      ${r.plan ? `<label class="chk"><input type="checkbox" data-k="f.pago.plan" ${P.plan ? 'checked' : ''}> Es un pago del plan de pagos${r.ep.proxima ? ` (próxima: ${r.ep.proxima.n === 0 ? 'anticipo' : 'cuota ' + r.ep.proxima.n}, ${esc(plata(r.ep.proxima.importe))})` : ''}</label>` : ''}
      <p class="hint m0">Indicá a qué rubro corresponde cada parte del pago. El saldo es el de cada rubro al ${fmt(liq.fecha)}, antes de este pago (el capital incluye las cuotas que todavía no vencieron).</p>
      <div class="imp-lista">
        ${liq.rubros.map((rb) => `<div class="imp-fila"><div class="imp-n"><b>${esc(rb.nombre)}</b><span class="hint">Saldo ${esc(plata(rb.saldo))}</span></div><input class="celda-imp" ${atar('f.pago.imp.' + rb.id)} inputmode="decimal" data-importe data-saldo="${rb.saldo}" autocomplete="off" placeholder="0" aria-label="Imputar a ${esc(rb.nombre)}"><button class="btn small" data-a="pago-completar" data-id="${esc(rb.id)}" ${rb.saldo > 0 ? '' : 'disabled'}>Completar</button></div>`).join('')}
      </div>
      <div class="imp-pie" id="pagoPie" aria-live="polite"></div>
      <label class="f">Nota<input ${atar('f.pago.nota')} placeholder="Opcional"></label>
      <div class="actions"><button class="btn primary" data-a="pago-guardar">Guardar pago</button><button class="btn" data-a="pago-cancelar">Cancelar</button><span class="sep"></span>${r.plan && r.plan.base ? '<button class="btn small" data-a="pago-como-plan">Repartir como el plan</button>' : ''}</div>
    </div>`;
  }
  const despues = S.f.trasPago ? `<div class="nota" role="status"><p><b>Pago registrado.</b> ¿Le mandás la confirmación por WhatsApp?</p><div class="actions"><button class="btn small primary" data-a="ir-recibo">Mandar confirmación</button><button class="btn small" data-a="tras-pago-no">Ahora no</button></div></div>` : '';
  return `${despues}${P ? form : `<div class="sec"><div class="sec-cab"><h4>Pagos</h4><button class="btn small primary" data-a="pago-nuevo">+ Registrar pago</button></div>
    <p class="hint m0">Pagos totales o parciales: en cada uno indicás a qué rubros corresponde (capital, intereses, honorarios, gastos).</p></div>`}
  <div class="sec"><h4>Historial de pagos · ${esc(plata(suma(d.pagos, totalPago)))}</h4>
    ${lista.length ? `<ul class="pagos">${lista.map(({ p }) => `<li>
      <div class="pago-top"><span class="mono">${fmt(p.fecha)}</span><b class="mono">${esc(plata(totalPago(p)))}</b>${p.plan ? '<span class="tag t-plan">plan</span>' : ''}<span class="hint">${esc([p.recibo ? 'Recibo ' + p.recibo : '', p.medio].filter(Boolean).join(' · '))}</span>
        ${S.confirmar === 'pago:' + p.id ? `<span class="confirma"><button class="btn small danger" data-a="pago-borrar" data-id="${esc(p.id)}">Eliminar pago</button><button class="btn small" data-a="no">No</button></span>` : `<button class="x" data-a="confirmar" data-que="pago:${esc(p.id)}" aria-label="Eliminar el pago del ${fmt(p.fecha)}">×</button>`}</div>
      <div class="imps">${Object.entries(p.imp || {}).map(([k, v]) => `<span class="tag">${esc(nombreRubro(k))} ${esc(plata(+v || 0))}</span>`).join('')}</div>
      ${p.nota ? `<div class="hint">${esc(p.nota)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="hint m0">Todavía no hay pagos registrados.</p>'}
  </div>`;
}

/** Totales del formulario de pago, mientras se escribe (sin redibujar: no se pierde el cursor). */
function actualizarPie() {
  const P = S.f?.pago, pie = $('#pagoPie'); if (!P || !pie) return;
  const imputado = r2(Object.values(P.imp || {}).reduce((a, v) => a + Math.max(0, importe(v)), 0)), monto = importe(P.monto);
  let t = `Imputado <b>${esc(plata(imputado))}</b>`, cls = '';
  if (monto > 0) {
    const falta = r2(monto - imputado);
    t += ` de ${esc(plata(monto))}`;
    if (falta > 0) { t += ` · falta imputar <b>${esc(plata(falta))}</b>`; cls = 'falta'; } else if (falta < 0) { t += ` · <b>sobran ${esc(plata(-falta))}</b>`; cls = 'sobra'; } else { t += ' · completo'; cls = 'ok'; }
  }
  const pasados = [...document.querySelectorAll('.celda-imp')].filter((el) => importe(el.value) > (+el.dataset.saldo || 0) + 0.004);
  document.querySelectorAll('.celda-imp').forEach((el) => el.classList.toggle('pasado', pasados.includes(el)));
  if (pasados.length) t += ' · <span class="malo">hay rubros con más que su saldo</span>';
  pie.className = 'imp-pie ' + cls; pie.innerHTML = t;
}

// ── Plan ──

function planNuevo(d) {
  const aj = ajustes();
  return { fecha: hoy(), monto: '', quitaPct: '', quitaMonto: '', anticipo: '', anticipoVto: hoy(), n: '6', cada: 'mes', primerVto: sumarMeses(hoy(), 1), tasa: '0', caducidad: String(aj.caducidad), nota: '' };
}
/** Lo que se está armando en el simulador: la deuda base, la quita y el plan resultante. */
function borradorPlan(d) {
  const P = S.f.plan, fecha = ES_FECHA.test(P.fecha || '') ? P.fecha : hoy();
  const liq = liquidar(d, fecha);
  const deudaLiq = Math.max(0, liq.total.saldo), base = importe(P.monto) > 0 ? importe(P.monto) : deudaLiq;
  const quita = importe(P.quitaMonto) > 0 ? importe(P.quitaMonto) : (porc(P.quitaPct) > 0 ? r2(base * porc(P.quitaPct) / 100) : 0);
  const anticipo = importe(P.anticipo), n = Math.max(1, Math.min(120, parseInt(P.n, 10) || 1)), tasa = porc(P.tasa) > 0 ? porc(P.tasa) : 0;
  const armado = armarPlan({ deuda: base, quita, anticipo, n, tasa, primerVto: P.primerVto, cada: P.cada });
  const plan = { anticipo, cada: P.cada, cuotas: armado.cuotas };
  return { fecha, liq, deudaLiq, base, quita, anticipo, n, tasa, armado, plan };
}

function tabPlan(d, r) {
  const cerrados = d.planes.filter((p) => p.estado !== 'vigente');
  const historial = cerrados.length ? `<div class="sec"><h4>Planes anteriores</h4><ul class="hist">${cerrados.map((p) => { const ep = estadoPlan(p, d.pagos, hoy()); return `<li><span class="mono">${fmt(p.fecha)}</span><span>${esc((SITUACION_PLAN[p.estado] || [p.estado])[0])}${p.cierre?.fecha ? ' el ' + esc(fmt(p.cierre.fecha)) : ''} · ${esc(planDetalle(p))} · pagado ${esc(plata(ep.pagado))} de ${esc(plata(ep.total))}${p.cierre?.motivo ? ` <span class="hint">(${esc(p.cierre.motivo)})</span>` : ''}</span><span></span></li>`; }).join('')}</ul></div>` : '';
  if (r.plan) return planVigenteHtml(d, r) + historial;
  if (!S.f.plan) {
    return `<div class="sec"><div class="sec-cab"><h4>Plan de pagos</h4><button class="btn small primary" data-a="plan-nuevo">Armar un plan</button></div>
      <p class="hint m0">Simulá un plan (anticipo, quita, cuotas con o sin interés), mandale la propuesta por WhatsApp y, si la acepta, guardalo. Si deja de pagar, el plan cae y vuelve la deuda original, con los pagos que hizo.</p></div>${historial}`;
  }
  const P = S.f.plan, b = borradorPlan(d), saldoDe = (id) => b.liq.rubros.find((x) => x.id === id)?.saldo || 0;
  return `<div class="sec plan-form"><h4>Armar un plan de pagos</h4>
    <p class="m0">Deuda al ${fmt(b.fecha)}: <b class="mono">${esc(plata(b.deudaLiq))}</b> <span class="hint">(capital ${esc(plata(saldoDe('capital')))}, intereses ${esc(plata(saldoDe('intereses')))}${saldoDe('honorarios') ? `, honorarios ${esc(plata(saldoDe('honorarios')))}` : ''}${b.liq.rubros.filter((x) => !['capital', 'intereses', 'honorarios'].includes(x.id)).length ? `, gastos ${esc(plata(suma(b.liq.rubros.filter((x) => !['capital', 'intereses', 'honorarios'].includes(x.id)), (x) => x.saldo)))}` : ''})</span></p>
    <div class="grid4">
      <label class="f">Fecha del plan<input type="date" ${atar('f.plan.fecha')} data-re="1"></label>
      <label class="f">Monto a refinanciar ($)<input ${atar('f.plan.monto')} inputmode="decimal" data-importe placeholder="${esc(enCelda(b.deudaLiq))}" autocomplete="off"></label>
      <label class="f">Quita (%)<input id="pl_qp" ${atar('f.plan.quitaPct')} inputmode="decimal" placeholder="0" autocomplete="off"></label>
      <label class="f">Quita ($)<input id="pl_qm" ${atar('f.plan.quitaMonto')} inputmode="decimal" data-importe placeholder="0" autocomplete="off"></label>
      <label class="f">Anticipo ($)<input ${atar('f.plan.anticipo')} inputmode="decimal" data-importe placeholder="0" autocomplete="off"></label>
      <label class="f">Fecha del anticipo<input type="date" ${atar('f.plan.anticipoVto')}></label>
      <label class="f">Cantidad de cuotas<input type="number" min="1" max="120" ${atar('f.plan.n')}></label>
      <label class="f">Frecuencia<select data-k="f.plan.cada">${opciones(Object.entries(CADAS), P.cada)}</select></label>
      <label class="f">Vence la 1ª cuota<input type="date" ${atar('f.plan.primerVto')}></label>
      <label class="f">Interés de financiación (% mensual)<input ${atar('f.plan.tasa')} inputmode="decimal" autocomplete="off"></label>
      <label class="f">Cae con … cuotas impagas<input type="number" min="1" max="24" ${atar('f.plan.caducidad')}></label>
      <label class="f ancho">Nota<input ${atar('f.plan.nota')} placeholder="Ej.: paga por transferencia"></label>
    </div>
    <div id="planVista" class="plan-vista" aria-live="polite"></div>
    <div class="actions"><button class="btn primary" data-a="plan-guardar">Guardar plan</button><button class="btn" data-a="plan-whatsapp">Mandar la propuesta por WhatsApp</button><span class="sep"></span><button class="btn" data-a="plan-cancelar">Cancelar</button></div>
  </div>${historial}`;
}
function actualizarVistaPlan() {
  const d = deudor(S.abierto), caja = $('#planVista'); if (!d || !caja || !S.f.plan) return;
  const b = borradorPlan(d), a = b.armado;
  const iguales = a.cuotas.every((q) => q.importe === a.cuotas[0].importe);
  caja.innerHTML = `<dl class="cifras"><div><dt>Deuda a refinanciar</dt><dd>${esc(plata(b.base))}</dd></div>${b.quita ? `<div><dt>Quita</dt><dd>${esc(plata(b.quita))}</dd></div>` : ''}${b.anticipo ? `<div><dt>Anticipo</dt><dd>${esc(plata(b.anticipo))}</dd></div>` : ''}<div><dt>Se financia</dt><dd>${esc(plata(a.financiado))}</dd></div>${a.intereses > 0 ? `<div><dt>Interés de financiación</dt><dd>${esc(plata(a.intereses))}</dd></div>` : ''}<div><dt>Total a pagar</dt><dd>${esc(plata(r2(b.anticipo + a.total)))}</dd></div></dl>
    <p class="m0"><b>${esc(planDetalle(b.plan) || 'Completá la cantidad de cuotas y el primer vencimiento')}</b>${!iguales ? ' <span class="hint">(la última cuota ajusta el redondeo)</span>' : ''}</p>
    <div class="scrollx"><table class="tabla"><thead><tr><th>Cuota</th><th>Vence</th><th class="num">Importe</th></tr></thead><tbody>${b.anticipo ? `<tr><td>Anticipo</td><td class="mono">${fmt(S.f.plan.anticipoVto)}</td><td class="num mono">${esc(plata(b.anticipo))}</td></tr>` : ''}${a.cuotas.map((q) => `<tr><td>${q.n}</td><td class="mono">${fmt(q.vto)}</td><td class="num mono">${esc(plata(q.importe))}</td></tr>`).join('')}</tbody></table></div>`;
}

function planResumenHtml(d, r) {
  const ep = r.ep, [txt, cls] = SITUACION_PLAN[ep.situacion] || [ep.situacion, ''], pct = ep.total ? ep.pagado / ep.total * 100 : 0;
  return `<div class="sec"><div class="sec-cab"><h4>Plan de pagos</h4>${pill(txt, cls)}</div>
    <p class="m0">${esc(planDetalle(r.plan))}</p>
    <div class="progreso"><span class="barra"><i data-ancho="${pct.toFixed(1)}"></i></span><span class="mono">${esc(plata(ep.pagado))} de ${esc(plata(ep.total))}</span></div>
    ${ep.proxima ? `<p class="m0">Próxima: ${ep.proxima.n === 0 ? 'anticipo' : 'cuota ' + ep.proxima.n}, ${esc(plata(ep.proxima.importe))}${ep.proxima.vto ? ', vence el ' + esc(fmt(ep.proxima.vto)) : ''}.${ep.impagas ? ` <b class="malo">${esc(cuantos(ep.impagas, 'cuota atrasada', 'cuotas atrasadas'))}.</b>` : ''}</p>` : ''}
  </div>`;
}
function planVigenteHtml(d, r) {
  const plan = r.plan, ep = r.ep, aj = ajustes(), [txt, cls] = SITUACION_PLAN[ep.situacion] || [ep.situacion, ''], pct = ep.total ? ep.pagado / ep.total * 100 : 0;
  const estadoCuota = (x) => (x.estado === 'pagada' ? pill('Pagada', 's-ok') : x.atrasada ? pill(x.estado === 'parcial' ? 'Atrasada (parcial)' : 'Atrasada', 's-bad') : x.estado === 'parcial' ? pill('Parcial', 's-warn') : pill('Pendiente'));
  const confirma = S.confirmar === 'caer' ? `<div class="confirm"><span>¿Dar por caído el plan? Vuelve la deuda original (con sus intereses), descontando los pagos que hizo.</span><button class="btn small danger" data-a="plan-caer">Sí, dar por caído</button><button class="btn small" data-a="no">Cancelar</button></div>`
    : S.confirmar === 'anular' ? `<div class="confirm"><span>¿Anular el plan? Es para un plan cargado por error: los pagos quedan, imputados como estaban.</span><button class="btn small danger" data-a="plan-anular">Sí, anular</button><button class="btn small" data-a="no">Cancelar</button></div>` : '';
  return `<div class="sec">
    <div class="sec-cab"><h4>Plan del ${fmt(plan.fecha)}</h4>${pill(ep.situacion === 'atrasado' ? `${txt} · ${cuantos(ep.impagas, 'cuota', 'cuotas')}` : txt, cls)}</div>
    <p class="m0"><b>${esc(planDetalle(plan))}</b></p>
    <div class="progreso"><span class="barra"><i data-ancho="${pct.toFixed(1)}"></i></span><span class="mono">${esc(plata(ep.pagado))} de ${esc(plata(ep.total))}</span></div>
    <dl class="cifras"><div><dt>Deuda al armarlo</dt><dd>${esc(plata(+plan.deuda || 0))}</dd></div>${+plan.quita ? `<div><dt>Quita</dt><dd>${esc(plata(+plan.quita))}</dd></div>` : ''}${+plan.tasa ? `<div><dt>Interés de financiación</dt><dd>${porciento(plan.tasa)} mensual</dd></div>` : ''}<div><dt>Saldo del plan</dt><dd>${esc(plata(ep.saldo))}</dd></div></dl>
    <div class="scrollx"><table class="tabla"><thead><tr><th>Cuota</th><th>Vence</th><th class="num">Importe</th><th class="num">Pagado</th><th>Estado</th></tr></thead><tbody>
      ${ep.items.map((x) => `<tr><td>${x.n === 0 ? 'Anticipo' : x.n}</td><td class="mono">${fmt(x.vto)}</td><td class="num mono">${esc(plata(x.importe))}</td><td class="num mono">${x.cubierto ? esc(plata(x.cubierto)) : '—'}</td><td>${estadoCuota(x)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint m0">Cae con ${cuantos(ep.caducidad, 'cuota impaga', 'cuotas impagas')} (una cuota cuenta como impaga a los ${cuantos(aj.gracia, 'día', 'días')} de su vencimiento). Los pagos marcados “del plan” se aplican a sus cuotas en orden.${plan.nota ? ' ' + esc(plan.nota) : ''}</p>
    ${ep.situacion === 'para-caer' ? `<div class="nota choque" role="alert"><p><b>El plan está en condiciones de caer:</b> ${esc(cuantos(ep.impagas, 'cuota impaga', 'cuotas impagas'))}.</p></div>` : ''}
    ${ep.situacion === 'cumplido' ? '<div class="nota" role="status"><p><b>El plan está pagado.</b> Cerralo como cumplido: la deuda queda cancelada.</p></div>' : ''}
    <div class="actions">
      ${ep.situacion === 'cumplido' ? '<button class="btn primary" data-a="plan-cumplido">Cerrar como cumplido</button>' : '<button class="btn primary" data-a="ir-pago-plan">Registrar pago del plan</button>'}
      <button class="btn" data-a="ir-recordar">${ep.impagas ? 'Avisar atraso por WhatsApp' : 'Recordar cuota por WhatsApp'}</button>
      <span class="sep"></span>
      <button class="btn danger" data-a="confirmar" data-que="caer">Dar por caído</button>
      <button class="btn" data-a="confirmar" data-que="anular">Anular</button>
    </div>
    ${confirma}
  </div>`;
}

// ── Gestiones ──

function gestionLi(g, borrar = true) {
  const prom = g.promesa_fecha ? `<div class="hint">Promete pagar${+g.promesa_monto ? ' ' + esc(plata(+g.promesa_monto)) : ''} el ${esc(fmt(g.promesa_fecha))}</div>` : '';
  const x = !borrar ? '<span></span>' : S.confirmar === 'gestion:' + g.id
    ? `<span class="confirma"><button class="btn small danger" data-a="gestion-borrar" data-id="${esc(g.id)}">Borrar</button><button class="btn small" data-a="no">No</button></span>`
    : `<button class="x" data-a="confirmar" data-que="gestion:${esc(g.id)}" aria-label="Borrar la gestión">×</button>`;
  return `<li><span class="mono">${fmt(g.fecha)}</span><span><span class="tag ${g.tipo === 'Promesa de pago' ? 't-prom' : g.tipo === 'WhatsApp' ? 't-wa' : ''}">${esc(g.hecha ? '✓ ' + (g.tipo || 'Acción') : g.tipo || 'Nota')}</span> <span class="texto">${esc(g.texto)}</span>${prom}</span>${x}</li>`;
}
function tabGestiones(d, r) {
  const G = S.f.gest, lista = d.gestiones.map((g, i) => ({ g, i })).sort((a, b) => (b.g.fecha || '').localeCompare(a.g.fecha || '') || b.i - a.i);
  const prom = r.prom ? `<div class="nota ${r.prom.estado === 'incumplida' ? 'choque' : ''}" role="status"><p><b>Promesa de pago:</b> ${r.prom.monto ? esc(plata(r.prom.monto)) + ' ' : ''}para el ${esc(fmt(r.prom.fecha))} · ${esc({ pendiente: r.prom.hoy ? 'es hoy' : 'pendiente', cumplida: 'cumplida', incumplida: 'no la cumplió', seguida: 'no la cumplió (ya hubo otra gestión)' }[r.prom.estado])}</p></div>` : '';
  return `${prom}${proximaHtml(d)}
  <div class="sec"><h4>Anotar gestión</h4>
    <div class="grid4">
      <label class="f">Tipo<select data-k="f.gest.tipo" data-re="1">${opciones(TIPOS_GESTION, G.tipo)}</select></label>
      <label class="f">Fecha<input type="date" ${atar('f.gest.fecha')} max="${hoy()}"></label>
      ${G.tipo === 'Promesa de pago' ? `<label class="f">Promete pagar el<input type="date" ${atar('f.gest.pfecha')}></label><label class="f">Monto prometido ($)<input ${atar('f.gest.pmonto')} inputmode="decimal" data-importe autocomplete="off"></label>` : ''}
    </div>
    <label class="f">Qué pasó<textarea rows="3" data-k="f.gest.texto" placeholder="Ej.: Atendió la hermana, dice que vuelve el viernes">${esc(G.texto)}</textarea></label>
    <div class="actions"><button class="btn primary" data-a="gestion-guardar">Guardar gestión</button></div>
  </div>
  <div class="sec"><h4>Historial · ${d.gestiones.length}</h4>
    ${lista.length ? `<ul class="hist">${lista.map(({ g }) => gestionLi(g)).join('')}</ul>` : '<p class="hint m0">Todavía no hay gestiones anotadas.</p>'}
  </div>`;
}

// ── WhatsApp ──

function msgNuevo(d, modelo = '') {
  const r = res(d), ms = D.modelos_mensaje;
  const elegido = ms.find((m) => m.id === modelo)?.id || (r.ep?.impagas ? 'atraso' : r.plan ? 'recordatorio' : 'aviso');
  const id = ms.find((m) => m.id === elegido) ? elegido : ms[0]?.id || '';
  const wa = telefonos(d).find((t) => t.wa)?.wa || '';
  const m = { modelo: id, numero: wa, texto: '', base: '', propuesta: false };
  m.texto = m.base = generar(d, m); // base: el texto tal como salió del modelo (si no se tocó, se rehace solo)
  return m;
}
function generar(d, m) {
  const modelo = D.modelos_mensaje.find((x) => x.id === m.modelo); if (!modelo) return '';
  const propuesta = m.propuesta && S.f.plan ? borradorPlan(d).plan : null;
  return completar(modelo.cuerpo, contextoMensaje(d, res(d), ajustes(), hoy(), propuesta)).texto;
}
function tabMensaje(d) {
  const M = S.f.msg || (S.f.msg = msgNuevo(d)), tels = telefonos(d).filter((t) => t.wa);
  // Si el texto no se tocó, se rehace con los datos de ahora (un pago nuevo, otro trato…); si se editó, queda.
  if (M.texto === M.base) M.texto = M.base = generar(d, M);
  const faltan = completar(M.texto, Object.fromEntries(CAMPOS_MENSAJE.map(([k]) => [k, '']))).faltan;
  return `<div class="sec">
    <h4>Mensaje por WhatsApp</h4>
    <div class="grid2">
      <label class="f">Modelo<select data-k="f.msg.modelo" data-a-cambio="msg-modelo">${opciones(D.modelos_mensaje.map((m) => [m.id, m.titulo]), M.modelo)}</select></label>
      <label class="f">Enviar a${tels.length ? `<select data-k="f.msg.numero">${opciones(tels.map((t) => [t.wa, t.etiqueta]), M.numero)}</select>` : '<input value="Sin celular cargado" readonly>'}</label>
    </div>
    ${M.propuesta ? '<p class="hint m0">El plan del mensaje es el que estás armando en “Plan” (todavía no está guardado).</p>' : ''}
    <label class="f">Texto<textarea rows="13" data-k="f.msg.texto" id="msgTexto">${esc(M.texto)}</textarea></label>
    ${faltan.length ? `<p class="aviso-chico">Quedaron campos sin dato: ${faltan.map((k) => `<code>{{${esc(k)}}}</code>`).join(' ')}. Escribilos a mano o cargá el dato en la ficha.</p>` : ''}
    <div class="actions">
      ${tels.length ? '<a class="btn primary" id="msgAbrir" target="_blank" rel="noopener" data-a="msg-abrir" href="#">Abrir WhatsApp</a>' : '<button class="btn primary" disabled>Abrir WhatsApp</button>'}
      <button class="btn" data-a="msg-copiar">Copiar texto</button>
      <button class="btn" data-a="msg-regenerar">Volver al modelo</button>
    </div>
    <p class="hint m0">Se abre WhatsApp con el número y el texto listos: lo enviás vos, y queda anotado en las gestiones. Mandá los mensajes de a uno, nunca en forma masiva. ${tels.length ? '' : 'Para mandarle, cargá un celular con código de área en “Datos”.'}</p>
  </div>`;
}
function enlaceWa() {
  const M = S.f?.msg; if (!M || !M.numero) return '';
  return `https://wa.me/${M.numero}?text=${encodeURIComponent(M.texto || '')}`;
}
function actualizarEnlace() { const a = $('#msgAbrir'); if (a) a.href = enlaceWa() || '#'; }

// ── Datos ──

const EDITABLES = ['nombre', 'trato', 'dni', 'socio', 'acreedor', 'estado', 'expte', 'domicilio', 'email', 'notas', 'telefonos', 'operaciones', 'cuotas'];
const opVacia = () => ({ id: idNuevo(), tipo: 'Ayuda económica con prenda', numero: '', fecha: '', cuotas: '', importe: '', concesionaria: '', vehiculo: { marca: '', modelo: '', anio: '', dominio: '' }, ultimo_pago: '', nota: '' });
/** Los datos como se editan (textos), para el formulario. */
function aFormulario(d) {
  return {
    nombre: d.nombre, trato: d.trato || '', dni: d.dni || '', socio: d.socio || '', acreedor: d.acreedor || '', estado: d.estado, expte: d.expte || '',
    domicilio: d.domicilio || '', email: d.email || '', notas: d.notas || '',
    telefonos: d.telefonos.map((t) => ({ numero: t.numero || '', nota: t.nota || '' })),
    operaciones: d.operaciones.map((o) => ({ ...opVacia(), ...o, cuotas: o.cuotas ? String(o.cuotas) : '', importe: o.importe ? enCelda(o.importe) : '', vehiculo: { marca: '', modelo: '', anio: '', dominio: '', ...(o.vehiculo || {}) } })),
    cuotas: d.cuotas.map((q) => ({ id: q.id, op: q.op || '', n: q.n == null ? '' : String(q.n), de: q.de ? String(q.de) : '', vto: q.vto || '', importe: enCelda(+q.importe || 0), doc: q.doc || '', nota: q.nota || '' })),
  };
}
/** Del formulario a los datos guardados. */
function deFormulario(e) {
  const ent = (s) => { const n = parseInt(String(s).trim(), 10); return Number.isFinite(n) ? n : null; };
  return {
    nombre: e.nombre.trim(), trato: e.trato.trim(), dni: e.dni.trim(), socio: e.socio.trim(), acreedor: e.acreedor.trim(), estado: e.estado, expte: e.expte.trim(),
    domicilio: e.domicilio.trim(), email: e.email.trim(), notas: e.notas,
    telefonos: e.telefonos.filter((t) => t.numero.trim()).map((t) => ({ numero: t.numero.trim(), nota: t.nota.trim() })),
    operaciones: e.operaciones.map((o) => ({ ...o, numero: o.numero.trim(), cuotas: ent(o.cuotas), importe: importe(o.importe), vehiculo: { marca: o.vehiculo.marca.trim(), modelo: o.vehiculo.modelo.trim(), anio: String(o.vehiculo.anio).trim(), dominio: o.vehiculo.dominio.trim().toUpperCase() } })),
    cuotas: e.cuotas.map((q) => ({ id: q.id || idNuevo(), op: q.op || '', n: ent(q.n), de: ent(q.de) || null, vto: q.vto, importe: importe(q.importe), doc: q.doc.trim(), ...(q.nota ? { nota: q.nota } : {}) })),
  };
}
const normal = (d) => JSON.stringify(EDITABLES.map((k) => d[k] ?? null));

function tabDatos(d) {
  const E = S.f.edit;
  if (E) return datosEditarHtml(d, E);
  const dato = (t, v) => `<div><dt>${esc(t)}</dt><dd>${v ? esc(v) : '<span class="hint">—</span>'}</dd></div>`;
  return `<div class="sec"><div class="sec-cab"><h4>Datos del deudor</h4><button class="btn small primary" data-a="editar">Editar datos</button></div>
    <dl class="datos">${dato('Nombre', d.nombre)}${dato('Cómo nombrarlo en los mensajes', d.trato)}${dato('DNI / CUIT', d.dni)}${dato('N° de socio', d.socio)}${dato('Acreedor', d.acreedor)}${dato('Estado', d.estado)}${dato('Expte. del juicio', d.expte)}${dato('Domicilio', d.domicilio)}${dato('Email', d.email)}</dl>
    <h5>Teléfonos</h5>${telefonosHtml(d)}
    ${d.notas ? `<h5>Notas</h5><p class="m0 texto">${esc(d.notas)}</p>` : ''}
  </div>
  <div class="sec"><h4>Operación</h4>${d.operaciones.length ? d.operaciones.map((o) => `<dl class="datos">${dato('Tipo', o.tipo)}${dato('N°', o.numero)}${dato('Otorgada', o.fecha ? fmt(o.fecha) : '')}${dato('Cuotas', o.cuotas ? `${o.cuotas}${o.importe ? ' de ' + plata(+o.importe) : ''}` : '')}${dato('Concesionaria', o.concesionaria)}${dato('Vehículo', vehiculoTexto(o.vehiculo))}${dato('Último pago', o.ultimo_pago ? fmt(o.ultimo_pago) : '')}</dl>${o.nota ? `<p class="hint m0">${esc(o.nota)}</p>` : ''}`).join('') : '<p class="hint m0">Sin operación cargada.</p>'}</div>
  <div class="sec"><h4>Cuotas que se deben · ${d.cuotas.length}</h4>
    ${d.cuotas.length ? `<div class="scrollx"><table class="tabla"><thead><tr><th>Cuota</th><th>Vence</th><th class="num">Importe</th><th>Doc.</th></tr></thead><tbody>${[...d.cuotas].sort((a, b) => (a.vto || '').localeCompare(b.vto || '') || (a.n ?? 0) - (b.n ?? 0)).map((q) => `<tr><td>${q.n ?? '—'}${q.de ? ' de ' + q.de : q.n != null ? ' (saldo)' : ''}</td><td class="mono">${fmt(q.vto)}</td><td class="num mono">${esc(plata(+q.importe || 0))}</td><td class="hint">${esc(q.doc || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint m0">Sin cuotas cargadas: agregalas desde “Editar datos”.</p>'}
  </div>
  <div class="sec peligro">${S.confirmar === 'borrar' ? `<div class="confirm"><span>¿Eliminar definitivamente a ${esc(nombre(d))}, con sus pagos, planes y gestiones? Si ya no se gestiona, mejor cambiale el estado a “Cancelado” o “Archivado”.</span><button class="btn small danger" data-a="borrar">Sí, eliminar</button><button class="btn small" data-a="no">Cancelar</button></div>` : '<div class="actions"><button class="btn danger" data-a="confirmar" data-que="borrar">Eliminar deudor</button></div>'}</div>`;
}

function datosEditarHtml(d, E) {
  const G = E.gen || {};
  return `<div class="sec"><h4>Editar datos</h4>
    <div class="grid2">
      <label class="f ancho">Nombre (como figura en la operación)<input ${atar('f.edit.nombre')}></label>
      <label class="f">Cómo nombrarlo en los mensajes<input ${atar('f.edit.trato')} placeholder="${esc(nombrePropio(E.nombre))}"></label>
      <label class="f">DNI / CUIT<input ${atar('f.edit.dni')}></label>
      <label class="f">N° de socio<input ${atar('f.edit.socio')}></label>
      <label class="f">Acreedor<input ${atar('f.edit.acreedor')}></label>
      <label class="f">Estado<select data-k="f.edit.estado">${opciones(ESTADOS, E.estado)}</select></label>
      <label class="f">Expte. del juicio (gestor)<input ${atar('f.edit.expte')} inputmode="numeric" placeholder="Si pasó a juicio"></label>
      <label class="f ancho">Domicilio<input ${atar('f.edit.domicilio')}></label>
      <label class="f">Email<input type="email" ${atar('f.edit.email')}></label>
    </div>
    <h5>Teléfonos</h5>
    ${E.telefonos.map((t, i) => `<div class="addrow tel"><input ${atar(`f.edit.telefonos.${i}.numero`)} inputmode="tel" placeholder="Con código de área, sin 0 ni 15" aria-label="Teléfono ${i + 1}"><input ${atar(`f.edit.telefonos.${i}.nota`)} placeholder="Nota (ej.: padre, fijo)" aria-label="Nota del teléfono ${i + 1}"><button class="x" data-a="tel-quitar" data-i="${i}" aria-label="Quitar teléfono">×</button></div>`).join('')}
    <div><button class="btn small" data-a="tel-agregar">+ Teléfono</button></div>
    <label class="f">Notas<textarea rows="3" data-k="f.edit.notas">${esc(E.notas)}</textarea></label>
  </div>
  <div class="sec"><h4>Operación</h4>
    ${E.operaciones.map((o, i) => `<div class="tarjeta"><div class="grid4">
      <label class="f">Tipo<select data-k="f.edit.operaciones.${i}.tipo">${opciones(TIPOS_OPERACION, o.tipo)}</select></label>
      <label class="f">N°<input ${atar(`f.edit.operaciones.${i}.numero`)}></label>
      <label class="f">Otorgada<input type="date" ${atar(`f.edit.operaciones.${i}.fecha`)}></label>
      <label class="f">Cantidad de cuotas<input ${atar(`f.edit.operaciones.${i}.cuotas`)} inputmode="numeric"></label>
      <label class="f">Importe de la cuota ($)<input ${atar(`f.edit.operaciones.${i}.importe`)} inputmode="decimal" data-importe></label>
      <label class="f">Concesionaria<input ${atar(`f.edit.operaciones.${i}.concesionaria`)}></label>
      <label class="f">Marca<input ${atar(`f.edit.operaciones.${i}.vehiculo.marca`)}></label>
      <label class="f">Modelo<input ${atar(`f.edit.operaciones.${i}.vehiculo.modelo`)}></label>
      <label class="f">Año<input ${atar(`f.edit.operaciones.${i}.vehiculo.anio`)} inputmode="numeric"></label>
      <label class="f">Dominio<input ${atar(`f.edit.operaciones.${i}.vehiculo.dominio`)}></label>
      <label class="f">Último pago<input type="date" ${atar(`f.edit.operaciones.${i}.ultimo_pago`)}></label>
    </div><div><button class="btn small danger" data-a="op-quitar" data-i="${i}">Quitar operación</button></div></div>`).join('')}
    <div><button class="btn small" data-a="op-agregar">+ Operación</button></div>
  </div>
  <div class="sec"><h4>Cuotas que se deben</h4>
    <p class="hint m0">Cargá solo las impagas (como en la planilla: las pagadas no van). “De” vacío es el saldo de una cuota pagada en parte.</p>
    <div class="scrollx"><table class="tabla edit"><thead><tr><th>N°</th><th>De</th><th>Vence</th><th class="num">Importe ($)</th><th>Doc.</th><th></th></tr></thead><tbody>
      ${E.cuotas.map((q, i) => `<tr><td><input class="corto" ${atar(`f.edit.cuotas.${i}.n`)} inputmode="numeric" aria-label="Número de la cuota ${i + 1}"></td><td><input class="corto" ${atar(`f.edit.cuotas.${i}.de`)} inputmode="numeric" aria-label="De cuántas"></td><td><input type="date" ${atar(`f.edit.cuotas.${i}.vto`)} aria-label="Vencimiento"></td><td><input class="num" ${atar(`f.edit.cuotas.${i}.importe`)} inputmode="decimal" data-importe aria-label="Importe"></td><td><input class="corto" ${atar(`f.edit.cuotas.${i}.doc`)} aria-label="Documento"></td><td><button class="x" data-a="cuota-quitar" data-i="${i}" aria-label="Quitar la cuota">×</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="tarjeta"><b>Agregar cuotas mensuales</b>
      <div class="grid4">
        <label class="f">Desde la cuota N°<input ${atar('f.edit.gen.n0')} inputmode="numeric" placeholder="1"></label>
        <label class="f">De (total)<input ${atar('f.edit.gen.de')} inputmode="numeric" placeholder="${esc(String(G.de || ''))}"></label>
        <label class="f">Cantidad<input ${atar('f.edit.gen.cant')} inputmode="numeric" placeholder="1"></label>
        <label class="f">Vence la primera<input type="date" ${atar('f.edit.gen.vto')}></label>
        <label class="f">Importe de cada una ($)<input ${atar('f.edit.gen.importe')} inputmode="decimal" data-importe></label>
      </div>
      <div><button class="btn small" data-a="cuotas-generar">Agregar cuotas</button></div>
    </div>
  </div>
  <div class="ppie"><button class="btn primary" data-a="editar-guardar">Guardar cambios</button><button class="btn" data-a="editar-cancelar">Cancelar</button></div>`;
}

// ───────────────────────── Acciones de la ficha ─────────────────────────

async function guardarDeudor(mutar, ok, boton) {
  await conBoton(boton, 'Guardando…', async () => {
    try {
      const r = await cambiarDeudor(S.abierto, mutar);
      if (!r.sinCambios) toast(ok);
      rerender();
    } catch (e) { toast(mensaje(e)); if (e.code === 'no-existe') cerrarFicha(); }
  });
}

async function accionFicha(a, b) {
  const d = deudor(S.abierto); if (!d) return;
  const F = S.f, dia = hoy();
  switch (a) {
    case 'cerrar': cerrarFicha(); return;
    case 'maxi': S.maxi = !S.maxi; try { localStorage.setItem('cb.maxi', S.maxi ? '1' : '0'); } catch { /* sin almacenamiento */ } renderFicha(); return;
    case 'confirmar': S.confirmar = b.dataset.que; renderFicha(); return;
    case 'no': S.confirmar = ''; renderFicha(); return;
    case 'ir-pago': F.pago = F.pago || pagoNuevo(d); irATab('pagos'); return;
    case 'ir-pago-plan': F.pago = pagoNuevo(d, true); irATab('pagos'); return;
    case 'ir-mensaje': irATab('mensaje'); return;
    case 'ir-recordar': { const r = res(d); F.msg = msgNuevo(d, r.ep?.impagas ? 'atraso' : 'recordatorio'); irATab('mensaje'); return; }
    case 'ir-recibo': F.trasPago = false; F.msg = msgNuevo(d, 'recibo'); irATab('mensaje'); return;
    case 'tras-pago-no': F.trasPago = false; renderFicha(); return;

    // Próxima acción
    case 'prox-guardar': {
      const texto = (F.prox.texto || '').trim(), vence = ES_FECHA.test(F.prox.vence || '') ? F.prox.vence : '';
      await guardarDeudor((x) => { x.proxima = texto; x.vence = texto ? vence : ''; }, texto ? 'Próxima acción guardada' : 'Próxima acción borrada', b); return;
    }
    case 'prox-hecha': {
      const texto = (d.proxima || '').trim(); if (!texto) return;
      const fecha = d.vence && d.vence < dia ? d.vence : dia;
      F.prox = { texto: '', vence: '' };
      await guardarDeudor((x) => { x.gestiones.push({ id: idNuevo(), creado: ahora(), fecha, tipo: 'Nota', texto: x.proxima, hecha: true }); x.proxima = ''; x.vence = ''; }, 'Acción realizada: quedó en el historial', b); return;
    }

    // Gestiones
    case 'gestion-guardar': {
      const G = F.gest, texto = (G.texto || '').trim();
      if (!texto) { toast('Escribí qué pasó'); return; }
      const g = { id: idNuevo(), creado: ahora(), fecha: ES_FECHA.test(G.fecha || '') ? G.fecha : dia, tipo: G.tipo, texto };
      if (G.tipo === 'Promesa de pago') {
        if (!ES_FECHA.test(G.pfecha || '')) { toast('Indicá para cuándo promete pagar'); return; }
        g.promesa_fecha = G.pfecha; g.promesa_monto = importe(G.pmonto);
      }
      F.gest = { tipo: G.tipo === 'Promesa de pago' ? 'Llamada' : G.tipo, fecha: dia, texto: '', pfecha: '', pmonto: '' };
      await guardarDeudor((x) => { x.gestiones.push(g); }, 'Gestión anotada', b); return;
    }
    case 'gestion-borrar': S.confirmar = ''; await guardarDeudor((x) => { x.gestiones = x.gestiones.filter((g) => g.id !== b.dataset.id); }, 'Gestión borrada', b); return;

    // Gastos
    case 'gasto-nuevo': F.gasto = { concepto: '', tipo: 'gasto', monto: '', fecha: dia }; renderFicha(); return;
    case 'gasto-cancelar': F.gasto = null; renderFicha(); return;
    case 'gasto-guardar': {
      const g = F.gasto, monto = importe(g.monto), concepto = (g.concepto || '').trim();
      if (!concepto) { toast('Indicá el concepto'); return; }
      if (!(monto > 0)) { toast('Indicá el importe'); return; }
      const tipo = g.tipo === 'honorarios' || /honorario/i.test(concepto) ? 'honorarios' : 'gasto';
      F.gasto = null;
      await guardarDeudor((x) => { x.gastos.push({ id: idNuevo(), tipo, concepto, monto, fecha: ES_FECHA.test(g.fecha || '') ? g.fecha : dia }); }, 'Gasto agregado', b); return;
    }
    case 'gasto-borrar': {
      const id = b.dataset.id; S.confirmar = '';
      if (d.pagos.some((p) => +p.imp?.[id] > 0)) { toast('Ese gasto tiene pagos imputados: eliminá antes esos pagos'); renderFicha(); return; }
      await guardarDeudor((x) => { x.gastos = x.gastos.filter((g) => g.id !== id); }, 'Gasto quitado', b); return;
    }

    // Liquidación
    case 'excel-liq': descargarLiquidacion(d); return;
    case 'copiar-liq': copiar(textoLiquidacion(d)); return;

    // Pagos
    case 'pago-nuevo': F.pago = pagoNuevo(d); F.trasPago = false; renderFicha(); return;
    case 'pago-cancelar': F.pago = null; renderFicha(); return;
    case 'pago-completar': {
      const id = b.dataset.id, liq = liqDelPago(d), rb = liq.rubros.find((x) => x.id === id); if (!rb) return;
      const otros = r2(Object.entries(F.pago.imp || {}).filter(([k]) => k !== id).reduce((s, [, v]) => s + Math.max(0, importe(v)), 0));
      const monto = importe(F.pago.monto), falta = monto > 0 ? r2(monto - otros) : rb.saldo;
      F.pago.imp[id] = enCelda(Math.max(0, Math.min(rb.saldo, falta)));
      renderFicha(); return;
    }
    case 'pago-como-plan': {
      const r = res(d), base = r.plan?.base; if (!base) return;
      const monto = importe(F.pago.monto) || r.ep?.proxima?.importe || 0;
      if (!(monto > 0)) { toast('Indicá el monto del pago'); return; }
      F.pago.imp = repartir(monto, base); F.pago.monto = enCelda(monto);
      renderFicha(); return;
    }
    case 'pago-guardar': await guardarPago(d, b); return;
    case 'pago-borrar': S.confirmar = ''; await guardarDeudor((x) => { x.pagos = x.pagos.filter((p) => p.id !== b.dataset.id); }, 'Pago eliminado', b); return;

    // Plan
    case 'plan-nuevo': F.plan = planNuevo(d); renderFicha(); return;
    case 'plan-cancelar': F.plan = null; if (F.msg?.propuesta) F.msg = null; renderFicha(); return;
    case 'plan-whatsapp': F.msg = msgNuevo(d, 'plan'); F.msg.propuesta = true; F.msg.texto = F.msg.base = generar(d, F.msg); irATab('mensaje'); return;
    case 'plan-guardar': await guardarPlan(d, b); return;
    case 'plan-caer': case 'plan-anular': case 'plan-cumplido': {
      const r = res(d), plan = r.plan; if (!plan) return;
      const estado = { 'plan-caer': 'caido', 'plan-anular': 'anulado', 'plan-cumplido': 'cumplido' }[a];
      const motivo = { caido: r.ep.impagas ? cuantos(r.ep.impagas, 'cuota impaga', 'cuotas impagas') : 'Dado por caído', anulado: 'Anulado', cumplido: 'Pagado' }[estado];
      S.confirmar = '';
      await guardarDeudor((x) => {
        const p = x.planes.find((y) => y.id === plan.id); if (!p || p.estado !== 'vigente') return false;
        p.estado = estado; p.cierre = { fecha: dia, motivo };
        if (estado === 'cumplido') x.estado = 'Cancelado';
        x.gestiones.push({ id: idNuevo(), creado: ahora(), fecha: dia, tipo: 'Nota', texto: { caido: `Plan de pagos caído (${motivo}): vuelve la deuda original.`, anulado: 'Plan de pagos anulado.', cumplido: 'Plan de pagos cumplido: deuda cancelada.' }[estado] });
      }, { caido: 'Plan dado por caído', anulado: 'Plan anulado', cumplido: 'Plan cumplido: deuda cancelada' }[estado], b);
      return;
    }

    // WhatsApp
    case 'msg-copiar': copiar(F.msg?.texto || ''); return;
    case 'msg-regenerar': F.msg.texto = F.msg.base = generar(d, F.msg); renderFicha(); return;
    case 'msg-abrir': {
      // El enlace se abre solo (es un <a>); acá queda anotado en el historial.
      const M = F.msg; if (!M?.numero) return;
      const titulo = D.modelos_mensaje.find((m) => m.id === M.modelo)?.titulo || 'Mensaje';
      const tel = telefonos(d).find((t) => t.wa === M.numero)?.numero || M.numero;
      cambiarDeudor(d.id, (x) => { x.gestiones.push({ id: idNuevo(), creado: ahora(), fecha: dia, tipo: 'WhatsApp', texto: `${titulo} (a ${tel}):\n${M.texto}` }); })
        .then(() => toast('Mensaje anotado en las gestiones'), (e) => toast(mensaje(e, 'el mensaje no quedó anotado')));
      return;
    }

    // Datos
    case 'editar': F.edit = { ...aFormulario(d), gen: {} }; F.editBase = normal(deFormulario(aFormulario(d))); renderFicha(); return;
    case 'editar-cancelar': F.edit = null; renderFicha(); return;
    case 'tel-agregar': F.edit.telefonos.push({ numero: '', nota: '' }); renderFicha(); return;
    case 'tel-quitar': F.edit.telefonos.splice(+b.dataset.i, 1); renderFicha(); return;
    case 'op-agregar': F.edit.operaciones.push(opVacia()); renderFicha(); return;
    case 'op-quitar': F.edit.operaciones.splice(+b.dataset.i, 1); renderFicha(); return;
    case 'cuota-quitar': F.edit.cuotas.splice(+b.dataset.i, 1); renderFicha(); return;
    case 'cuotas-generar': {
      const G = F.edit.gen || {}, n0 = parseInt(G.n0, 10) || 1, cant = parseInt(G.cant, 10) || 1, de = parseInt(G.de, 10) || '', imp = importe(G.importe);
      if (!ES_FECHA.test(G.vto || '')) { toast('Indicá el vencimiento de la primera'); return; }
      if (!(imp > 0)) { toast('Indicá el importe de cada cuota'); return; }
      if (cant > 120) { toast('Como mucho 120 cuotas de una vez'); return; }
      for (let k = 0; k < cant; k++) F.edit.cuotas.push({ id: idNuevo(), op: F.edit.operaciones[0]?.id || '', n: String(n0 + k), de: de ? String(de) : '', vto: sumarMeses(G.vto, k), importe: enCelda(imp), doc: '', nota: '' });
      F.edit.gen = { de: G.de };
      renderFicha(); toast(`${cuantos(cant, 'cuota agregada', 'cuotas agregadas')}. Tocá “Guardar cambios”.`); return;
    }
    case 'editar-guardar': {
      const nuevo = deFormulario(F.edit);
      if (!nuevo.nombre) { toast('Falta el nombre'); return; }
      if (nuevo.expte && !/^\d+$/.test(nuevo.expte)) { toast('El N° de expediente es numérico'); return; }
      const mala = nuevo.cuotas.findIndex((q) => !ES_FECHA.test(q.vto || '') || !(q.importe > 0));
      if (mala >= 0) { toast(`Revisá la cuota ${nuevo.cuotas[mala].n ?? mala + 1}: le falta el vencimiento o el importe`); return; }
      const antes = JSON.parse(F.editBase), cambiados = EDITABLES.filter((k, i) => JSON.stringify(nuevo[k] ?? null) !== JSON.stringify(antes[i]));
      if (!cambiados.length) { F.edit = null; renderFicha(); toast('Sin cambios'); return; }
      await conBoton(b, 'Guardando…', async () => {
        try {
          // Solo lo que se cambió en el formulario: si mientras tanto Claude cambió otro dato, se conserva.
          await cambiarDeudor(d.id, (x) => { for (const k of cambiados) x[k] = nuevo[k]; });
          F.edit = null; toast('Cambios guardados'); renderFicha();
        } catch (e) { toast(mensaje(e)); }
      });
      return;
    }
    case 'borrar':
      try { await borrarDeudor(d.id); toast('Deudor eliminado'); cerrarFicha(); } catch (e) { toast(mensaje(e, 'no se eliminó')); }
      return;
  }
}

/** Reparte un monto en la proporción de la deuda con que se armó el plan (lo que no cierra por redondeo, a capital). */
function repartir(monto, base) {
  const partes = { capital: +base.capital || 0, intereses: +base.intereses || 0, honorarios: +base.honorarios || 0, ...(base.gastos || {}) };
  const total = Object.values(partes).reduce((a, v) => a + Math.max(0, v), 0);
  if (!(total > 0)) return { capital: enCelda(monto) };
  const imp = {}; let asignado = 0;
  for (const [k, v] of Object.entries(partes)) { if (v > 0) { const x = r2(Math.floor(monto * v / total * 100) / 100); imp[k] = x; asignado = r2(asignado + x); } }
  imp.capital = r2((imp.capital || 0) + r2(monto - asignado));
  return Object.fromEntries(Object.entries(imp).filter(([, v]) => v > 0).map(([k, v]) => [k, enCelda(v)]));
}

async function guardarPago(d, b) {
  const P = S.f.pago, dia = hoy();
  if (!ES_FECHA.test(P.fecha || '')) { toast('Indicá la fecha del pago'); return; }
  if (P.fecha > dia) { toast('La fecha del pago no puede ser posterior a hoy'); return; }
  const imp = {};
  for (const [k, v] of Object.entries(P.imp || {})) { const n = importe(v); if (n > 0) imp[k] = n; }
  const total = r2(Object.values(imp).reduce((a, v) => a + v, 0)), monto = importe(P.monto);
  if (!(total > 0)) { toast('Indicá a qué rubros corresponde el pago'); return; }
  if (monto > 0 && Math.abs(monto - total) > 0.004) { toast(`La imputación suma ${plata(total)} y el pago es de ${plata(monto)}`); return; }
  const plan = P.plan ? planVigente(d) : null;
  const pago = { id: idNuevo(), creado: ahora(), fecha: P.fecha, recibo: (P.recibo || '').trim(), medio: P.medio || '', imp, plan: plan ? plan.id : '', nota: (P.nota || '').trim() };
  await conBoton(b, 'Guardando…', async () => {
    try {
      await cambiarDeudor(d.id, (x) => { x.pagos.push(pago); });
      S.f.pago = null; S.f.trasPago = telefonos(d).some((t) => t.wa);
      toast(`Pago de ${plata(total)} registrado`);
      renderFicha(false, true);
    } catch (e) { toast(mensaje(e)); }
  });
}

async function guardarPlan(d, b) {
  const P = S.f.plan, bp = borradorPlan(d), dia = hoy();
  if (planVigente(d)) { toast('Ya tiene un plan vigente'); return; }
  if (!ES_FECHA.test(P.primerVto || '')) { toast('Indicá el vencimiento de la primera cuota'); return; }
  if (!(bp.armado.financiado > 0) && !(bp.anticipo > 0)) { toast('No queda nada para financiar'); return; }
  if (bp.anticipo > 0 && !ES_FECHA.test(P.anticipoVto || '')) { toast('Indicá la fecha del anticipo'); return; }
  const saldoDe = (id) => bp.liq.rubros.find((x) => x.id === id)?.saldo || 0;
  const gastos = Object.fromEntries(bp.liq.rubros.filter((x) => !['capital', 'intereses', 'honorarios'].includes(x.id) && x.saldo > 0).map((x) => [x.id, x.saldo]));
  const plan = {
    id: idNuevo(), fecha: bp.fecha, estado: 'vigente', deuda: bp.base,
    base: { capital: Math.max(0, saldoDe('capital')), intereses: Math.max(0, saldoDe('intereses')), honorarios: Math.max(0, saldoDe('honorarios')), gastos },
    quita: bp.quita, anticipo: bp.anticipo, anticipo_vto: bp.anticipo > 0 ? P.anticipoVto : '', n: bp.n, cada: P.cada, tasa: bp.tasa,
    primer_vto: P.primerVto, caducidad: Math.max(1, parseInt(P.caducidad, 10) || ajustes().caducidad), cuotas: bp.armado.cuotas, nota: (P.nota || '').trim(),
  };
  await conBoton(b, 'Guardando…', async () => {
    try {
      const r = await cambiarDeudor(d.id, (x) => {
        if (x.planes.some((p) => p.estado === 'vigente')) return false; // otro lo cargó mientras tanto
        x.planes.push(plan);
        x.gestiones.push({ id: idNuevo(), creado: ahora(), fecha: dia, tipo: 'Nota', texto: `Plan de pagos acordado: ${planDetalle(plan)}${plan.quita ? `, con una quita de ${plata(plan.quita)}` : ''}.` });
      });
      S.f.plan = null; if (S.f.msg?.propuesta) S.f.msg = null;
      toast(r.sinCambios ? 'Ya tenía un plan vigente: no se guardó otro' : 'Plan guardado'); renderFicha(false, true);
    } catch (e) { toast(mensaje(e)); }
  });
}

async function guardarTasa(campo, el) {
  const d = deudor(S.abierto); if (!d) return;
  const n = porc(el.value), k = campo === 'tasa' ? 'tasa' : 'hon_pct';
  if (!(n >= 0 && n <= 100)) { toast('Escribí un porcentaje entre 0 y 100'); el.value = String(d[k]); S.f[campo] = String(d[k]); return; }
  if (n === +d[k]) return;
  try { await cambiarDeudor(d.id, (x) => { x[k] = n; }); toast(campo === 'tasa' ? 'Tasa guardada' : 'Honorarios guardados'); S.f[campo] = String(n); renderFicha(); } catch (e) { toast(mensaje(e)); }
}

function copiar(texto) {
  navigator.clipboard.writeText(texto).then(() => toast('Copiado'), () => toast('No se pudo copiar en este dispositivo'));
}

// ───────────────────────── Excel ─────────────────────────

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** En el celular abre el menú de compartir (Excel, Drive, WhatsApp…); en la computadora lo descarga. */
async function entregar(blob, archivo) {
  const f = typeof File === 'function' ? new File([blob], archivo, { type: blob.type }) : null;
  if (movil.matches && f && navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: archivo }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: archivo });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
function bajar(hojas, archivo) {
  let blob;
  try { blob = xlsx(hojas); } catch (e) { console.error(e); toast('No se pudo armar el Excel'); return; }
  entregar(blob, archivo).then((ok) => { if (ok) toast('Archivo listo: ' + archivo); }, () => toast('No se pudo descargar el archivo en este dispositivo'));
}

function descargarLiquidacion(d) {
  const L = S.f.liq, liq = liquidar(d, ES_FECHA.test(L.fecha || '') ? L.fecha : hoy(), { aVencer: L.aVencer });
  const cuotas = liq.cuotas.filter((c) => c.incluida || c.pagado > 0);
  const ini = 8, fin = ini + cuotas.length - 1;
  const filas = [
    [{ v: 'Liquidación de deuda', s: 'titulo' }],
    [{ v: d.nombre, s: 'negrita' }],
    [{ v: [d.socio ? `Socio N° ${d.socio}` : '', d.dni ? `DNI ${d.dni}` : '', d.acreedor, operacionTexto(d)].filter(Boolean).join(' · ') }],
    [{ v: 'Liquidada al' }, { v: liq.fecha, fecha: true, s: 'fecha' }],
    [{ v: `Interés simple: ${porciento(d.tasa)} mensual por cada 30 días desde el vencimiento de cada cuota${d.hon_pct ? `; honorarios ${porciento(d.hon_pct)} sobre capital e intereses` : ''}.` }],
    [],
    ['Cuota', 'Vence', 'Importe', 'Pagado', 'Saldo', 'Días', 'Interés'].map((v) => ({ v, s: 'cab' })),
  ];
  cuotas.forEach((c) => filas.push([
    { v: c.n == null ? '' : c.de == null ? `${c.n} (saldo)` : `${c.n} de ${c.de}`, s: 'texto' }, c.vto ? { v: c.vto, fecha: true, s: 'fecha' } : { v: '', s: 'texto' },
    { v: c.importe, s: 'pesos' }, { v: c.pagado, s: 'pesos' }, { v: c.saldo, s: 'pesos' }, { v: c.dias, s: 'texto' }, { v: c.interes, s: 'pesos' },
  ]));
  const t = fin + 1;
  if (cuotas.length) filas.push([{ v: 'Total cuotas', s: 'totTexto' }, { s: 'totTexto' }, ...['C', 'D', 'E'].map((col) => ({ f: `SUM(${col}${ini}:${col}${fin})`, v: suma(cuotas, (c) => ({ C: c.importe, D: c.pagado, E: c.saldo }[col])), s: 'totPesos' })), { s: 'totTexto' }, { f: `SUM(G${ini}:G${fin})`, v: suma(cuotas, (c) => c.interes), s: 'totPesos' }]);
  const r0 = (cuotas.length ? t : fin) + 3;
  filas.push([], [{ v: 'Rubro', s: 'cab' }, { v: 'Devengado', s: 'cab' }, { v: 'Pagado', s: 'cab' }, { v: 'Saldo', s: 'cab' }]);
  liq.rubros.forEach((rb, i) => filas.push([{ v: rb.nombre, s: 'texto' }, { v: rb.devengado, s: 'pesos' }, { v: rb.pagado, s: 'pesos' }, { f: `B${r0 + i}-C${r0 + i}`, v: rb.saldo, s: 'calculo' }]));
  const rf = r0 + liq.rubros.length - 1;
  filas.push([{ v: 'Total', s: 'totTexto' }, ...['B', 'C', 'D'].map((col) => ({ f: `SUM(${col}${r0}:${col}${rf})`, v: { B: liq.total.devengado, C: liq.total.pagado, D: liq.total.saldo }[col], s: 'totPesos' }))]);
  if (d.pagos.length) {
    filas.push([], [{ v: 'Pagos', s: 'negrita' }], [{ v: 'Fecha', s: 'cab' }, { v: 'Recibo', s: 'cab' }, { v: 'Medio', s: 'cab' }, { v: 'Total', s: 'cab' }, { v: 'Imputación', s: 'cab' }]);
    const rubroDe = (k) => liq.rubros.find((x) => x.id === k)?.nombre || (k === 'honorarios' ? 'Honorarios' : k);
    [...d.pagos].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')).forEach((p) => filas.push([
      { v: p.fecha, fecha: true, s: 'fecha' }, { v: p.recibo || '', s: 'texto' }, { v: p.medio || '', s: 'texto' }, { v: totalPago(p), s: 'pesos' },
      { v: Object.entries(p.imp || {}).map(([k, v]) => `${rubroDe(k)} ${plata(+v || 0)}`).join(' · '), s: 'texto' }]));
  }
  filas.push([], [{ v: `Bajada de la app de cobranzas el ${fmtLargo(hoy())}. Los intereses se calculan en la app; los totales, con fórmulas.`, s: 'nota' }]);
  bajar([{ nombre: 'Liquidación', anchos: [30, 14, 16, 16, 16, 8, 16], filas, congelar: { fila: 7 } }], `liquidacion-${slug(d.nombre)}-${liq.fecha}.xlsx`);
}

function textoLiquidacion(d) {
  const L = S.f.liq, liq = liquidar(d, ES_FECHA.test(L.fecha || '') ? L.fecha : hoy(), { aVencer: L.aVencer });
  return [`${d.nombre} — liquidación al ${fmtLargo(liq.fecha)}`, liq.vencidas ? `Debe ${detalleCuotas(liq)}.` : '',
    ...liq.rubros.filter((rb) => rb.saldo).map((rb) => `${rb.nombre}: ${plata(rb.saldo)}`), `Total: ${plata(liq.total.saldo)}`].filter(Boolean).join('\n');
}

function descargarCobros() {
  const xs = cobrosDelMes(S.mes), ini = 5, fin = ini + xs.length - 1;
  const filas = [
    [{ v: `Cobros de ${nombreMes(S.mes)}`, s: 'titulo' }],
    [{ v: `${cuantos(xs.length, 'pago', 'pagos')} · bajado de la app de cobranzas el ${fmtLargo(hoy())}` }],
    [],
    ['Fecha', 'Deudor', 'Socio', 'Recibo', 'Medio', 'Capital', 'Intereses', 'Honorarios', 'Gastos', 'Total'].map((v) => ({ v, s: 'cab' })),
  ];
  xs.forEach((x, i) => { const f = ini + i; filas.push([{ v: x.p.fecha, fecha: true, s: 'fecha' }, { v: x.d.nombre, s: 'texto' }, { v: x.d.socio || '', s: 'texto' }, { v: x.p.recibo || '', s: 'texto' }, { v: x.p.medio || '', s: 'texto' },
    { v: x.capital || null, s: 'pesos' }, { v: x.intereses || null, s: 'pesos' }, { v: x.honorarios || null, s: 'pesos' }, { v: x.gastos || null, s: 'pesos' }, { f: `SUM(F${f}:I${f})`, v: x.total, s: 'calculo' }]); });
  filas.push([{ v: 'Total', s: 'totTexto' }, { s: 'totTexto' }, { s: 'totTexto' }, { s: 'totTexto' }, { s: 'totTexto' }, ...['F', 'G', 'H', 'I', 'J'].map((c) => ({ f: `SUM(${c}${ini}:${c}${fin})`, v: suma(xs, (x) => ({ F: x.capital, G: x.intereses, H: x.honorarios, I: x.gastos, J: x.total }[c])), s: 'totPesos' }))]);
  bajar([{ nombre: 'Cobros', anchos: [12, 34, 9, 12, 14, 15, 15, 15, 15, 16], filas, congelar: { fila: 4 } }], `cobros-${S.mes}.xlsx`);
}

function descargarDeudores() {
  const xs = D.deudores.map((d) => ({ d, r: res(d) })).sort((a, b) => b.r.saldo - a.r.saldo);
  const saldo = (r, id) => r.liq.rubros.find((x) => x.id === id)?.saldo || 0;
  const filas = [
    [{ v: 'Deudores', s: 'titulo' }],
    [{ v: `Al ${fmtLargo(hoy())} · ${cuantos(xs.length, 'deudor', 'deudores')}` }],
    [],
    ['Deudor', 'Socio', 'DNI', 'Teléfono', 'Situación', 'Cuotas vencidas', 'Días de mora', 'Capital', 'Intereses', 'Honorarios y gastos', 'Deuda', 'Saldo exigible', 'Último pago', 'Próxima acción'].map((v) => ({ v, s: 'cab' })),
  ];
  for (const { d, r } of xs) {
    const otros = r.liq.total.saldo - saldo(r, 'capital') - saldo(r, 'intereses'), u = ultimoPago(d, r);
    filas.push([{ v: d.nombre, s: 'texto' }, { v: d.socio || '', s: 'texto' }, { v: d.dni || '', s: 'texto' }, { v: d.telefonos.map((t) => t.numero).join(' / '), s: 'texto' }, { v: r.texto, s: 'texto' },
      { v: r.liq.vencidas ? detalleCuotas(r.liq) : '', s: 'texto' }, { v: r.liq.dias_mora || null, s: 'texto' }, { v: saldo(r, 'capital'), s: 'pesos' }, { v: saldo(r, 'intereses'), s: 'pesos' }, { v: r2(otros), s: 'pesos' },
      { v: r.liq.total.saldo, s: 'pesos' }, { v: r.saldo, s: 'pesos' }, u ? { v: u.fecha, fecha: true, s: 'fecha' } : { v: '', s: 'texto' }, { v: d.proxima || '', s: 'texto' }]);
  }
  bajar([{ nombre: 'Deudores', anchos: [34, 9, 12, 22, 22, 30, 10, 15, 15, 15, 15, 15, 12, 30], filas, congelar: { col: 1, fila: 4 } }], `deudores-${hoy()}.xlsx`);
}

// ───────────────────────── Paneles: nuevo deudor, mensajes, ajustes, contraseña ─────────────────────────

function abrirPanel(p) {
  S.abierto = null; S.f = null; S.confirmar = ''; S.panel = p;
  const aj = ajustes();
  if (p === 'nuevo') S.nuevo = { nombre: '', dni: '', socio: '', telefono: '', domicilio: '', acreedor: aj.acreedor, tasa: String(aj.tasa), hon: '0', tipo: 'Ayuda económica con prenda', numero: '', n0: '1', de: '', vto: '', importe: '', cant: '' };
  if (p === 'ajustes') S.aj = { tasa: String(aj.tasa), contado_pct: String(aj.contado_pct), oferta_dias: String(aj.oferta_dias), gracia: String(aj.gracia), caducidad: String(aj.caducidad), acreedor: aj.acreedor, firma: aj.firma };
  if (p === 'mensajes') S.modelos = {};
  if (p === 'arca') S.arca = { cuit: '', nombre: '', alias: ALIAS_ARCA, generando: false, csr: '', clave: '', bajada: { csr: false, clave: false }, prueba: null };
  renderPanel(true);
}
function renderPanel(entra = false) {
  const box = $('#drawer'), antes = box.querySelector('.panel'), sc = antes && !entra ? antes.scrollTop : 0, foco = guardarFoco(box);
  box.hidden = false; document.body.style.overflow = 'hidden';
  const cuerpo = { nuevo: panelNuevo, mensajes: panelMensajes, ajustes: panelAjustes, clave: panelClave, arca: panelArca }[S.panel]();
  box.innerHTML = `<div class="scrim" data-a="cerrar"></div><aside class="panel${entra ? ' entra' : ''}" role="dialog" aria-modal="true">${cuerpo}<div class="pfin"></div></aside>`;
  if (sc) box.querySelector('.panel').scrollTop = sc;
  devolverFoco(foco);
  if (entra) box.querySelector('input, textarea')?.focus({ preventScroll: true });
}
const cabPanel = (sub, titulo) => `<div class="phead"><div><div class="hint">${esc(sub)}</div><h2>${esc(titulo)}</h2></div><button class="btn small" data-a="cerrar">Cerrar</button></div>`;

function cuotasDelNuevo(N) {
  const n0 = parseInt(N.n0, 10) || 1, de = parseInt(N.de, 10) || null, cantPedida = parseInt(N.cant, 10);
  const cant = cantPedida > 0 ? cantPedida : de && de >= n0 ? de - n0 + 1 : 1;
  if (!ES_FECHA.test(N.vto || '') || !(importe(N.importe) > 0)) return [];
  return Array.from({ length: Math.min(cant, 120) }, (_, k) => ({ id: idNuevo(), op: '', n: n0 + k, de, vto: sumarMeses(N.vto, k), importe: importe(N.importe), doc: '' }));
}
function panelNuevo() {
  const N = S.nuevo, qs = cuotasDelNuevo(N), dia = hoy(), venc = qs.filter((q) => q.vto <= dia).length;
  return `${cabPanel('Cobranzas', 'Nuevo deudor')}
  <div class="sec"><h4>Deudor</h4><div class="grid2">
    <label class="f ancho">Apellido y nombre<input ${atar('nuevo.nombre')} placeholder="Como figura en la operación"></label>
    <label class="f">DNI / CUIT<input ${atar('nuevo.dni')}></label>
    <label class="f">N° de socio<input ${atar('nuevo.socio')}></label>
    <label class="f">Celular<input ${atar('nuevo.telefono')} inputmode="tel" placeholder="Con código de área, sin 0 ni 15"></label>
    <label class="f">Acreedor<input ${atar('nuevo.acreedor')}></label>
    <label class="f ancho">Domicilio<input ${atar('nuevo.domicilio')}></label>
    <label class="f">Interés (% mensual)<input ${atar('nuevo.tasa')} inputmode="decimal"></label>
    <label class="f">Honorarios (%)<input ${atar('nuevo.hon')} inputmode="decimal"></label>
  </div></div>
  <div class="sec"><h4>Operación y cuotas impagas</h4><div class="grid2">
    <label class="f">Tipo<select data-k="nuevo.tipo">${opciones(TIPOS_OPERACION, N.tipo)}</select></label>
    <label class="f">N° de operación<input ${atar('nuevo.numero')}></label>
    <label class="f">Primera cuota impaga N°<input ${atar('nuevo.n0')} inputmode="numeric" data-vista="1"></label>
    <label class="f">De (total de cuotas)<input ${atar('nuevo.de')} inputmode="numeric" data-vista="1"></label>
    <label class="f">Vence la primera impaga<input type="date" ${atar('nuevo.vto')} data-vista="1"></label>
    <label class="f">Importe de cada cuota ($)<input ${atar('nuevo.importe')} inputmode="decimal" data-importe data-vista="1"></label>
    <label class="f">Cuántas cargar<input ${atar('nuevo.cant')} inputmode="numeric" placeholder="Hasta la última" data-vista="1"></label>
  </div>
  <p class="hint m0" id="nuevoVista">${qs.length ? `Se cargan ${esc(cuantos(qs.length, 'cuota', 'cuotas'))} (${qs[0].n}${qs.length > 1 ? ' a ' + qs[qs.length - 1].n : ''}${qs[0].de ? ' de ' + qs[0].de : ''}): ${esc(cuantos(venc, 'vencida', 'vencidas'))} y ${esc(cuantos(qs.length - venc, 'a vencer', 'a vencer'))}.` : 'Con el vencimiento y el importe se arman las cuotas mensuales; después se pueden corregir en “Datos”.'}</p></div>
  <div class="ppie"><button class="btn primary" data-a="nuevo-crear">Crear deudor</button><button class="btn" data-a="cerrar">Cancelar</button></div>`;
}
async function crearNuevo(b) {
  const N = S.nuevo, nombreN = (N.nombre || '').trim();
  if (!nombreN) { toast('Falta el nombre'); return; }
  const tasa = porc(N.tasa), hon = porc(N.hon);
  if (!(tasa >= 0 && tasa <= 100) || !(hon >= 0 && hon <= 100)) { toast('Revisá el interés y los honorarios'); return; }
  const op = { id: idNuevo(), tipo: N.tipo, numero: (N.numero || '').trim(), fecha: '', cuotas: parseInt(N.de, 10) || null, importe: importe(N.importe), concesionaria: '', vehiculo: { marca: '', modelo: '', anio: '', dominio: '' }, ultimo_pago: '', nota: '' };
  const cuotas = cuotasDelNuevo(N).map((q) => ({ ...q, op: op.id }));
  const fila = {
    nombre: nombreN.toUpperCase(), dni: (N.dni || '').trim(), socio: (N.socio || '').trim(), domicilio: (N.domicilio || '').trim(), acreedor: (N.acreedor || '').trim(),
    telefonos: (N.telefono || '').trim() ? [{ numero: N.telefono.trim(), nota: '' }] : [], tasa, hon_pct: hon,
    operaciones: op.numero || cuotas.length ? [op] : [], cuotas, gestiones: [{ id: idNuevo(), creado: ahora(), fecha: hoy(), tipo: 'Nota', texto: 'Alta del deudor en cobranzas.' }],
  };
  await conBoton(b, 'Creando…', async () => {
    try { const d = await crearDeudor(fila); toast('Deudor creado'); S.nuevo = null; abrirDeudor(d.id, 'resumen'); } catch (e) { toast(mensaje(e)); }
  });
}

function panelMensajes() {
  const item = (m) => { const k = m.id || 'nuevo', e = S.modelos[k] || { titulo: m.titulo || '', cuerpo: m.cuerpo || '' }; S.modelos[k] = e;
    return `<div class="sec"><h4>${m.id ? 'Modelo' : 'Nuevo modelo'}</h4>
    <label class="f">Título<input ${atar(`modelos.${k}.titulo`)} placeholder="Ej.: Segundo aviso"></label>
    <label class="f">Texto<textarea rows="${m.id ? 9 : 6}" data-k="modelos.${esc(k)}.cuerpo" placeholder="Hola {{nombre}}…">${esc(e.cuerpo)}</textarea></label>
    <div class="actions"><button class="btn small primary" data-a="modelo-guardar" data-id="${esc(m.id || '')}">${m.id ? 'Guardar cambios' : 'Crear modelo'}</button>
    ${m.id ? (S.confirmar === 'modelo:' + m.id ? `<button class="btn small danger" data-a="modelo-borrar" data-id="${esc(m.id)}">Sí, eliminar</button><button class="btn small" data-a="no">Cancelar</button>` : `<button class="btn small danger" data-a="confirmar" data-que="modelo:${esc(m.id)}">Eliminar</button>`) : ''}</div></div>`; };
  return `${cabPanel('WhatsApp', 'Modelos de mensaje')}
  <details class="sec ayuda"><summary>Campos que se completan solos</summary><ul class="campos">${CAMPOS_MENSAJE.map(([k, t]) => `<li><code>{{${esc(k)}}}</code> ${esc(t)}</li>`).join('')}</ul>
    <p class="hint m0">En la etapa extrajudicial, nada que parezca un reclamo judicial ni que intimide (art. 8 bis, Ley 24.240).</p></details>
  ${D.modelos_mensaje.map(item).join('')}${item({})}`;
}
async function accionModelo(a, b) {
  const id = b.dataset.id || '';
  if (a === 'modelo-borrar') { S.confirmar = ''; try { await borrarModelo(id); delete S.modelos[id]; toast('Modelo eliminado'); } catch (e) { toast(mensaje(e)); } renderPanel(); return; }
  const k = id || 'nuevo', e = S.modelos[k] || {}, titulo = (e.titulo || '').trim(), cuerpo = e.cuerpo || '';
  if (!titulo || !cuerpo.trim()) { toast('Completá título y texto'); return; }
  await conBoton(b, 'Guardando…', async () => {
    try {
      if (!id) { await crearModelo({ titulo, cuerpo, orden: Math.max(0, ...D.modelos_mensaje.map((m) => m.orden || 0)) + 1 }); delete S.modelos.nuevo; toast('Modelo creado'); }
      else { const m = D.modelos_mensaje.find((x) => x.id === id); const r = await guardarModelo(id, m?.rev, { titulo, cuerpo }); delete S.modelos[id]; toast(r.conflicto ? 'El modelo cambió recién: revisalo y probá de nuevo' : 'Modelo guardado'); }
    } catch (err) { toast(mensaje(err)); }
  });
  renderPanel();
}

function panelAjustes() {
  return `${cabPanel('Cobranzas', 'Ajustes')}
  <div class="sec"><h4>Intereses</h4><div class="grid2">
    <label class="f">Interés de los deudores nuevos (% mensual simple)<input ${atar('aj.tasa')} inputmode="decimal"></label>
  </div><p class="hint m0">Cada deudor tiene su propia tasa (en su liquidación).</p></div>
  <div class="sec"><h4>Ofertas y planes</h4><div class="grid2">
    <label class="f">Oferta de contado (% de la deuda)<input ${atar('aj.contado_pct')} inputmode="decimal"></label>
    <label class="f">La oferta vale (días)<input ${atar('aj.oferta_dias')} inputmode="numeric"></label>
    <label class="f">Días de gracia de una cuota de plan<input ${atar('aj.gracia')} inputmode="numeric"></label>
    <label class="f">El plan cae con … cuotas impagas<input ${atar('aj.caducidad')} inputmode="numeric"></label>
  </div></div>
  <div class="sec"><h4>Mensajes</h4><div class="grid2">
    <label class="f">Acreedor de los deudores nuevos<input ${atar('aj.acreedor')}></label>
    <label class="f">Firma<input ${atar('aj.firma')}></label>
  </div></div>
  <div class="ppie"><button class="btn primary" data-a="ajustes-guardar">Guardar ajustes</button><button class="btn" data-a="cerrar">Cancelar</button></div>`;
}
async function guardarAjustesPanel(b) {
  const A = S.aj, ent = (s) => parseInt(s, 10);
  const campos = { tasa: porc(A.tasa), contado_pct: porc(A.contado_pct), oferta_dias: ent(A.oferta_dias), gracia: ent(A.gracia), caducidad: ent(A.caducidad), acreedor: (A.acreedor || '').trim(), firma: (A.firma || '').trim() };
  if (!(campos.tasa >= 0 && campos.tasa <= 100)) { toast('La tasa va de 0 a 100'); return; }
  if (!(campos.contado_pct > 0 && campos.contado_pct <= 100)) { toast('La oferta de contado va de 1 a 100%'); return; }
  if (!(campos.oferta_dias >= 1 && campos.oferta_dias <= 90) || !(campos.gracia >= 0 && campos.gracia <= 60) || !(campos.caducidad >= 1 && campos.caducidad <= 24)) { toast('Revisá los días y las cuotas'); return; }
  await conBoton(b, 'Guardando…', async () => {
    try { const r = await guardarAjustes(ajustes().rev, campos); toast(r.conflicto ? 'Los ajustes cambiaron recién: revisalos y probá de nuevo' : 'Ajustes guardados'); if (!r.conflicto) cerrarFicha(); }
    catch (e) { toast(mensaje(e)); }
  });
}

function panelClave() {
  return `${cabPanel(D.usuario?.email || '', 'Cambiar contraseña')}
   <form id="fClaveMenu" class="sec" novalidate>
    <input type="email" autocomplete="username" value="${esc(D.usuario?.email || '')}" hidden>
    <label class="f">Contraseña nueva<input id="n_clave" type="password" autocomplete="new-password"></label>
    <label class="f">Repetila<input id="n_clave2" type="password" autocomplete="new-password"></label>
    <p class="hint m0">De ${CLAVE_MIN} caracteres o más. Es la misma del gestor de juicios: cambia para las dos apps.</p>
    <p class="malo m0" id="i_error" role="alert" hidden></p>
    <div class="actions"><button class="btn primary" type="submit">Guardar contraseña</button><button class="btn" type="button" data-a="cerrar">Cancelar</button></div>
   </form>`;
}

// ───────────────────────── Certificado de ARCA ─────────────────────────
// Arma en este navegador la clave y la solicitud del certificado para el padrón de ARCA (certificado.js).
// La clave queda solo en memoria mientras el panel está abierto: no se guarda en el dispositivo ni se
// manda a ningún lado, y al cerrar el panel se olvida.

const AYUDA_ARCA_CUIT = 'Es el CUIT con el que vas a entrar a ARCA para subir la solicitud.';
function panelArca() {
  const A = S.arca, aviso = avisoCuit(A.cuit), listo = !!A.csr, bloqueo = listo ? ' disabled' : '';
  const datos = `<form id="fArca" class="sec" novalidate>
    <label class="f">CUIT<input id="arca_cuit" ${atar('arca.cuit')} inputmode="numeric" autocomplete="off" placeholder="Ej.: 20-12345678-6" maxlength="20"${bloqueo}></label>
    <p class="hint m0${aviso.mal ? ' malo' : ''}" id="arca_aviso" aria-live="polite">${esc(aviso.texto || AYUDA_ARCA_CUIT)}</p>
    <label class="f">Nombre o razón social<input id="arca_nombre" ${atar('arca.nombre')} autocomplete="off" placeholder="Como figura en ARCA" maxlength="64"${bloqueo}></label>
    <label class="f">Alias del certificado<input id="arca_alias" ${atar('arca.alias')} autocomplete="off" maxlength="50"${bloqueo}></label>
    <p class="hint m0">Solo letras y números. Es el nombre que vas a escribir en ARCA al subir la solicitud.</p>
    ${listo ? '' : `<div class="actions"><button class="btn primary" type="submit" id="arca_ir"${A.generando ? ' disabled' : ''}>${A.generando ? 'Generando…' : 'Generar los archivos'}</button></div>`}
  </form>`;
  const boton = (que, texto) => `<button class="btn${A.bajada[que] ? '' : ' primary'}" data-a="arca-${que}">${texto}</button>${A.bajada[que] ? '<span class="hint">Descargada</span>' : ''}`;
  const archivos = listo ? `<div class="nota"><p><b>Listo. Descargá los dos archivos:</b></p>
    <div class="actions">${boton('csr', 'Descargar solicitud (.csr)')}${boton('clave', 'Descargar clave (.key)')}</div>
    <p class="hint m0">Van a la carpeta de descargas. La clave no queda guardada en ningún otro lado: si cerrás este panel sin bajarla, hay que generar los dos de nuevo.</p>
    ${A.bajada.csr && A.bajada.clave ? `<p class="m0">Ahora, en ARCA: «Administración de Certificados Digitales» → «Agregar alias» → alias <b>${esc(A.alias)}</b> → elegí el archivo <b>${esc(A.alias)}.csr</b> → «Agregar alias».</p>` : ''}</div>` : '';
  const P = A.prueba;
  const conexion = `<div class="sec"><h4>Conexión</h4>
    <p class="m0">Con el certificado cargado, cada consulta por CUIT trae también la constancia de inscripción de ARCA.</p>
    <div class="actions"><button class="btn primary" data-a="arca-probar"${P?.probando ? ' disabled' : ''}>${P?.probando ? 'Probando…' : 'Probar la conexión con ARCA'}</button></div>
    ${P?.ok ? `<div class="nota"><p><b>Conectado.</b> ARCA respondió con los datos de ${esc(P.ok.nombre || 'tu CUIT')} (CUIT ${esc(cuitTexto(P.ok.cuit))}).</p>
      <p class="hint m0">Certificado ${esc(P.ok.alias)}, vence el ${esc(fmtLargo(String(P.ok.vence).slice(0, 10)))}.</p></div>` : ''}
    ${P?.error ? `<p class="aviso-chico" role="alert">${esc(P.error)}</p>` : ''}</div>`;
  return `${cabPanel('Aprobación de créditos', 'Certificado de ARCA')}
  ${conexion}
  <div class="sec"><h4>Pedir un certificado</h4><p class="m0">ARCA da los certificados por dos años. Para pedir uno (la primera vez, o para renovarlo), acá se arman los dos archivos. Hacelo en la computadora con la que entrás a ARCA.</p>
    <ul class="campos">
      <li><b>La solicitud (.csr)</b> se sube a ARCA. No es secreta.</li>
      <li><b>La clave (.key)</b> es secreta: guardala en la compu y no la mandes por chat ni por mail. Se pega una sola vez en Supabase.</li>
    </ul></div>
  ${datos}${archivos}`;
}
async function probarArcaPanel() {
  const A = S.arca;
  if (!A || A.prueba?.probando) return;
  A.prueba = { probando: true }; renderPanel();
  try {
    const r = await probarArca();
    if (S.arca === A) A.prueba = { ok: r };
  } catch (e) {
    if (S.arca === A) A.prueba = { error: e.sinSesion ? mensaje(e) : e.message || 'No se pudo probar la conexión con ARCA' };
  }
  if (S.arca === A && S.panel === 'arca') renderPanel();
}
function actualizarArca() {
  const a = avisoCuit(S.arca?.cuit), p = $('#arca_aviso');
  if (p) { p.textContent = a.texto || AYUDA_ARCA_CUIT; p.classList.toggle('malo', !!a.mal); }
}
async function generarArca() {
  const A = S.arca;
  if (!A || A.generando || A.csr) return;
  A.generando = true; renderPanel();
  try {
    const alias = String(A.alias || '').trim(), r = await armarSolicitud({ cuit: A.cuit, nombre: A.nombre, alias });
    Object.assign(A, { csr: r.csr, clave: r.clave, alias });
    toast('Archivos listos para descargar');
  } catch (e) {
    toast(e.message || 'No se pudieron generar los archivos');
  } finally {
    A.generando = false;
    if (S.arca === A && S.panel === 'arca') renderPanel();
  }
}
/** Descarga directa, sin el menú de compartir del celular: la clave no tiene que terminar en un chat. */
function bajarArca(act) {
  const A = S.arca;
  if (!A?.csr) return;
  const que = act === 'arca-csr' ? 'csr' : 'clave';
  const url = URL.createObjectURL(new Blob([que === 'csr' ? A.csr : A.clave], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${A.alias}.${que === 'csr' ? 'csr' : 'key'}` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  A.bajada[que] = true;
  toast(que === 'csr' ? 'Solicitud descargada' : 'Clave descargada');
  renderPanel();
}

// ───────────────────────── Cuenta ─────────────────────────

const instalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function renderMenu() {
  const m = $('#menu'); m.hidden = !S.menu; $('#btnCuenta')?.setAttribute('aria-expanded', S.menu);
  if (!S.menu) { m.innerHTML = ''; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !instalada();
  const sinc = !D.enLinea ? 'Sin conexión' : D.enVivo ? 'Sincronizado en vivo' : D.leido ? 'Actualizado ' + cuando(D.leido) : 'Conectando…';
  m.innerHTML = `<div class="scrim claro" data-m="cerrar"></div>
  <div class="menu" role="menu" aria-label="Cuenta y opciones">
   <div class="menu-quien"><b>${esc(D.acceso?.nombre || 'Mi cuenta')}</b><span class="hint">${esc(D.usuario?.email || '')}</span></div>
   <button class="op solo-movil" role="menuitem" data-m="mensajes">Modelos de mensaje</button>
   <button class="op solo-movil" role="menuitem" data-m="ajustes">Ajustes</button>
   <button class="op" role="menuitem" data-m="exportar">Descargar deudores en Excel</button>
   <button class="op" role="menuitem" data-m="arca">Certificado de ARCA</button>
   <a class="op" role="menuitem" href="${JUICIOS}" target="_blank" rel="noopener">Abrir el gestor de juicios</a>
   ${S.instalar ? '<button class="op" role="menuitem" data-m="instalar">Instalar la app en este dispositivo</button>' : ''}
   ${ios ? '<div class="menu-pie hint">Para instalarla en el iPhone: abrila en Safari, tocá Compartir y después “Agregar a inicio”.</div>' : ''}
   <button class="op" role="menuitem" data-m="clave">Cambiar contraseña</button>
   <button class="op" role="menuitem" data-m="salir">Cerrar sesión</button>
   <div class="menu-pie hint">${sinc}. Al cerrar sesión se borra la copia guardada en este dispositivo (y también se cierra el gestor de juicios).<br>Versión ${VERSION}</div>
  </div>`;
}
async function menuAct(b) {
  const a = b.dataset.m; S.menu = false; renderMenu();
  if (['mensajes', 'ajustes', 'clave', 'arca'].includes(a)) { abrirPanel(a); if (a === 'clave') $('#n_clave')?.focus(); return; }
  if (a === 'exportar') { descargarDeudores(); return; }
  if (a === 'instalar' && S.instalar) { const ev = S.instalar; S.instalar = null; ev.prompt(); return; }
  if (a === 'salir') { await salir(); mostrar('ingreso'); toast('Sesión cerrada'); }
}

// ───────────────────────── Eventos ─────────────────────────

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const boton = e.target.querySelector('[type=submit]');
  if (e.target.id === 'fIngreso') {
    const email = $('#i_email').value.trim(), clave = $('#i_clave').value;
    if (!email || !clave) { errorIngreso('Completá el email y la contraseña'); return; }
    errorIngreso('');
    await conBoton(boton, 'Ingresando…', async () => {
      try { mostrar(await entrar(email, clave)); } catch (err) { errorIngreso(mensaje(err, 'no se pudo ingresar')); }
    });
  } else if (e.target.id === 'fCredito') {
    await consultarCuit(S.cred.cuit);
  } else if (e.target.id === 'fCheque') {
    await consultarChequeDe(S.cred.entidad, S.cred.numero);
  } else if (e.target.id === 'fArca') {
    await generarArca();
  } else if (e.target.id === 'fClave' || e.target.id === 'fClaveMenu') {
    const a = $('#n_clave').value, problema = claveValida(a, $('#n_clave2').value);
    if (problema) { errorIngreso(problema); return; }
    errorIngreso('');
    await conBoton(boton, 'Guardando…', async () => {
      try {
        const pantalla = await cambiarClave(a);
        if (e.target.id === 'fClaveMenu') { cerrarFicha(); toast('Contraseña guardada'); } else mostrar(pantalla);
      } catch (err) { errorIngreso(mensaje(err, 'no se pudo guardar la contraseña')); }
    });
  }
});

// Un botón que guarda no se puede volver a apretar hasta que termine.
async function unaVez(boton, tarea) {
  if (boton.disabled) return;
  boton.disabled = true;
  try { await tarea(boton); } finally { if (boton.isConnected) boton.disabled = false; }
}
const verVista = (v) => { S.vista = v; try { localStorage.setItem('cb.vista', v); } catch { /* sin almacenamiento */ } render(); window.scrollTo(0, 0); };

document.addEventListener('click', async (e) => {
  const t = e.target;
  const ing = t.closest('[data-ing]');
  if (ing) { if (ing.dataset.ing === 'salir') { await salir(); mostrar('ingreso'); } else await reintentar(ing); return; }
  if (t.closest('#btnReintentar')) { await reintentar(t.closest('#btnReintentar')); if (D.enLinea) toast('Conexión recuperada'); return; }
  const mn = t.closest('[data-m]'); if (mn) { if (mn.dataset.m === 'cerrar') { S.menu = false; renderMenu(); } else await menuAct(mn); return; }
  const ir = t.closest('[data-ir]'); if (ir) { const [v, chip] = ir.dataset.ir.split(':'); if (chip) { S.chip = chip; S.tramo = ''; } verVista(v); return; }
  const tr = t.closest('[data-tramo]'); if (tr) { S.chip = 'mora'; S.tramo = tr.dataset.tramo; S.orden = 'mora'; verVista('deudores'); return; }
  if (t.closest('[data-tramo-x]')) { S.tramo = ''; render(); return; }
  const ch = t.closest('[data-chip]'); if (ch) { S.chip = ch.dataset.chip; S.tramo = ''; render(); return; }
  const ms = t.closest('[data-mes]'); if (ms) { S.mes = mesMas(S.mes, +ms.dataset.mes); render(); return; }
  const tab = t.closest('[data-tab-ir]'); if (tab) { irATab(tab.dataset.tabIr); return; }
  const ab = t.closest('[data-abrir]'); if (ab) { e.stopPropagation(); abrirDeudor(ab.dataset.abrir, ab.dataset.tab || 'resumen', ab.dataset.con || ''); return; }
  const cq = t.closest('[data-consulta]'); if (cq) { await abrirConsulta(cq.dataset.consulta); return; }
  const cm = t.closest('[data-cr-modo]'); if (cm) { cambiarModo(cm.dataset.crModo); return; }
  const chq = t.closest('[data-cheque]'); if (chq) { abrirCheque(chq.dataset.cheque); return; }
  const a = t.closest('[data-a]'); if (!a) return;
  const act = a.dataset.a;
  if (act === 'cerrar') { cerrarFicha(); return; }
  if (act === 'excel-cobros') { descargarCobros(); return; }
  if (act.startsWith('cr-') && !S.panel && !S.abierto) {
    if (act === 'cr-copiar') { accionCredito(act, a); return; } // sin esperas: el portapapeles lo pide así
    await unaVez(a, (b) => accionCredito(act, b)); return;
  }
  if (act.startsWith('ch-') && !S.panel && !S.abierto) {
    if (act === 'ch-copiar') { accionCheque(act, a); return; } // ídem
    await unaVez(a, (b) => accionCheque(act, b)); return;
  }
  if (S.panel) {
    if (act === 'arca-csr' || act === 'arca-clave') { bajarArca(act); return; } // sin esperas: la descarga lo pide así
    if (act === 'arca-probar') { await probarArcaPanel(); return; }
    if (act === 'nuevo-crear') { await unaVez(a, crearNuevo); return; }
    if (act === 'ajustes-guardar') { await unaVez(a, guardarAjustesPanel); return; }
    if (act === 'modelo-guardar' || act === 'modelo-borrar') { await unaVez(a, (b) => accionModelo(act, b)); return; }
    if (act === 'confirmar') { S.confirmar = a.dataset.que; renderPanel(); return; }
    if (act === 'no') { S.confirmar = ''; renderPanel(); return; }
    return;
  }
  if (!S.abierto) return;
  if (act === 'msg-abrir') { if (!S.f?.msg?.numero) { e.preventDefault(); return; } actualizarEnlace(); accionFicha(act, a); return; } // sin esperar: el enlace se abre igual
  if (act === 'excel-liq') { accionFicha(act, a); return; } // antes de cualquier espera: el menú de compartir del celular lo exige
  await unaVez(a, (b) => accionFicha(act, b));
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'q') { S.q = el.value; render(); return; }
  const k = el.dataset?.k; if (!k) return;
  poner(k, el.type === 'checkbox' ? el.checked : el.value);
  if (k === 'cred.cuit') { actualizarCuit(); return; }
  if (k === 'arca.cuit') { actualizarArca(); return; }
  if (k === 'cred.numero' || k === 'cred.entidad') { actualizarCheque(); return; }
  if (k === 'cred.filtro' || k === 'cred.chFiltro') { render(); return; }
  if (el.dataset.re) return; // fechas, casillas y listas: se redibuja con "change"
  if (k.startsWith('f.pago.')) actualizarPie();
  else if (k.startsWith('f.plan.')) {
    // Quita en % o en pesos: al escribir una, la otra se borra (vale la última que se escribió).
    if (k === 'f.plan.quitaPct') { S.f.plan.quitaMonto = ''; const o = $('#pl_qm'); if (o) o.value = ''; }
    if (k === 'f.plan.quitaMonto') { S.f.plan.quitaPct = ''; const o = $('#pl_qp'); if (o) o.value = ''; }
    actualizarVistaPlan();
  } else if (k === 'f.msg.texto') actualizarEnlace();
  else if (k.startsWith('nuevo.') && el.dataset.vista) { const N = S.nuevo, qs = cuotasDelNuevo(N), venc = qs.filter((q) => q.vto <= hoy()).length, p = $('#nuevoVista'); if (p) p.textContent = qs.length ? `Se cargan ${cuantos(qs.length, 'cuota', 'cuotas')} (${qs[0].n}${qs.length > 1 ? ' a ' + qs[qs.length - 1].n : ''}${qs[0].de ? ' de ' + qs[0].de : ''}): ${cuantos(venc, 'vencida', 'vencidas')} y ${qs.length - venc} a vencer.` : 'Con el vencimiento y el importe se arman las cuotas mensuales; después se pueden corregir en “Datos”.'; }
});
document.addEventListener('change', (e) => {
  const el = e.target, k = el.dataset?.k;
  if (el.id === 'fOrden') { S.orden = el.value; render(); return; }
  if (el.id === 'f_tasa' || el.id === 'f_hon') { guardarTasa(el.id === 'f_tasa' ? 'tasa' : 'hon', el); return; }
  if (!k) return;
  poner(k, el.type === 'checkbox' ? el.checked : el.value);
  if (k === 'cred.entidad') { actualizarCheque(); return; } // por si el navegador no avisa con "input"
  if (k === 'f.msg.modelo') { const d = deudor(S.abierto); S.f.msg.propuesta = S.f.msg.propuesta && el.value === 'plan'; S.f.msg.texto = S.f.msg.base = generar(d, S.f.msg); renderFicha(); return; }
  if (k === 'f.msg.numero') { actualizarEnlace(); return; }
  if (el.dataset.re) rerender();
});
// Importes: al entrar se selecciona lo escrito (escribir lo reemplaza) y al salir queda con el formato de miles.
document.addEventListener('focusin', (e) => { if (e.target.matches?.('input[data-importe]')) e.target.select(); });
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el.matches?.('input[data-importe]') || !el.value.trim()) return;
  el.value = enCelda(importe(el.value));
  if (el.dataset.k) poner(el.dataset.k, el.value);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (S.menu) { S.menu = false; renderMenu(); return; }
    if (S.abierto || S.panel) { cerrarFicha(); return; }
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('#main [data-abrir]') && !e.target.matches('button')) { e.preventDefault(); abrirDeudor(e.target.dataset.abrir, e.target.dataset.tab || 'resumen'); }
});
$('#fOrden').innerHTML = opciones([['deuda', 'Mayor deuda'], ['mora', 'Más días de mora'], ['proximo', 'Lo más urgente'], ['pago', 'Último pago más viejo'], ['nombre', 'Nombre (A–Z)']], S.orden);
for (const v of Object.keys(VISTAS)) $('#v_' + v).onclick = () => verVista(v);
$('#btnNuevo').onclick = $('#fabNuevo').onclick = () => abrirPanel('nuevo');
$('#btnMensajes').onclick = () => abrirPanel('mensajes');
$('#btnAjustes').onclick = () => abrirPanel('ajustes');
$('#btnCuenta').onclick = () => { S.menu = !S.menu; renderMenu(); };
movil.addEventListener('change', () => render());

// Cambios que llegan de la base: los propios, los de Claude o los de otro dispositivo.
alCambiar((que, detalle) => {
  if (que === 'sesion') { if (detalle !== S.pantalla) mostrar(detalle); else if (detalle === 'listo') render(); return; }
  if (S.pantalla !== 'listo') return;
  if (que === 'estado') { renderFranja(); if (S.menu) renderMenu(); return; }
  render();
  if (S.abierto) { if (deudor(S.abierto)) renderFicha(); else { cerrarFicha(); toast('Ese deudor fue eliminado desde otro lugar'); } }
  else if (S.panel === 'mensajes') renderPanel();
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; if (S.menu) renderMenu(); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('App instalada'); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin él */ });

(async () => {
  try { mostrar(await iniciar()); } catch (e) { console.error(e); S.falla = mensaje(e, 'no se pudo abrir'); mostrar('error'); }
})();
