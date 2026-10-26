// Un doble de ARCA para las pruebas locales (en 127.0.0.1:54343): WSAA (el permiso) y el padrón de la
// constancia de inscripción (personaServiceA5). La función `bcra` corre en local apuntando acá
// (ARCA_WSAA_URL y ARCA_PADRON_URL), con una clave y un certificado de prueba que arma stack.sh.
//
// Como el de verdad: el pedido de acceso tiene que venir firmado (lo verifica OpenSSL, con el certificado que
// viene adentro), mientras hay un permiso vigente no da otro, y el padrón solo contesta con el último permiso.
//
//   POST   /__casos     { login: 'ok' | 'no_autorizado', personas: { "<cuit>": personaReturn } }
//                       Un CUIT sin caso responde "No existe persona con ese Id", como ARCA.
//   POST   /__permiso   { vigente: true } da por dado un permiso que la función no conoce (como uno perdido);
//                       { vigente: false } lo olvida.
//   GET    /__pedidos   lo pedido, en orden: { ruta, firmaOk?, servicio?, cuit?, representada? }
//   DELETE /__pedidos   olvida lo pedido, los casos y el permiso
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PORT = +process.env.ARCA_FALSO_PORT || 54343;
let casos = {}, pedidos = [], permiso = null;

const leer = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const json = (res, status, cuerpo) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(cuerpo));
const sobre = (cuerpo) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${cuerpo}</soapenv:Body></soapenv:Envelope>`;
const xml = (res, status, cuerpo) => res.writeHead(status, { 'content-type': 'text/xml; charset=utf-8' }).end(sobre(cuerpo));
const falla = (res, codigo, texto) => xml(res, 500, `<soapenv:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">${codigo}</faultcode><faultstring>${esc(texto)}</faultstring></soapenv:Fault>`);
const entre = (texto, tag) => new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(texto)?.[1] ?? '';
const vigente = () => permiso && permiso.vence > Date.now();
const hora = (ms) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 19) + '-03:00';

/** Un objeto como XML: las listas, repitiendo la etiqueta. */
const aXml = (o) => Object.entries(o).map(([k, v]) => (Array.isArray(v) ? v : [v])
  .map((x) => (x && typeof x === 'object' ? `<${k}>${aXml(x)}</${k}>` : `<${k}>${esc(x)}</${k}>`)).join('')).join('');

/** Verifica el CMS con OpenSSL y devuelve lo firmado (null si la firma no vale). */
function verificar(b64) {
  const dir = mkdtempSync(join(tmpdir(), 'arca-falso-'));
  try {
    writeFileSync(join(dir, 'tra.cms'), Buffer.from(b64, 'base64'));
    execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-noverify', '-in', join(dir, 'tra.cms'), '-out', join(dir, 'tra.xml')], { stdio: 'ignore' });
    return readFileSync(join(dir, 'tra.xml'), 'utf8');
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

function login(res, cuerpo) {
  const tra = verificar(entre(cuerpo, 'in0').replace(/\s/g, ''));
  const servicio = tra ? entre(tra, 'service') : '';
  const gen = Date.parse(entre(tra || '', 'generationTime')), exp = Date.parse(entre(tra || '', 'expirationTime'));
  pedidos.push({ ruta: 'LoginCms', firmaOk: !!tra, servicio });
  if (!tra) return falla(res, 'ns1:cms.bad', 'El CMS no es valido');
  if (!(gen <= Date.now() && Date.now() <= exp)) return falla(res, 'ns1:xml.generationTime.invalid', 'generationTime posee formato o dato inválido');
  if (servicio !== 'ws_sr_constancia_inscripcion') return falla(res, 'ns1:coe.notAuthorized', 'Computador no autorizado a acceder al servicio');
  if (casos.login === 'no_autorizado') return falla(res, 'ns1:coe.notAuthorized', 'Computador no autorizado a acceder al servicio');
  if (vigente()) return falla(res, 'ns1:coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado');
  const ahora = Date.now();
  permiso = { token: randomBytes(24).toString('base64'), sign: randomBytes(16).toString('base64'), vence: ahora + 12 * 3600_000 };
  const ta = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><loginTicketResponse version="1.0"><header><source>CN=wsaa, O=AFIP, C=AR, SERIALNUMBER=CUIT 33693450239</source>`
    + `<destination>SERIALNUMBER=CUIT 20111111112, CN=cobranzasprueba</destination><uniqueId>${Math.floor(ahora / 1000)}</uniqueId>`
    + `<generationTime>${hora(ahora)}</generationTime><expirationTime>${hora(permiso.vence)}</expirationTime></header>`
    + `<credentials><token>${permiso.token}</token><sign>${permiso.sign}</sign></credentials></loginTicketResponse>`;
  return xml(res, 200, `<loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${esc(ta)}</loginCmsReturn></loginCmsResponse>`);
}

function padron(res, cuerpo) {
  const token = entre(cuerpo, 'token'), sign = entre(cuerpo, 'sign'), cuit = entre(cuerpo, 'idPersona'), representada = entre(cuerpo, 'cuitRepresentada');
  pedidos.push({ ruta: 'getPersona_v2', cuit, representada });
  if (!/getPersona_v2/.test(cuerpo)) return falla(res, 'soap:Client', 'Operación desconocida');
  if (!vigente() || token !== permiso.token || sign !== permiso.sign) return falla(res, 'soap:Server', 'No autorizado: token o sign inválidos o expirados');
  if (representada !== '20111111112') return falla(res, 'soap:Server', 'La CUIT representada no figura en el token');
  const p = casos.personas?.[cuit] ?? { errorConstancia: { apellido: '', error: 'No existe persona con ese Id', idPersona: cuit, nombre: '' } };
  return xml(res, 200, `<ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn>${aXml(p)}<metadata><fechaHora>${new Date().toISOString()}</fechaHora><servidor>falso</servidor></metadata></personaReturn></ns2:getPersona_v2Response>`);
}

http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  if (req.url === '/__casos' && req.method === 'POST') { casos = JSON.parse(cuerpo || '{}'); return json(res, 200, {}); }
  if (req.url === '/__permiso' && req.method === 'POST') {
    permiso = JSON.parse(cuerpo || '{}').vigente ? { token: 'perdido', sign: 'perdido', vence: Date.now() + 12 * 3600_000 } : null;
    return json(res, 200, {});
  }
  if (req.url === '/__pedidos' && req.method === 'GET') return json(res, 200, pedidos);
  if (req.url === '/__pedidos' && req.method === 'DELETE') { pedidos = []; casos = {}; permiso = null; return json(res, 200, {}); }
  if (req.method === 'POST' && req.url === '/ws/services/LoginCms') return login(res, cuerpo);
  if (req.method === 'POST' && req.url === '/sr-padron/webservices/personaServiceA5') return padron(res, cuerpo);
  return json(res, 404, { error: 'ruta inexistente' });
}).listen(PORT, '127.0.0.1', () => console.log('arca falso en', PORT));
