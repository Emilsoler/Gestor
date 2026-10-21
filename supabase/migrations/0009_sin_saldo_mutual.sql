-- Sin saldo "según la Mutual".
--
-- Por pedido de la persona, la deuda de cada deudor es una sola cuenta: la de la app (el saldo de
-- las cuotas vencidas más sus intereses, a la tasa del deudor, con los honorarios y gastos que
-- tenga). Hasta acá la liquidación traía además `sistema`, el 9 % mensual capitalizable del sistema
-- de la Mutual, para comparar con su listado, y la app lo mostraba en la ficha, el tablero, la
-- liquidación, los Excel y un campo de los mensajes. docs/cobranzas/calculo.js ya no lo calcula y
-- esta función tampoco: las dos siguen dando exactamente lo mismo.
--
-- La columna `ajustes_cobranzas.tasa_sistema` queda en la tabla, sin uso (como `causas.etiquetas`
-- en 0007): no hace falta borrarla y `gestor.deshacer` la sigue nombrando al restaurar los ajustes.

create or replace function gestor.liquidacion_deudor(p_deudor uuid, p_fecha date default null, p_a_vencer boolean default false)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  d public.deudores;
  f date := coalesce(p_fecha, gestor.hoy());
  c_id text[] := '{}'; c_n int[] := '{}'; c_de int[] := '{}'; c_vto date[] := '{}'; c_doc text[] := '{}';
  c_imp bigint[] := '{}'; c_rem bigint[] := '{}'; c_t date[] := '{}'; c_acc numeric[] := '{}';
  n int := 0; i int; r record; p record; k text; v jsonb;
  resto bigint; a bigint;
  pag_int bigint := 0; pag_hon bigint := 0; sin_cuotas bigint := 0;
  pag_gasto jsonb := '{}'::jsonb;
  cuotas jsonb := '[]'::jsonb; rubros jsonb := '[]'::jsonb;
  cap_dev bigint := 0; cap_saldo bigint := 0; int_dev bigint := 0; hon_dev bigint := 0;
  a_vencer bigint := 0; anticipado bigint := 0; interes bigint; dias int; incl boolean;
  vencidas int := 0; dias_mora int := 0;
  g_pag bigint;
  tot_dev bigint := 0; tot_pag bigint := 0;
begin
  select * into d from public.deudores where id = p_deudor;
  if not found then raise exception 'No existe el deudor %', p_deudor; end if;

  -- Las cuotas, en el orden en que las cancela lo imputado a capital: vencimiento, número, orden de carga.
  for r in
    select e.v ->> 'id' as id, nullif(e.v ->> 'n', '')::numeric::int as n, nullif(e.v ->> 'de', '')::numeric::int as de,
           gestor.fecha_de(e.v ->> 'vto') as vto, coalesce(e.v ->> 'doc', '') as doc, gestor.centavos(e.v -> 'importe') as imp
      from jsonb_array_elements(d.cuotas) with ordinality e(v, ord)
     order by gestor.fecha_de(e.v ->> 'vto') nulls first, nullif(e.v ->> 'n', '')::numeric::int nulls last, e.ord
  loop
    n := n + 1;
    c_id[n] := coalesce(r.id, ''); c_n[n] := r.n; c_de[n] := nullif(r.de, 0); c_vto[n] := r.vto; c_doc[n] := r.doc;
    c_imp[n] := r.imp; c_rem[n] := r.imp; c_t[n] := r.vto; c_acc[n] := 0;
  end loop;

  -- Los pagos hasta la fecha, en orden.
  for p in
    select gestor.fecha_de(e.v ->> 'fecha') as fecha, coalesce(e.v -> 'imp', '{}'::jsonb) as imp
      from jsonb_array_elements(d.pagos) with ordinality e(v, ord)
     where gestor.fecha_de(e.v ->> 'fecha') <= f
     order by gestor.fecha_de(e.v ->> 'fecha'), e.ord
  loop
    resto := gestor.centavos(p.imp -> 'capital');
    i := 1;
    while resto > 0 and i <= n loop
      if c_rem[i] > 0 then
        a := least(c_rem[i], resto);
        -- Lo que corrió hasta el pago, con el capital de antes; desde el pago, con el nuevo.
        if c_vto[i] is not null and p.fecha > c_t[i] then
          c_acc[i] := c_acc[i] + c_rem[i]::numeric * (p.fecha - c_t[i]);
          c_t[i] := p.fecha;
        end if;
        c_rem[i] := c_rem[i] - a;
        resto := resto - a;
      end if;
      i := i + 1;
    end loop;
    sin_cuotas := sin_cuotas + resto;
    pag_int := pag_int + gestor.centavos(p.imp -> 'intereses');
    pag_hon := pag_hon + gestor.centavos(p.imp -> 'honorarios');
    if jsonb_typeof(p.imp) = 'object' then
      for k, v in select * from jsonb_each(p.imp) loop
        if k not in ('capital', 'intereses', 'honorarios') then
          pag_gasto := jsonb_set(pag_gasto, array[k], to_jsonb(coalesce((pag_gasto ->> k)::bigint, 0) + gestor.centavos(v)));
        end if;
      end loop;
    end if;
  end loop;

  for i in 1 .. n loop
    if c_vto[i] is not null and f > c_t[i] then
      c_acc[i] := c_acc[i] + c_rem[i]::numeric * (f - c_t[i]);
    end if;
    interes := round(c_acc[i] * d.tasa / 3000)::bigint;
    dias := case when c_vto[i] is not null and c_vto[i] < f then f - c_vto[i] else 0 end;
    incl := c_vto[i] is null or c_vto[i] <= f or p_a_vencer;
    int_dev := int_dev + interes;
    if incl then
      cap_dev := cap_dev + c_imp[i]; cap_saldo := cap_saldo + c_rem[i];
    else
      a_vencer := a_vencer + c_rem[i]; anticipado := anticipado + (c_imp[i] - c_rem[i]);
    end if;
    if (c_vto[i] is null or c_vto[i] <= f) and c_rem[i] > 0 then
      vencidas := vencidas + 1;
      dias_mora := greatest(dias_mora, dias);
    end if;
    cuotas := cuotas || jsonb_build_array(jsonb_build_object(
      'id', c_id[i], 'n', c_n[i], 'de', c_de[i], 'vto', to_char(c_vto[i], 'YYYY-MM-DD'), 'doc', c_doc[i],
      'importe', gestor.pesos(c_imp[i]), 'pagado', gestor.pesos(c_imp[i] - c_rem[i]), 'saldo', gestor.pesos(c_rem[i]),
      'dias', dias, 'interes', gestor.pesos(interes), 'incluida', incl));
  end loop;

  hon_dev := round((cap_dev + int_dev) * d.hon_pct / 100)::bigint;

  rubros := jsonb_build_array(
    jsonb_build_object('id', 'capital', 'nombre', 'Capital', 'tipo', 'capital', 'devengado', gestor.pesos(cap_dev),
                       'pagado', gestor.pesos(cap_dev - cap_saldo), 'saldo', gestor.pesos(cap_saldo)),
    jsonb_build_object('id', 'intereses', 'nombre', 'Intereses', 'tipo', 'intereses', 'devengado', gestor.pesos(int_dev),
                       'pagado', gestor.pesos(pag_int), 'saldo', gestor.pesos(int_dev - pag_int)));
  tot_dev := cap_dev + int_dev; tot_pag := (cap_dev - cap_saldo) + pag_int;
  if d.hon_pct > 0 or pag_hon > 0 then
    rubros := rubros || jsonb_build_array(jsonb_build_object('id', 'honorarios', 'nombre', 'Honorarios', 'tipo', 'honorarios',
                       'devengado', gestor.pesos(hon_dev), 'pagado', gestor.pesos(pag_hon), 'saldo', gestor.pesos(hon_dev - pag_hon)));
    tot_dev := tot_dev + hon_dev; tot_pag := tot_pag + pag_hon;
  end if;
  -- Gastos y honorarios fijos, si su fecha es hasta la de la liquidación (o no tienen).
  for r in
    select e.v ->> 'id' as id, coalesce(nullif(btrim(e.v ->> 'concepto'), ''), 'Gasto') as concepto,
           case when e.v ->> 'tipo' = 'honorarios' then 'honorarios' else 'gasto' end as tipo, gestor.centavos(e.v -> 'monto') as monto
      from jsonb_array_elements(d.gastos) with ordinality e(v, ord)
     where gestor.fecha_de(e.v ->> 'fecha') is null or gestor.fecha_de(e.v ->> 'fecha') <= f
     order by e.ord
  loop
    g_pag := coalesce((pag_gasto ->> r.id)::bigint, 0);
    rubros := rubros || jsonb_build_array(jsonb_build_object('id', coalesce(r.id, ''), 'nombre', r.concepto, 'tipo', r.tipo,
                       'devengado', gestor.pesos(r.monto), 'pagado', gestor.pesos(g_pag), 'saldo', gestor.pesos(r.monto - g_pag)));
    tot_dev := tot_dev + r.monto; tot_pag := tot_pag + g_pag;
  end loop;

  return jsonb_build_object(
    'fecha', to_char(f, 'YYYY-MM-DD'), 'tasa', trim_scale(d.tasa), 'hon_pct', trim_scale(d.hon_pct), 'a_vencer', p_a_vencer,
    'cuotas', cuotas, 'rubros', rubros,
    'total', jsonb_build_object('devengado', gestor.pesos(tot_dev), 'pagado', gestor.pesos(tot_pag), 'saldo', gestor.pesos(tot_dev - tot_pag)),
    'capital_a_vencer', gestor.pesos(a_vencer), 'capital_anticipado', gestor.pesos(anticipado), 'capital_sin_cuotas', gestor.pesos(sin_cuotas),
    'vencidas', vencidas, 'dias_mora', dias_mora);
end $$;
comment on function gestor.liquidacion_deudor(uuid, date, boolean) is
  'Liquidación de un deudor a una fecha (por defecto, hoy): cuotas con su interés, rubros (capital, intereses, honorarios, gastos) con lo devengado, lo pagado y el saldo, y el total. Las mismas cuentas que la ficha de la app.';

comment on table public.ajustes_cobranzas is
  'Una sola fila. `tasa`: la de los deudores nuevos (% mensual simple). `contado_pct`: % de la deuda en una oferta de contado; `oferta_dias`: cuántos días vale. `gracia`: días después del vencimiento de una cuota de plan antes de contarla impaga. `caducidad`: cuotas impagas para que el plan caiga. `firma` y `acreedor` van en los mensajes. `tasa_sistema`: sin uso desde 0009.';
comment on column public.ajustes_cobranzas.tasa_sistema is
  'Sin uso desde la migración 0009: el saldo según el sistema de la Mutual ya no se calcula ni se muestra.';

-- Reemplazar la función conserva sus permisos; igual, que quede explícito (ver 0001).
revoke all on function gestor.liquidacion_deudor(uuid, date, boolean) from public, anon, authenticated;
