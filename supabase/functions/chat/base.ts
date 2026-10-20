// La base de datos, vista desde el chat: la misma API (PostgREST) y la misma sesión que usa la
// persona en la app. Así valen las mismas tres barreras (la puerta de la API, las políticas de
// filas y las estadísticas apagadas) y el chat no puede hacer nada que la persona no pueda.
// El encabezado `x-gestor-via: chat` solo cambia la firma: lo que se cambie queda como "Claude"
// (gestor.autor, migración 0005).

export class ErrorBase extends Error {
  constructor(mensaje: string, public status: number, public codigo: string) { super(mensaje); }
}

export class Base {
  constructor(private url: string, private clave: string, private jwt: string) {}

  private async pedir(ruta: string, opciones: { method?: string; body?: unknown; prefer?: string } = {}) {
    const headers: Record<string, string> = {
      apikey: this.clave, authorization: `Bearer ${this.jwt}`, 'x-gestor-via': 'chat', accept: 'application/json',
    };
    if (opciones.body !== undefined) headers['content-type'] = 'application/json';
    if (opciones.prefer) headers.prefer = opciones.prefer;
    const r = await fetch(`${this.url}/rest/v1/${ruta}`, {
      method: opciones.method ?? 'GET', headers, body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
    });
    const texto = await r.text();
    let datos: any = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch { /* respuesta que no es JSON: va en el error */ }
    if (!r.ok) throw new ErrorBase(datos?.message || texto.slice(0, 200) || `La base respondió ${r.status}`, r.status, datos?.code || '');
    return datos;
  }

  rpc(funcion: string, args: Record<string, unknown> = {}) { return this.pedir(`rpc/${funcion}`, { method: 'POST', body: args }); }
  leer(tabla: string, consulta: string) { return this.pedir(`${tabla}?${consulta}`); }
  insertar(tabla: string, fila: Record<string, unknown>) {
    return this.pedir(`${tabla}?select=*`, { method: 'POST', body: fila, prefer: 'return=representation' });
  }
  /** Devuelve las filas cambiadas: ninguna si el filtro (por ejemplo la revisión) ya no coincide. */
  cambiar(tabla: string, filtro: string, campos: Record<string, unknown>) {
    return this.pedir(`${tabla}?${filtro}&select=*`, { method: 'PATCH', body: campos, prefer: 'return=representation' });
  }
}
