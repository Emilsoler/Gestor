/**
 * Puente de Drive del estudio — Google Apps Script.
 *
 * Qué hace: recibe de la función `guardar-demanda` de Supabase los archivos de una demanda (los PDF adjuntos, el Word y la
 * demanda en PDF con firma) y los guarda en la carpeta del demandado, dentro de «J01. Asociacion Mutual Bell / EN TRÁMITE».
 * Si la carpeta del demandado no existe, la crea. Corre con la cuenta de Drive de quien lo publica, así que solo puede tocar
 * lo que esa persona ya puede tocar.
 *
 * Cómo se instala (una sola vez): ver docs en CLAUDE.md, «Guardar en Drive». En resumen: nuevo proyecto en script.google.com,
 * pegar este archivo, definir la propiedad de script CLAVE (una clave larga inventada), Implementar → Aplicación web
 * (Ejecutar como: yo · Quién tiene acceso: cualquier persona), y pasarle a Supabase la dirección y la clave
 * (secretos DRIVE_PUENTE_URL y DRIVE_PUENTE_CLAVE de la función `guardar-demanda`).
 *
 * Seguridad: la dirección de la aplicación web es pública por definición, por eso cada pedido lleva la CLAVE y, sin ella,
 * no se hace nada. Este archivo no lleva ningún dato: la clave vive en «Propiedades del proyecto».
 */
var RUTA = ['J01. Asociacion Mutual Bell', 'EN TRÁMITE']; // desde Mi unidad hacia abajo

/** Para comparar nombres: sin tildes, en mayúsculas, sin comas ni espacios de más («ARIAUDO, Elio» = «ariaudo elio»). */
function normalizar_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[,.;]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

function salida_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** La carpeta «EN TRÁMITE», siguiendo RUTA. */
function raiz_() {
  var carpeta = DriveApp.getRootFolder();
  for (var i = 0; i < RUTA.length; i++) {
    var it = carpeta.getFoldersByName(RUTA[i]);
    if (!it.hasNext()) {
      // La carpeta puede estar compartida o fuera de Mi unidad: se busca por nombre en todo el Drive.
      it = DriveApp.getFoldersByName(RUTA[i]);
      if (!it.hasNext()) throw new Error('No encuentro la carpeta «' + RUTA[i] + '»');
    }
    carpeta = it.next();
  }
  return carpeta;
}

/** La carpeta del demandado (si hay una con el mismo nombre normalizado) o una nueva. */
function carpetaDe_(raiz, nombre) {
  var buscado = normalizar_(nombre), it = raiz.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (normalizar_(f.getName()) === buscado) return { carpeta: f, creada: false };
  }
  return { carpeta: raiz.createFolder(nombre), creada: true };
}

/** Un nombre que no pise a otro archivo de la carpeta: «x.pdf», «x (2).pdf»… */
function nombreLibre_(carpeta, nombre) {
  if (!carpeta.getFilesByName(nombre).hasNext()) return nombre;
  var punto = nombre.lastIndexOf('.'), base = punto > 0 ? nombre.slice(0, punto) : nombre, ext = punto > 0 ? nombre.slice(punto) : '';
  for (var n = 2; n < 100; n++) {
    var candidato = base + ' (' + n + ')' + ext;
    if (!carpeta.getFilesByName(candidato).hasNext()) return candidato;
  }
  return base + ' (' + Date.now() + ')' + ext;
}

function doPost(e) {
  var d;
  try { d = JSON.parse(e.postData.contents); } catch (x) { return salida_({ ok: false, error: 'pedido' }); }
  var clave = PropertiesService.getScriptProperties().getProperty('CLAVE');
  if (!clave || d.clave !== clave) return salida_({ ok: false, error: 'clave' });
  if (!d.carpeta || !d.archivos || !d.archivos.length) return salida_({ ok: false, error: 'pedido' });
  try {
    var r = carpetaDe_(raiz_(), String(d.carpeta));
    var guardados = [];
    d.archivos.forEach(function (a) {
      var nombre = nombreLibre_(r.carpeta, String(a.nombre));
      r.carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(a.base64), a.tipo, nombre));
      guardados.push(nombre);
    });
    return salida_({ ok: true, carpeta: r.carpeta.getName(), url: r.carpeta.getUrl(), creada: r.creada, guardados: guardados });
  } catch (err) {
    return salida_({ ok: false, error: 'drive', detalle: String(err && err.message || err) });
  }
}

/** Para probar desde el editor (Ejecutar): no guarda nada, solo comprueba que encuentra la carpeta «EN TRÁMITE». */
function probar() {
  Logger.log('Encontré: ' + raiz_().getName() + ' · ' + raiz_().getUrl());
}
