// Lo que pide la solicitud de aprobación de crédito de una agencia: la documentación según cómo obtiene sus
// ingresos el cliente, los casilleros de los datos personales y los controles de esos datos.
//
// Lo usan la app (docs/agencias/solicitud.js) y la función `agencias` (supabase/functions/agencias/solicitud.js,
// copia exacta: las pruebas comparan los dos archivos; si se cambia uno, copiar el otro). La base repite la
// lista de casilleros obligatorios en gestor.docs_requeridos (migración 0028): también la comparan las pruebas.
// Sin nada del navegador ni de Deno.

export const CATEGORIAS = {
  dependencia: 'Empleado en relación de dependencia',
  monotributo: 'Responsable monotributista',
  inscripto: 'Responsable inscripto',
};

/** Cada casillero: qué se adjunta, cuántos archivos admite y cuántos se esperan (eso último solo para avisar). */
export const DOCS = {
  recibos: { titulo: 'Últimos 3 recibos de sueldo', max: 6, esperados: 3 },
  constancia: { titulo: 'Constancia de inscripción', max: 2, esperados: 1 },
  pagos: { titulo: 'Últimos 3 pagos del monotributo', max: 6, esperados: 3 },
  iva: { titulo: 'Últimas 6 declaraciones juradas de IVA', max: 12, esperados: 6 },
  ganancias: { titulo: 'Última declaración jurada de Ganancias', max: 3, esperados: 1 },
  dni: { titulo: 'Foto del DNI, de los dos lados', max: 2, esperados: 2 },
  titulo: { titulo: 'Título del automotor', max: 4, esperados: 1 },
  servicio: { titulo: 'Impuesto o servicio a su nombre, con ese domicilio', max: 2, esperados: 1 },
  cbu: { titulo: 'Constancia de CBU y de titularidad de la cuenta', max: 2, esperados: 1 },
};

export const DOCS_INGRESOS = { dependencia: ['recibos'], monotributo: ['constancia', 'pagos'], inscripto: ['constancia', 'iva', 'ganancias'] };

/** Los casilleros que tienen que tener al menos un archivo. Un 0 km todavía no tiene título: ahí es opcional. */
export function docsRequeridos(categoria, anio) {
  return [...(DOCS_INGRESOS[categoria] || []), 'dni', ...(anio === '0km' ? [] : ['titulo']), 'servicio', 'cbu'];
}
export const docsPermitidos = (categoria, anio) => [...new Set([...docsRequeridos(categoria, anio), 'titulo'])];

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

/** El DNI que lleva un CUIL o CUIT de persona (las 8 cifras del medio, sin ceros adelante); '' si no es de persona. */
export function dniDelCuit(cuit) {
  const c = String(cuit ?? '').replace(/\D/g, '');
  return c.length === 11 && /^2[0347]$/.test(c.slice(0, 2)) ? String(Number(c.slice(2, 10))) : '';
}

/** Qué parte del ingreso mensual se lleva la cuota, en % con dos decimales. null sin ingreso. */
export const relacionCuota = (cuota, ingreso) => (Number(ingreso) > 0 ? Math.round((Number(cuota) / Number(ingreso)) * 10000) / 100 : null);

const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;

/**
 * Los datos del cliente, controlados y limpios: { datos } o { errores: [texto…] }, todos juntos para mostrarlos
 * de una vez. `hoy` es AAAA-MM-DD (la fecha del matrimonio no puede ser posterior).
 */
export function revisarDatos(d, hoy) {
  const errores = [];
  const txt = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const dni = String(d?.dni ?? '').replace(/\D/g, '');
  if (!/^\d{7,8}$/.test(dni)) errores.push('El DNI tiene que tener 7 u 8 números.');
  const domicilio = txt(d?.domicilio, 300);
  if (domicilio.length < 5) errores.push('Escribí el domicilio real del cliente.');
  const estado = d?.estado_civil;
  if (!['soltero', 'casado'].includes(estado)) errores.push('Elegí el estado civil.');
  let lugar = '', fecha = '';
  if (estado === 'casado') {
    lugar = txt(d?.matrimonio_lugar, 200);
    fecha = String(d?.matrimonio_fecha ?? '');
    if (lugar.length < 2) errores.push('Escribí el lugar del matrimonio.');
    if (!fechaValida(fecha) || fecha < '1930-01-01' || fecha > hoy) errores.push('Escribí la fecha del matrimonio.');
  }
  const celular = String(d?.celular ?? '').replace(/\D/g, '');
  if (celular.length < 8 || celular.length > 15) errores.push('El celular tiene que tener entre 8 y 15 números, con la característica.');
  const cbu = String(d?.cbu ?? '').replace(/\D/g, '');
  if (!cbuValido(cbu)) errores.push(cbu.length === 22 ? 'Ese CBU o CVU no es válido: revisá los números.' : 'El CBU o CVU tiene que tener 22 números.');
  if (errores.length) return { errores };
  return {
    datos: { dni, domicilio, estado_civil: estado, ...(estado === 'casado' ? { matrimonio_lugar: lugar, matrimonio_fecha: fecha } : {}), celular, cbu },
  };
}
