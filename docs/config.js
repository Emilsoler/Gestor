// Conexión de la app con su base de datos (Supabase).
//
// `key` es la clave PÚBLICA del proyecto (la "publishable"): está pensada para ir en
// el navegador y verse. Lo que protege los datos es el login y las reglas de la base,
// que solo dejan leer y escribir a los usuarios autorizados. La clave secreta
// (service_role / secret) NO va nunca en este archivo ni en este repositorio.
window.GESTOR_CONFIG = {
  url: 'https://udfmoxnehgoihzsyrpvy.supabase.co',
  key: 'sb_publishable_p2DnLiy6F-cZfo1dRYg88w_8PEzO3qR',
};
