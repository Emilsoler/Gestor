// Lo que pide la solicitud de aprobación de crédito de una agencia: la documentación según cómo obtiene sus
// ingresos el cliente, los casilleros de los datos personales y los controles de esos datos.
//
// Lo usan la app (docs/agencias/solicitud.js) y la función `agencias` (supabase/functions/agencias/solicitud.js,
// copia exacta: las pruebas comparan los dos archivos; si se cambia uno, copiar el otro). La base repite la
// lista de casilleros en gestor.docs_requeridos (migraciones 0028 y 0029): también la comparan las pruebas.
// Sin nada del navegador ni de Deno.

export const CATEGORIAS = {
  dependencia: 'Empleado en relación de dependencia',
  monotributo: 'Responsable monotributista',
  inscripto: 'Responsable inscripto',
};

/** Cada casillero: qué se adjunta, cuántos archivos admite y cuántos se esperan (eso último solo para avisar). */
export const DOCS = {
  // Desde el 20/11/2026 la agencia sube todo junto, en un solo recuadro (pedido de la persona): este es el único casillero
  // que se usa. Los demás quedan para ver las solicitudes anteriores, que tienen los archivos separados por grupo.
  documentacion: { titulo: 'Documentación del cliente', max: 40, esperados: 0 },
  recibos: { titulo: 'Últimos 3 recibos de sueldo', max: 6, esperados: 3 },
  constancia: { titulo: 'Constancia de inscripción', max: 2, esperados: 1 },
  pagos: { titulo: 'Últimos 3 pagos del monotributo', max: 6, esperados: 3 },
  iva: { titulo: 'Últimas 6 declaraciones juradas de IVA', max: 12, esperados: 6 },
  ganancias: { titulo: 'Última declaración jurada de Ganancias', max: 3, esperados: 1 },
  dni: { titulo: 'Foto del DNI, de los dos lados', max: 2, esperados: 2 },
  titulo: { titulo: 'Título del automotor', max: 4, esperados: 1 },
  factura: { titulo: 'Factura del vehículo 0 km', max: 4, esperados: 1 },
  servicio: { titulo: 'Impuesto o servicio a su nombre, con ese domicilio', max: 2, esperados: 1 },
  cbu: { titulo: 'Constancia de CBU y de titularidad de la cuenta', max: 2, esperados: 1 },
};

export const DOCS_INGRESOS = { dependencia: ['recibos'], monotributo: ['constancia', 'pagos'], inscripto: ['constancia', 'iva', 'ganancias'] };

/**
 * El casillero de documentos de la solicitud: uno solo, donde la agencia sube todo junto. Ninguno es obligatorio para
 * enviarla (nov 2026: a veces los documentos llegan por otra vía): la app y la Mutual ven si quedó vacío. El nombre
 * quedó de cuando eran varios y obligatorios.
 */
export function docsRequeridos(_categoria, _anio) {
  return ['documentacion'];
}
/** Los que admiten archivos: el mismo. */
export const docsPermitidos = docsRequeridos;

/** Los casilleros de las solicitudes hechas antes del 20/11/2026: un grupo por documento y un 0 km con factura. */
export function docsRequeridosAntes(categoria, anio) {
  return [...(DOCS_INGRESOS[categoria] || []), 'dni', anio === '0km' ? 'factura' : 'titulo', 'servicio', 'cbu'];
}

/**
 * Qué casilleros quedaron vacíos en una solicitud ya enviada ({categoria, anio, archivos}). Una anterior al cambio, con sus
 * archivos por grupo, se mide con los grupos de entonces; una nueva, o una sin archivos, con el casillero único.
 */
export function docsSinAdjuntar(sol) {
  const arch = Array.isArray(sol?.archivos) ? sol.archivos : [];
  const lista = arch.some((a) => a.slot !== 'documentacion') ? docsRequeridosAntes(sol.categoria, sol.anio) : docsRequeridos();
  return lista.filter((k) => !arch.some((a) => a.slot === k));
}

export const MAX_BYTES = 10 * 1024 * 1024; // por archivo (igual que el límite de la carpeta del almacenamiento)
export const MAX_ARCHIVOS = 40; // por solicitud

/** PDF o JPEG según sus primeros bytes, no según el nombre. null si no es ninguno de los dos. */
export function tipoArchivo(b) {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return { tipo: 'application/pdf', ext: 'pdf' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { tipo: 'image/jpeg', ext: 'jpg' };
  return null;
}

/** CBU o CVU: 22 números con sus dos dígitos verificadores (el 8.º y el 22.º). */
export function cbuValido(s) {
  const c = String(s ?? '').replace(/\D/g, '');
  if (c.length !== 22) return false;
  const dv = (digitos, pesos) => (10 - (pesos.reduce((a, p, i) => a + p * Number(digitos[i]), 0) % 10)) % 10;
  return dv(c.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === Number(c[7])
    && dv(c.slice(8, 21), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === Number(c[21]);
}

/** Alias de CBU/CVU: de 6 a 20 caracteres, con letras, números, puntos y guiones (sin espacios). */
export const aliasValido = (s) => /^[a-zA-Z0-9.-]{6,20}$/.test(String(s ?? '').trim());

/** CUIT, CUIL o CDI: 11 números y el último, el dígito verificador (módulo 11). Igual que en bcra.ts. */
export function cuitValido(s) {
  const c = String(s ?? '').replace(/\D/g, '');
  if (c.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let dv = 11 - (pesos.reduce((a, p, i) => a + p * Number(c[i]), 0) % 11);
  if (dv === 11) dv = 0;
  return dv !== 10 && dv === Number(c[10]);
}

/** El DNI que lleva un CUIL o CUIT de persona (las 8 cifras del medio, sin ceros adelante); '' si no es de persona. */
export function dniDelCuit(cuit) {
  const c = String(cuit ?? '').replace(/\D/g, '');
  return c.length === 11 && /^2[0347]$/.test(c.slice(0, 2)) ? String(Number(c.slice(2, 10))) : '';
}

/** CUIT de persona jurídica (empresas, sociedades, asociaciones): empieza con 30, 33 o 34. */
export const esJuridica = (cuit) => /^3[034]\d{9}$/.test(String(cuit ?? '').replace(/\D/g, ''));

/** Lo que se pide de más a una persona jurídica que no es asociada a la Mutual (nov 2026). */
export const DOCS_NO_ASOCIADA = ['Estatuto social', 'Última acta de autoridades', 'Último balance certificado y aprobado', 'DNI de los socios'];

/** Qué parte del ingreso mensual se lleva la cuota, en % con dos decimales. null sin ingreso. */
export const relacionCuota = (cuota, ingreso) => (Number(ingreso) > 0 ? Math.round((Number(cuota) / Number(ingreso)) * 10000) / 100 : null);

/** En qué nupcias está casado/a: [valor, rótulo]. */
export const NUPCIAS = [['1', '1ras. nupcias'], ['2', '2das. nupcias'], ['3', '3ras. nupcias'], ['4', '4tas. nupcias']];
/** Código postal: los 4 números de siempre o el CPA de 8 (X2550XAB). */
const cpValido = (cp) => /^(\d{4}|[A-Za-z]\d{4}[A-Za-z]{3})$/.test(cp);

const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;

/**
 * Los datos del cliente, controlados y limpios: { datos } o { errores: [texto…] }, todos juntos para mostrarlos
 * de una vez. `hoy` es AAAA-MM-DD (la fecha del matrimonio no puede ser posterior).
 */
export function revisarDatos(d, hoy, juridica = false) {
  if (juridica) return revisarDatosJuridica(d);
  const errores = [];
  const txt = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const dni = String(d?.dni ?? '').replace(/\D/g, '');
  if (!/^\d{7,8}$/.test(dni)) errores.push('El DNI tiene que tener 7 u 8 números.');
  // Domicilio real: desde el 24/11/2026 en casilleros (calle, número, piso, depto., CP, localidad, departamento y provincia),
  // para completar solos el Formulario 03 y el contrato de prenda. `domicilio` queda armado de corrido para lo demás. Un
  // pedido viejo (de una app que quedó abierta) trae solo `domicilio` y se acepta como antes.
  const porPartes = d?.dom_calle !== undefined;
  let domicilio = txt(d?.domicilio, 300), partes = {}, nacionalidad = '', nacimiento = '';
  if (porPartes) {
    const calle = txt(d?.dom_calle, 120), numero = txt(d?.dom_numero, 12), piso = txt(d?.dom_piso, 12), depto = txt(d?.dom_depto, 12), cp = txt(d?.dom_cp, 10);
    const localidad = txt(d?.dom_localidad, 100), departamento = txt(d?.dom_departamento, 100), provincia = txt(d?.dom_provincia, 100);
    if (calle.length < 2) errores.push('Escribí la calle del domicilio del cliente.');
    if (!numero) errores.push('Escribí el número del domicilio del cliente (o «S/N»).');
    if (!cpValido(cp)) errores.push('Escribí el código postal del cliente (4 números, o el código nuevo de 8).');
    if (localidad.length < 2) errores.push('Escribí la localidad del cliente.');
    if (provincia.length < 2) errores.push('Escribí la provincia del cliente.');
    domicilio = `${calle} ${numero}${piso ? `, piso ${piso}` : ''}${depto ? `, depto. ${depto}` : ''}, ${localidad}`.slice(0, 300);
    partes = { dom_calle: calle, dom_numero: numero, ...(piso ? { dom_piso: piso } : {}), ...(depto ? { dom_depto: depto } : {}), dom_cp: cp,
      dom_localidad: localidad, ...(departamento ? { dom_departamento: departamento } : {}), dom_provincia: provincia };
    nacionalidad = txt(d?.nacionalidad, 80);
    nacimiento = String(d?.nacimiento ?? '');
    if (nacionalidad.length < 3) errores.push('Escribí la nacionalidad del cliente.');
    if (!fechaValida(nacimiento) || nacimiento < '1900-01-01' || nacimiento > hoy) errores.push('Escribí la fecha de nacimiento del cliente.');
  } else if (domicilio.length < 5) errores.push('Escribí el domicilio real del cliente.');
  const estado = d?.estado_civil;
  if (!['soltero', 'casado'].includes(estado)) errores.push('Elegí el estado civil.');
  let lugar = '', fecha = '', nupcias = '', conyuge = {};
  if (estado === 'casado') {
    lugar = txt(d?.matrimonio_lugar, 200);
    fecha = String(d?.matrimonio_fecha ?? '');
    if (lugar.length < 2) errores.push('Escribí el lugar del matrimonio.');
    if (!fechaValida(fecha) || fecha < '1930-01-01' || fecha > hoy) errores.push('Escribí la fecha del matrimonio.');
    nupcias = String(d?.matrimonio_nupcias ?? ''); // sale en el asentimiento conyugal (27/11/2026)
    if (!NUPCIAS.some(([k]) => k === nupcias)) errores.push('Elegí en qué nupcias está casado/a.');
    // Datos del cónyuge (nov 2026): salen en la copia no negociable del contrato de prenda.
    const cNombre = txt(d?.conyuge_nombre, 200), cDni = String(d?.conyuge_dni ?? '').replace(/\D/g, ''), cNac = txt(d?.conyuge_nacionalidad, 80);
    const cDom = txt(d?.conyuge_domicilio, 300), cFecha = String(d?.conyuge_nacimiento ?? '');
    if (cNombre.length < 3) errores.push('Escribí el apellido y nombre del cónyuge.');
    if (!/^\d{7,8}$/.test(cDni)) errores.push('El DNI del cónyuge tiene que tener 7 u 8 números.');
    if (cNac.length < 3) errores.push('Escribí la nacionalidad del cónyuge.');
    if (cDom.length < 5) errores.push('Escribí el domicilio del cónyuge.');
    if (!fechaValida(cFecha) || cFecha < '1900-01-01' || cFecha > hoy) errores.push('Escribí la fecha de nacimiento del cónyuge.');
    conyuge = { conyuge_nombre: cNombre, conyuge_dni: cDni, conyuge_nacionalidad: cNac, conyuge_domicilio: cDom, conyuge_nacimiento: cFecha };
  }
  const celular = String(d?.celular ?? '').replace(/\D/g, '');
  if (celular.length < 8 || celular.length > 15) errores.push('El celular tiene que tener entre 8 y 15 números, con la característica.');
  // El CBU no es obligatorio (nov 2026: a veces se pasa después, por otra vía). Si se escribe, se controla, y entonces
  // también hay que decir de quién es la cuenta: del cliente o de un tercero (con quién es el titular).
  const cbu = String(d?.cbu ?? '').replace(/\D/g, '');
  if (cbu && !cbuValido(cbu)) errores.push(cbu.length === 22 ? 'Ese CBU o CVU no es válido: revisá los números.' : 'El CBU o CVU tiene que tener 22 números.');
  // Alternativa al CBU/CVU: el alias de la cuenta (también opcional; pueden ir los dos).
  const alias = String(d?.alias ?? '').trim();
  if (alias && !aliasValido(alias)) errores.push('El alias tiene que tener de 6 a 20 caracteres: letras, números, puntos o guiones, sin espacios.');
  const hayCuenta = Boolean(cbu || alias);
  const cuenta = hayCuenta ? d?.cuenta : undefined;
  let tercero = {};
  if (hayCuenta && !['propia', 'terceros'].includes(cuenta)) errores.push('Elegí si la cuenta es del cliente o de un tercero.');
  if (cuenta === 'terceros') {
    const titular = txt(d?.cuenta_titular, 200), cuit = String(d?.cuenta_cuit ?? '').replace(/\D/g, '');
    if (titular.length < 3) errores.push('Escribí el nombre o la razón social del titular de la cuenta.');
    if (!cuitValido(cuit)) errores.push('El CUIT o CUIL del titular de la cuenta no es válido: revisá los números.');
    tercero = { cuenta_titular: titular, cuenta_cuit: cuit, ...(txt(d?.cuenta_relacion, 120) ? { cuenta_relacion: txt(d?.cuenta_relacion, 120) } : {}) };
  }
  // Empleo, profesión o actividad del cliente, en palabras de la agencia (opcional; nov 2026, para la Mutual).
  const actividad = txt(d?.actividad, 200);
  // Notas y aclaraciones de la agencia para la Mutual (opcional; 25/11/2026: por ejemplo, una deuda del Central que ya está paga).
  // Conserva los saltos de línea.
  const notas = String(d?.notas ?? '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000);
  if (typeof d?.asociado !== 'boolean') errores.push('Indicá si el cliente es asociado a la Mutual.');
  if (errores.length) return { errores };
  return {
    datos: { asociado: d.asociado, ...(actividad ? { actividad } : {}), ...(notas ? { notas } : {}), dni, domicilio, ...partes, ...(porPartes ? { nacionalidad, nacimiento } : {}), estado_civil: estado, ...(estado === 'casado' ? { matrimonio_lugar: lugar, matrimonio_fecha: fecha, matrimonio_nupcias: nupcias, ...conyuge } : {}), celular, ...(cbu ? { cbu } : {}), ...(alias ? { alias } : {}), ...(hayCuenta ? { cuenta } : {}), ...tercero },
  };
}

/**
 * Los datos de una persona jurídica (CUIT 30, 33 o 34), controlados y limpios: { datos } o { errores }. En lugar del DNI, el
 * estado civil y el nacimiento, lleva la sede social y los datos de quien la representa. La razón social es la que informó
 * el BCRA (queda en la solicitud). Se pide también si es asociada a la Mutual.
 */
function revisarDatosJuridica(d) {
  const errores = [];
  const txt = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const calle = txt(d?.dom_calle, 120), numero = txt(d?.dom_numero, 12), piso = txt(d?.dom_piso, 12), depto = txt(d?.dom_depto, 12), cp = txt(d?.dom_cp, 10);
  const localidad = txt(d?.dom_localidad, 100), departamento = txt(d?.dom_departamento, 100), provincia = txt(d?.dom_provincia, 100);
  if (calle.length < 2) errores.push('Escribí la calle del domicilio o sede social.');
  if (!numero) errores.push('Escribí el número del domicilio o sede social (o «S/N»).');
  if (!cpValido(cp)) errores.push('Escribí el código postal de la sede social (4 números, o el código nuevo de 8).');
  if (localidad.length < 2) errores.push('Escribí la localidad de la sede social.');
  if (provincia.length < 2) errores.push('Escribí la provincia de la sede social.');
  const domicilio = `${calle} ${numero}${piso ? `, piso ${piso}` : ''}${depto ? `, depto. ${depto}` : ''}, ${localidad}`.slice(0, 300);
  const partes = { dom_calle: calle, dom_numero: numero, ...(piso ? { dom_piso: piso } : {}), ...(depto ? { dom_depto: depto } : {}), dom_cp: cp,
    dom_localidad: localidad, ...(departamento ? { dom_departamento: departamento } : {}), dom_provincia: provincia };
  const repNombre = txt(d?.representante_nombre, 200), repDni = String(d?.representante_dni ?? '').replace(/\D/g, ''), repCargo = txt(d?.representante_cargo, 100);
  if (repNombre.length < 3) errores.push('Escribí el apellido y nombre de quien representa a la empresa.');
  if (!/^\d{7,8}$/.test(repDni)) errores.push('El DNI del representante tiene que tener 7 u 8 números.');
  if (repCargo.length < 2) errores.push('Escribí el cargo del representante (por ejemplo, presidente o socio gerente).');
  const celular = String(d?.celular ?? '').replace(/\D/g, '');
  if (celular.length < 8 || celular.length > 15) errores.push('El celular tiene que tener entre 8 y 15 números, con la característica.');
  const cbu = String(d?.cbu ?? '').replace(/\D/g, '');
  if (cbu && !cbuValido(cbu)) errores.push(cbu.length === 22 ? 'Ese CBU o CVU no es válido: revisá los números.' : 'El CBU o CVU tiene que tener 22 números.');
  const alias = String(d?.alias ?? '').trim();
  if (alias && !aliasValido(alias)) errores.push('El alias tiene que tener de 6 a 20 caracteres: letras, números, puntos o guiones, sin espacios.');
  const hayCuenta = Boolean(cbu || alias);
  const cuenta = hayCuenta ? d?.cuenta : undefined;
  let tercero = {};
  if (hayCuenta && !['propia', 'terceros'].includes(cuenta)) errores.push('Elegí si la cuenta es de la empresa o de un tercero.');
  if (cuenta === 'terceros') {
    const titular = txt(d?.cuenta_titular, 200), cuit = String(d?.cuenta_cuit ?? '').replace(/\D/g, '');
    if (titular.length < 3) errores.push('Escribí el nombre o la razón social del titular de la cuenta.');
    if (!cuitValido(cuit)) errores.push('El CUIT o CUIL del titular de la cuenta no es válido: revisá los números.');
    tercero = { cuenta_titular: titular, cuenta_cuit: cuit, ...(txt(d?.cuenta_relacion, 120) ? { cuenta_relacion: txt(d?.cuenta_relacion, 120) } : {}) };
  }
  const actividad = txt(d?.actividad, 200);
  // Notas y aclaraciones de la agencia para la Mutual (opcional; 25/11/2026: por ejemplo, una deuda del Central que ya está paga).
  // Conserva los saltos de línea.
  const notas = String(d?.notas ?? '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000);
  if (typeof d?.asociado !== 'boolean') errores.push('Indicá si la empresa es asociada a la Mutual.');
  if (errores.length) return { errores };
  return {
    datos: { persona: 'juridica', asociado: d.asociado, ...(actividad ? { actividad } : {}), ...(notas ? { notas } : {}), domicilio, ...partes, representante_nombre: repNombre, representante_dni: repDni, representante_cargo: repCargo,
      celular, ...(cbu ? { cbu } : {}), ...(alias ? { alias } : {}), ...(hayCuenta ? { cuenta } : {}), ...tercero },
  };
}
