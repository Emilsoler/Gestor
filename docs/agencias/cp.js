// Código postal según la localidad (pedido de la persona, 27/11/2026): al escribir la localidad se completa solo.
// Va dentro de la app para no mandar datos del cliente a ningún sitio externo. NO es una base completa ni oficial:
// son localidades de la provincia de Córdoba en las que coincidieron dos listados publicados (argentinatelefonos.com y
// americaopina.com, consultados el 27/11/2026). Quedaron afuera las dudosas (Camilo Aldao, Laboulaye y Calchín, donde
// esos listados parecen equivocados), los nombres repetidos dentro de la provincia y la ciudad de Córdoba, que tiene muchos.
// El dato sale en el Formulario 03: no agregar ninguno sin confirmarlo, y el campo siempre se puede corregir a mano.
const CORDOBA = {
  'bell ville': '2550', 'villa maria': '5900', 'villa nueva': '5903', 'marcos juarez': '2580', leones: '2594', morrison: '2568',
  ballesteros: '2572', 'ballesteros sud': '2572', 'san antonio de litin': '2559', cintra: '2559', 'san marcos sud': '2566',
  'monte leña': '2564', chilibroste: '2561', noetinger: '2563', 'justiniano posse': '2553', 'monte maiz': '2659',
  'wenceslao escalante': '2655', laborde: '2657', ordoñez: '2555', idiazabal: '2557', pascanas: '2679', ucacha: '2677',
  inriville: '2587', 'monte buey': '2589', 'corral de bustos': '2645', 'cruz alta': '2189', 'general baldissera': '2583',
  'los surgentes': '2581', 'alejo ledesma': '2662', canals: '2650', 'general roca': '2592', saira: '2525', oliva: '5980',
  'james craik': '5984', 'villa del rosario': '5963', 'rio tercero': '5850', 'rio cuarto': '5800', 'cruz del eje': '5280',
  'villa carlos paz': '5152', 'alta gracia': '5186', 'rio segundo': '5960', pilar: '5972', 'jesus maria': '5220',
  'la carlota': '2670', 'las varillas': '5940', arroyito: '2434', morteros: '2421', 'villa dolores': '5870', cosquin: '5166',
  hernando: '5929', tancacha: '5933', 'ana zumaran': '5905', chazon: '2675', 'tio pujio': '5936', alicia: '5949',
  'la playosa': '5911', 'arroyo cabral': '5917', pasco: '5925', colazo: '5965', oncativo: '5986', 'laguna larga': '5974',
  'villa ascasubi': '5935', 'las perdices': '5921',
};

// Sin tildes (la ñ se conserva), sin puntos y con un solo espacio.
const normal = (s) => String(s ?? '').toLowerCase().replace(/ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\u0001/g, 'ñ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

/** El código postal de una localidad de Córdoba, o '' si no está en la lista o la provincia escrita es otra. */
export function cpDe(localidad, provincia = '') {
  const p = normal(provincia);
  if (p && !'cordoba'.startsWith(p) && p !== 'cba') return '';
  const l = normal(localidad);
  return Object.hasOwn(CORDOBA, l) ? CORDOBA[l] : '';
}

/**
 * Lo que tiene que quedar en el casillero del CP al cambiar la localidad o la provincia. `puesto` es lo último que
 * completó la app: lo escrito a mano no se pisa. Devuelve { cp, puesto }.
 */
export function completarCP(actual, puesto, localidad, provincia) {
  if (actual && actual !== puesto) return { cp: actual, puesto: '' };
  const cp = cpDe(localidad, provincia);
  return { cp, puesto: cp };
}
