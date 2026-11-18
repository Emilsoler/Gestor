// Foto del vehículo del cotizador para agencias: cómo se encuentra la dirección en la respuesta de la guía.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64, tipoImagen, urlDeFoto } from '../../supabase/functions/agencias/foto.js';

const API = 'https://api.infoauto.com.ar/';
test('la dirección de la foto, en los formatos posibles', () => {
  assert.equal(urlDeFoto([{ id: 1, url: 'https://cdn.x.com/a.jpg' }], API), 'https://cdn.x.com/a.jpg');
  assert.equal(urlDeFoto({ photos: [{ image: 'https://cdn.x.com/b.png' }] }, API), 'https://cdn.x.com/b.png');
  assert.equal(urlDeFoto(['https://cdn.x.com/c.webp'], API), 'https://cdn.x.com/c.webp');
  assert.equal(urlDeFoto({ data: [{ large: '/img/d.jpg' }] }, API), 'https://api.infoauto.com.ar/img/d.jpg');
  assert.equal(urlDeFoto([], API), null);
  assert.equal(urlDeFoto(null, API), null);
  assert.equal(urlDeFoto([{ url: 'http://otro.com/e.jpg' }], API), null); // sin https, no
  assert.equal(urlDeFoto([{ url: 'javascript:alert(1)' }], API), null);
  assert.equal(urlDeFoto([{ url: 'http://127.0.0.1:54343/f.jpg' }], 'http://127.0.0.1:54343/'), 'http://127.0.0.1:54343/f.jpg'); // pruebas locales
});

test('el tipo de imagen sale de los bytes', () => {
  assert.equal(tipoImagen(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(tipoImagen(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(tipoImagen(new TextEncoder().encode('<html>no es una foto</html>')), null);
  assert.equal(base64(new Uint8Array([104, 111, 108, 97])), 'aG9sYQ==');
});
