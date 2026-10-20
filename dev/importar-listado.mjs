// Pasa el listado "PRENDARIOS · DOCUMENTOS VENCIDOS" del sistema de la Asociación Mutual Bell
// (Crystal Reports, impreso a PDF) a deudores de la app de cobranzas.
//
//   pdftotext -layout listado.pdf - | node dev/importar-listado.mjs            → JSON, para revisar
//   pdftotext -layout listado.pdf - | node dev/importar-listado.mjs --sql      → SQL para execute_sql
//
// El SQL agrega solo los socios que todavía no están en la base (no toca a los que ya se gestionan:
// sus pagos y planes viven en la app). Los datos personales no se guardan en este repositorio:
// el listado y lo que sale de acá van directo a la base.
//
// Qué se toma de cada deudor: nombre, N° de socio, domicilio y teléfonos, cada operación (N° de
// liquidación, fecha, concesionaria, vehículo, último pago) y cada documento vencido como una cuota
// (N de M, vencimiento e importe; los DOCUMENTO-R son saldos de cuotas pagadas en parte). Con el
// "de M" y el importe se agregan también las cuotas que faltan vencer, mes a mes. Los intereses del
// listado no se copian: la app los calcula; quedan anotados en una gestión para comparar.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const id = () => randomBytes(4).toString('hex');
const fecha = (s) => { const [d, m, a] = s.split('/'); return `${a.length === 2 ? '20' + a : a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
const num = (s) => Number(String(s).replace(/,/g, ''));
const pesos = (n) => '$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
function sumarMeses(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + k, 1));
  const ultimo = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, ultimo));
  return base.toISOString().slice(0, 10);
}
const MAYUS = (s) => s.replace(/\s+/g, ' ').trim().toUpperCase();

// Un documento: lo de la izquierda varía (fecha, último pago, tipo, liquidación, socio, nombre);
// lo de la derecha es fijo (N de M, vencimiento, días, cantidad, importe, intereses, total).
const COLA = /\s(\d+)\s+de\s+(\d+)\s+(\d{2}\/\d{2}\/\d{2})\s+(\d+)\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/;
const CABEZA = /^\s*(\d{2}\/\d{2}\/\d{2})\s+(?:(\d{2}\/\d{2}\/\d{2})\s+)?(DOCUMENTO(?:-R)?)\s+(\d+)\s*(.*)$/;
const LIQUID = /Liquid\.:\s*(\d+)\s+Concec:\s*(.*?)\s+Marca:\s*(.*?)\s+Modelo:\s*(.*?)\s+Ano:\s*(\d*)\s+Dominio:\s*(\S*)/;

export function leerListado(texto) {
  const lineas = texto.split(/\r?\n/);
  const corte = (texto.match(/DOCUMENTOS VENCIDOS HASTA EL (\d{2}\/\d{2}\/\d{2})/) || [])[1];
  const deudores = [];
  let d = null, despuesDeDireccion = false;

  for (const crudo of lineas) {
    const l = crudo.replace(/\f/g, '');
    if (!l.trim() || /^\s*(Fecha:|\*\* PRENDARIOS|DOCUMENTOS VENCIDOS|Fecha\s+U\.P)/.test(l) || /^\s*Total:/.test(l)) continue;
    const cola = COLA.exec(l), cab = cola && CABEZA.exec(l.slice(0, cola.index));
    if (cab) {
      const [, f, up, tipo, liq, resto] = cab;
      if (up) { // primera línea de un deudor: trae el último pago y el N° de socio
        const m = /^(\d+)\s+(.*)$/.exec(resto.trim());
        d = { socio: m ? m[1] : '', partes: [m ? m[2] : resto], docs: [], liquid: {}, ultimo_pago: fecha(up), direccion: '', obs: '', control: null };
        deudores.push(d); despuesDeDireccion = false;
      } else if (d && resto.trim()) d.partes.push(resto);
      if (!d) throw new Error('Documento sin deudor: ' + l);
      d.docs.push({ fecha: fecha(f), tipo, liq, n: +cola[1], de: +cola[2], vto: fecha(cola[3]), dias: +cola[4], importe: num(cola[6]), intereses: num(cola[7]), total: num(cola[8]) });
      continue;
    }
    if (!d) continue;
    const tot = /^\s*([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/.exec(l);
    if (tot) { d.control = { importe: num(tot[1]), intereses: num(tot[2]), total: num(tot[3]) }; continue; }
    const dir = /Direccion y Tel\.:\s*(.*?)\s*(?:LEGALES)?\s*$/i.exec(l);
    if (dir) { d.direccion = dir[1]; despuesDeDireccion = true; continue; }
    const lq = LIQUID.exec(l);
    if (lq) { d.liquid[lq[1]] = { concesionaria: lq[2].trim(), marca: lq[3].trim(), modelo: lq[4].trim(), anio: lq[5] === '0' ? '' : lq[5], dominio: lq[6].trim() }; continue; }
    if (/^\s*legales\b/i.test(l)) { if (despuesDeDireccion) d.obs = MAYUS(l); continue; }
    if (!despuesDeDireccion && /^\s+[A-ZÑÁÉÍÓÚÜ][A-ZÑÁÉÍÓÚÜ .'-]*$/.test(l)) { d.partes.push(l); continue; } // sigue el nombre
  }
  return { corte: corte ? fecha(corte) : '', deudores: deudores.map((x) => armar(x, corte ? fecha(corte) : '')) };
}

/** "CALLE FALSA 123 - 03537-400100 3537000111" → domicilio y teléfonos (con lo que los acompaña como nota). */
function telefonos(texto) {
  const i = texto.indexOf(' - ');
  const domicilio = (i >= 0 ? texto.slice(0, i) : texto).trim(), resto = i >= 0 ? texto.slice(i + 3) : '';
  const ts = resto.replace(/NO POSEE/g, ' ').split(/\s+/).filter(Boolean);
  const unidos = [];
  for (let k = 0; k < ts.length; k++) {
    // "3537 55-9957": código de área suelto y el número partido
    if (/^3\d{3}$/.test(ts[k]) && ts[k + 1] && /^[\d-]{5,}$/.test(ts[k + 1])) { unidos.push(ts[k] + ' ' + ts[k + 1]); k++; } else unidos.push(ts[k]);
  }
  const tels = [];
  for (const t of unidos) {
    if (/^[\d -]+$/.test(t) && t.replace(/\D/g, '').length >= 6) {
      if (!tels.some((x) => x.numero.replace(/\D/g, '') === t.replace(/\D/g, ''))) tels.push({ numero: t, nota: '' }); // a veces viene repetido
    } else if (!/^\d*$/.test(t) && tels.length) tels[tels.length - 1].nota = (tels[tels.length - 1].nota + ' ' + t.toLowerCase()).trim();
  }
  return { domicilio, telefonos: tels, crudo: resto.replace(/\s+/g, ' ').trim() };
}

function armar(x, corte) {
  const { domicilio, telefonos: tels, crudo } = telefonos(x.direccion);
  const principales = [...new Set(x.docs.filter((q) => q.tipo === 'DOCUMENTO').map((q) => q.liq))];
  const ops = principales.map((liq) => {
    const docs = x.docs.filter((q) => q.liq === liq), v = x.liquid[liq] || {};
    return {
      id: id(), tipo: 'Ayuda económica con prenda', numero: liq, fecha: docs[0].fecha, cuotas: docs[0].de || null, importe: docs[0].importe,
      concesionaria: v.concesionaria || '', vehiculo: { marca: (v.marca || '').toUpperCase(), modelo: (v.modelo || '').toUpperCase(), anio: v.anio || '', dominio: (v.dominio || '').toUpperCase() },
      ultimo_pago: x.ultimo_pago, nota: '',
    };
  });
  const opDe = (liq) => ops.find((o) => o.numero === liq) || ops[0] || null;
  const cuotas = x.docs.map((q) => ({
    id: id(), op: q.tipo === 'DOCUMENTO' ? opDe(q.liq)?.id || '' : ops[0]?.id || '', n: q.n, de: q.tipo === 'DOCUMENTO-R' ? null : q.de, vto: q.vto, importe: q.importe,
    doc: q.tipo === 'DOCUMENTO-R' ? `R ${q.liq}` : q.liq,
  }));
  // Las cuotas que faltan vencer, mes a mes desde la última listada, con el mismo importe.
  for (const op of ops) {
    const comunes = cuotas.filter((q) => q.op === op.id && q.de).sort((a, b) => a.n - b.n);
    const ult = comunes[comunes.length - 1];
    if (!ult || !ult.de) continue;
    for (let n = ult.n + 1; n <= ult.de; n++) cuotas.push({ id: id(), op: op.id, n, de: ult.de, vto: sumarMeses(ult.vto, n - ult.n), importe: ult.importe, doc: '' });
  }
  const nombre = MAYUS(x.partes.join(' '));
  const vencido = x.docs.reduce((a, q) => a + q.importe, 0), sistema = x.docs.reduce((a, q) => a + q.total, 0);
  const notas = [
    x.obs ? `Listado de la Mutual: ${x.obs}.` : '',
    crudo ? `Teléfonos según el listado: ${crudo}` : '',
  ].filter(Boolean).join('\n');
  return {
    nombre, socio: x.socio, domicilio, telefonos: tels, acreedor: 'Asociación Mutual Bell', tasa: 5, hon_pct: 0,
    operaciones: ops, cuotas, notas,
    gestiones: [{ id: id(), creado: new Date().toISOString(), fecha: corte || x.ultimo_pago, tipo: 'Nota', texto: `Cargado desde el listado de prendarios de la Mutual (documentos vencidos al ${corte.split('-').reverse().join('/')}): ${x.docs.length} ${x.docs.length === 1 ? 'documento vencido' : 'documentos vencidos'} por ${pesos(vencido)}; con los intereses del sistema, ${pesos(Math.round(sistema * 100) / 100)}. Último pago en la Mutual: ${x.ultimo_pago.split('-').reverse().join('/')}.` }],
    control: { ...(x.control || {}), vencido: Math.round(vencido * 100) / 100, sistema: Math.round(sistema * 100) / 100 },
  };
}

/** SQL para el conector de Supabase: agrega los deudores cuyo N° de socio todavía no está. */
export function aSql(deudores) {
  const filas = deudores.map(({ control, ...d }) => d);
  const json = JSON.stringify(filas).replace(/'/g, "''");
  return `begin;
select set_config('gestor.autor', 'Claude', true);
insert into public.deudores (nombre, socio, domicilio, telefonos, acreedor, tasa, hon_pct, operaciones, cuotas, notas, gestiones)
select x.nombre, x.socio, x.domicilio, x.telefonos, x.acreedor, x.tasa, x.hon_pct, x.operaciones, x.cuotas, x.notas, x.gestiones
  from jsonb_to_recordset('${json}'::jsonb) x(nombre text, socio text, domicilio text, telefonos jsonb, acreedor text, tasa numeric, hon_pct numeric, operaciones jsonb, cuotas jsonb, notas text, gestiones jsonb)
 where not exists (select 1 from public.deudores d where d.socio = x.socio and x.socio <> '');
commit;`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = leerListado(readFileSync(0, 'utf8'));
  if (process.argv.includes('--sql')) process.stdout.write(aSql(r.deudores) + '\n');
  else process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}
