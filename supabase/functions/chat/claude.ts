// La llamada a la API de Claude y sus errores, dichos de forma que se entiendan en la app.

export class ErrorClaude extends Error {
  constructor(mensaje: string, public status: number, public tipo: string) { super(mensaje); }
}

const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export async function pedirAClaude(cuerpo: Record<string, unknown>, { clave, url }: { clave: string; url: string }) {
  for (let intento = 0; ; intento++) {
    let r: Response;
    try {
      r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
    } catch {
      if (intento < 1) { await espera(1500); continue; }
      throw new ErrorClaude('No se pudo conectar con Claude. Probá de nuevo en un momento.', 0, 'red');
    }
    const texto = await r.text();
    let datos: any = null;
    try { datos = JSON.parse(texto); } catch { /* lo de abajo lo explica */ }
    if (r.ok && datos) return datos;
    const tipo = datos?.error?.type || '', mensaje = datos?.error?.message || texto.slice(0, 300);
    // Saturación o una falla pasajera del otro lado: se reintenta una vez.
    if ((r.status === 529 || r.status >= 500) && intento < 1) { await espera(2000); continue; }
    throw new ErrorClaude(traducir(r.status, tipo, mensaje), r.status, tipo);
  }
}

function traducir(status: number, tipo: string, mensaje: string) {
  if (status === 401) return 'La clave de la API de Claude no es válida. Hay que revisar el secreto ANTHROPIC_API_KEY en Supabase.';
  if (/credit balance|purchase credits|billing/i.test(mensaje)) return 'La cuenta de la API de Claude se quedó sin crédito. Se carga saldo en la Consola de Claude.';
  if (/spend limit|spending limit|usage limit/i.test(mensaje)) return 'Se llegó al tope de gasto de la API de Claude de este mes. Se puede subir en la Consola de Claude.';
  if (status === 429) return 'Claude recibió demasiados pedidos seguidos. Probá de nuevo en un minuto.';
  if (status === 529 || status >= 500) return 'Claude está saturado en este momento. Probá de nuevo en un rato.';
  if (status === 413 || /too long|too many tokens|context/i.test(mensaje)) return 'La conversación quedó demasiado larga. Empezá una nueva.';
  if (status === 400 && /thinking|signature|block/i.test(mensaje)) return 'La conversación quedó en un estado que Claude no acepta. Empezá una nueva.';
  return `Claude no pudo responder (${status}${tipo ? ', ' + tipo : ''}): ${mensaje}`;
}
