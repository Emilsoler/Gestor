-- Acuerdos de pago con tres rubros, cada uno con sus cuotas: capital (capital, intereses y gastos),
-- martillero (honorarios del martillero) y abogado (honorarios del abogado). Cada cuota dice su rubro.
-- `cuotas` ya era jsonb, así que no cambia ninguna columna: solo la descripción de la tabla. Las cuotas
-- cargadas antes no tienen rubro y son de capital (la app se lo escribe la próxima vez que las toca).
comment on table public.acuerdos is
  'Acuerdos de pago. `expte` vincula (opcionalmente) con una causa. `cuotas` es un array de {rubro:"capital"|"martillero"|"abogado", vence:"AAAA-MM-DD", monto, estado:"pendiente"|"pagada"|"impaga", pago:"AAAA-MM-DD"|""}: capital es capital, intereses y gastos; martillero y abogado, sus honorarios. Una cuota sin rubro es de capital.';
