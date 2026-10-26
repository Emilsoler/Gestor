// ARCA: la constancia de inscripción de un CUIT (web service ws_sr_constancia_inscripcion), que se suma a la
// consulta al BCRA. Nada de Deno.env ni de la base: lo usa index.ts y lo prueban las pruebas locales contra
// un ARCA falso (dev/arca-falso.mjs).
//
// Son dos pasos, los dos por SOAP:
//   1. WSAA (LoginCms): se le presenta un pedido de acceso firmado con la clave y el certificado de la app (un
//      CMS con el contenido adentro, como `openssl cms -sign -nodetach`). Devuelve un permiso (token y sign)
//      que vale 12 horas. Mientras vale, ARCA no da otro: index.ts lo guarda en la base y lo reusa.
//   2. El padrón (personaServiceA5, getPersona_v2): con el permiso, los datos de la constancia.
import forge from 'npm:node-forge@1.3.1';
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';

export const SERVICIO = 'ws_sr_constancia_inscripcion';
const ESPERA_MS = 25_000;

export type TipoErrorArca =
  | 'config' | 'clave' | 'certificado' | 'vencido' | 'no_autorizado' | 'ya_autenticado' | 'permiso' | 'red' | 'tiempo' | 'arca' | 'formato';

export class ErrorArca extends Error {
  constructor(public tipo: TipoErrorArca, mensaje: string, public detalle = '') { super(mensaje); }
}

// Para los registros: sin CUIT ni números largos.
export const sinDatos = (s: unknown) => String(s ?? '').replace(/\d{6,}/g, '…').slice(0, 300);

// ───────────────────────── Clave y certificado ─────────────────────────

/**
 * Un PEM como venga pegado (en un solo renglón, con espacios de más o con "\n" escritos), con su rótulo y
 * renglones de 64. Vacío si no está.
 */
export function pemNormal(texto: unknown, rotulo: string): string {
  const t = String(texto ?? '').replace(/\\n/g, '\n');
  const m = new RegExp(`-----BEGIN ${rotulo}-----([\\s\\S]*?)-----END ${rotulo}-----`).exec(t);
  const cuerpo = m ? m[1].replace(/[^A-Za-z0-9+/=]/g, '') : '';
  return cuerpo ? `-----BEGIN ${rotulo}-----\n${cuerpo.match(/.{1,64}/g)!.join('\n')}\n-----END ${rotulo}-----\n` : '';
}

export type Credencial = {
  clave: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate;
  cuit: string; alias: string; vence: Date;
};

const fecha = (d: Date) => d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: '2-digit', year: 'numeric' });

/** La clave (secreto ARCA_CLAVE) y el certificado (de la base), leídos y controlados. */
export function leerCredencial(clavePem: string, certPem: string, ahora = Date.now()): Credencial {
  const k = pemNormal(clavePem, 'PRIVATE KEY') || pemNormal(clavePem, 'RSA PRIVATE KEY');
  if (!k) throw new ErrorArca('clave', 'La clave de ARCA cargada en Supabase (ARCA_CLAVE) no se puede leer: tiene que ser todo el contenido del archivo .key.');
  const c = pemNormal(certPem, 'CERTIFICATE');
  if (!c) throw new ErrorArca('certificado', 'El certificado de ARCA guardado en la base no se puede leer. Avisale a Claude.');
  let clave: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate;
  try { clave = forge.pki.privateKeyFromPem(k) as forge.pki.rsa.PrivateKey; } catch (e) {
    throw new ErrorArca('clave', 'La clave de ARCA cargada en Supabase (ARCA_CLAVE) no se puede leer: tiene que ser todo el contenido del archivo .key.', String(e));
  }
  try { cert = forge.pki.certificateFromPem(c); } catch (e) {
    throw new ErrorArca('certificado', 'El certificado de ARCA guardado en la base no se puede leer. Avisale a Claude.', String(e));
  }
  if ((cert.publicKey as forge.pki.rsa.PublicKey).n.compareTo(clave.n) !== 0) {
    throw new ErrorArca('clave', 'La clave cargada en Supabase no es la del certificado de ARCA: tiene que ser el archivo .key que se bajó junto con la solicitud.');
  }
  const serie = String(cert.subject.getField({ name: 'serialNumber' })?.value ?? '');
  const cuit = /CUIT\s*(\d{11})/.exec(serie)?.[1] || '';
  if (!cuit) throw new ErrorArca('certificado', 'El certificado de ARCA no dice a qué CUIT pertenece. Avisale a Claude.');
  const vence = cert.validity.notAfter;
  if (vence.getTime() <= ahora) {
    throw new ErrorArca('vencido', `El certificado de ARCA venció el ${fecha(vence)}: hay que pedir uno nuevo (menú de la cuenta → «Certificado de ARCA»).`);
  }
  return { clave, cert, cuit, alias: String(cert.subject.getField('CN')?.value ?? ''), vence };
}

// ───────────────────────── WSAA: el permiso ─────────────────────────

// La hora de Argentina (sin horario de verano), como la escribe ARCA.
const horaArg = (ms: number) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 19) + '-03:00';

/** El pedido de acceso (TRA). Con diez minutos para cada lado, por si los relojes no coinciden. */
export function pedidoDeAcceso(ahora = Date.now()): string {
  return '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header>'
    + `<uniqueId>${Math.floor(ahora / 1000)}</uniqueId><generationTime>${horaArg(ahora - 10 * 60_000)}</generationTime>`
    + `<expirationTime>${horaArg(ahora + 10 * 60_000)}</expirationTime></header><service>${SERVICIO}</service></loginTicketRequest>`;
}

/** El pedido firmado: CMS (PKCS#7 SignedData) con el contenido adentro, en base64. */
export function firmar(tra: string, cred: Credencial, ahora = new Date()): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cred.cert);
  p7.addSigner({
    key: cred.clave, certificate: cred.cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: ahora as unknown as string },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

export type Permiso = { token: string; sign: string; vence: string };

const LISTAS = new Set(['actividad', 'impuesto', 'regimen', 'categoriaAutonomo', 'caracterizacion', 'error', 'actividadMonotributista']);
const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, trimValues: true, isArray: (n: string) => LISTAS.has(n) });
const leerXml = (texto: string) => { try { return xml.parse(texto); } catch { return null; } };
const escXml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

async function soap(url: string, cuerpo: string): Promise<string> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' }, body: cuerpo,
      signal: AbortSignal.timeout(ESPERA_MS),
    });
  } catch (e) {
    const t = `${(e as Error)?.name}: ${(e as Error)?.message} ${(e as { cause?: unknown })?.cause ?? ''}`;
    if (/TimeoutError|timed? ?out/i.test(t)) throw new ErrorArca('tiempo', 'ARCA tardó demasiado en responder. Probá de nuevo en un rato.', sinDatos(t));
    throw new ErrorArca('red', 'No se pudo conectar con ARCA. Probá de nuevo en un rato.', sinDatos(t));
  }
  const texto = await r.text();
  // Una página de error que no es SOAP (404, 502…) es un servidor que no atiende: cuenta como sin conexión, y
  // se prueba la dirección siguiente. Las fallas de ARCA vienen como SOAP, con 500.
  if (!r.ok && !/<(?:[\w-]+:)?Envelope[\s>]/.test(texto)) {
    throw new ErrorArca('red', 'No se pudo conectar con ARCA. Probá de nuevo en un rato.', `HTTP ${r.status}`);
  }
  return texto;
}

/** Una falla SOAP: {codigo, texto}, o null si no hay. */
function falla(x: any): { codigo: string; texto: string } | null {
  const f = x?.Envelope?.Body?.Fault;
  return f ? { codigo: String(f.faultcode ?? ''), texto: String(f.faultstring ?? '').replace(/\s+/g, ' ').trim() } : null;
}

function errorDeWsaa({ codigo, texto }: { codigo: string; texto: string }): ErrorArca {
  const d = `${codigo} ${texto}`;
  if (/alreadyAuthenticated/i.test(codigo)) return new ErrorArca('ya_autenticado', 'ARCA ya había dado un permiso que se perdió, y no da otro hasta que venza (como mucho, 12 horas). Probá más tarde.', d);
  if (/notAuthorized/i.test(codigo)) return new ErrorArca('no_autorizado', 'ARCA dice que el certificado no está autorizado para la constancia de inscripción: revisá en ARCA el paso «Nueva Relación».', d);
  if (/expired/i.test(codigo)) return new ErrorArca('vencido', 'ARCA dice que el certificado venció: hay que pedir uno nuevo (menú de la cuenta → «Certificado de ARCA»).', d);
  if (/cms|cert/i.test(codigo)) return new ErrorArca('certificado', 'ARCA no aceptó la firma del certificado. Avisale a Claude.', d);
  return new ErrorArca('arca', `ARCA no dio el permiso: ${texto.slice(0, 160) || 'sin detalle'}.`, d);
}

/** Pide un permiso nuevo a WSAA. */
export async function iniciarSesion(cred: Credencial, url: string, ahora = Date.now()): Promise<Permiso> {
  const cms = firmar(pedidoDeAcceso(ahora), cred, new Date(ahora));
  const texto = await soap(url, '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">'
    + `<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`);
  const x = leerXml(texto);
  const f = falla(x);
  if (f) throw errorDeWsaa(f);
  const ta = leerXml(String(x?.Envelope?.Body?.loginCmsResponse?.loginCmsReturn ?? ''))?.loginTicketResponse;
  const token = ta?.credentials?.token, sign = ta?.credentials?.sign, vence = Date.parse(String(ta?.header?.expirationTime ?? ''));
  if (!token || !sign || Number.isNaN(vence)) throw new ErrorArca('formato', 'ARCA respondió algo que no se pudo leer. Probá de nuevo en un rato.', sinDatos(texto));
  return { token: String(token), sign: String(sign), vence: new Date(vence).toISOString() };
}

// ───────────────────────── El padrón: la constancia ─────────────────────────

/** Los datos de la constancia de un CUIT (`personaReturn`, tal cual). */
export async function constancia(permiso: Permiso, cuitRepresentada: string, cuit: string, url: string): Promise<any> {
  const texto = await soap(url, '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">'
    + `<soapenv:Header/><soapenv:Body><a5:getPersona_v2><token>${escXml(permiso.token)}</token><sign>${escXml(permiso.sign)}</sign>`
    + `<cuitRepresentada>${cuitRepresentada}</cuitRepresentada><idPersona>${cuit}</idPersona></a5:getPersona_v2></soapenv:Body></soapenv:Envelope>`);
  const x = leerXml(texto);
  const f = falla(x);
  if (f) {
    const d = `${f.codigo} ${f.texto}`;
    if (/token|sign|expir|autoriz|ticket|credencial/i.test(d)) throw new ErrorArca('permiso', 'ARCA no aceptó el permiso.', sinDatos(d));
    throw new ErrorArca('arca', `ARCA respondió con un error: ${sinDatos(f.texto).slice(0, 160) || 'sin detalle'}.`, sinDatos(d));
  }
  const p = x?.Envelope?.Body?.getPersona_v2Response?.personaReturn;
  if (!p || typeof p !== 'object') throw new ErrorArca('formato', 'ARCA respondió algo que no se pudo leer. Probá de nuevo en un rato.', sinDatos(texto));
  return p;
}

// ───────────────────────── Resumen para mostrar ─────────────────────────

const lista = (x: unknown): any[] => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const txt = (x: unknown) => (x == null || typeof x === 'object' ? '' : String(x).replace(/\s+/g, ' ').trim());
const campo = (o: any, ...ks: string[]) => { for (const k of ks) if (txt(o?.[k])) return txt(o[k]); return ''; };

export type ResumenArca = {
  nombre: string; tipo: string; estado: string; domicilio: string;
  monotributo: string; actividad: string; impuestos: string[]; avisos: string[];
};

/**
 * Lo que interesa para un crédito: quién es, si la CUIT está activa, si es monotributista (y en qué
 * categoría, que da una idea del tope de ingresos) o está en el régimen general (con qué impuestos), su
 * actividad principal y el domicilio fiscal. `avisos`: lo que ARCA dice cuando no hay constancia.
 */
export function resumirPersona(p: any): ResumenArca {
  const g = p?.datosGenerales ?? {}, ec = p?.errorConstancia ?? null, dom = g?.domicilioFiscal ?? {};
  const mono = p?.datosMonotributo ?? null, rg = p?.datosRegimenGeneral ?? null;
  const actividades = [...lista(mono?.actividadMonotributista), ...lista(mono?.actividad), ...lista(rg?.actividad)]
    .sort((a, b) => (Number(a?.orden) || 99) - (Number(b?.orden) || 99));
  const avisos = lista(ec?.error).map(txt).filter(Boolean);
  if (!mono && !rg && !avisos.length) {
    avisos.push(...[...lista(p?.errorMonotributo?.error), ...lista(p?.errorRegimenGeneral?.error)].map(txt).filter(Boolean));
  }
  return {
    nombre: campo(g, 'razonSocial') || [campo(g, 'apellido'), campo(g, 'nombre')].filter(Boolean).join(' ')
      || [campo(ec, 'apellido'), campo(ec, 'nombre')].filter(Boolean).join(' '),
    tipo: campo(g, 'tipoPersona'),
    estado: campo(g, 'estadoClave'),
    domicilio: [campo(dom, 'direccion'), campo(dom, 'localidad', 'Localidad'), campo(dom, 'descripcionProvincia')].filter(Boolean).join(', '),
    monotributo: campo(mono?.categoriaMonotributo, 'descripcionCategoria'),
    actividad: campo(actividades[0], 'descripcionActividad'),
    impuestos: lista(rg?.impuesto).filter((i) => !campo(i, 'estadoImpuesto') || campo(i, 'estadoImpuesto') === 'AC')
      .map((i) => campo(i, 'descripcionImpuesto')).filter(Boolean),
    avisos,
  };
}
