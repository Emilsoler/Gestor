-- Cobranzas: deudores en mora y su gestión (la app de docs/cobranzas/).
--
-- Comparte la base, el login y las barreras de acceso con el gestor de juicios: solo los
-- miembros de gestor.miembros pasan la puerta de la API (gestor_puerta) y las políticas de filas.
--
-- Una fila por deudor en public.deudores. Sus listas van en columnas jsonb, como en causas: así
-- heredan sin código extra la revisión (rev), el historial de cambios, el deshacer, las políticas
-- de acceso y el aviso en vivo, y un cambio de la app o de Claude nunca pisa otro en silencio.
--
--   telefonos   [{numero, nota}]
--   operaciones [{id, tipo, numero, fecha, cuotas, importe, concesionaria, vehiculo, ultimo_pago, nota}]
--   cuotas      [{id, op, n, de, vto, importe, doc, nota}]  lo que se debe, cuota por cuota (de: null = saldo de una cuota)
--   gastos      [{id, tipo: "gasto"|"honorarios", concepto, monto, fecha}]
--   pagos       [{id, creado, fecha, recibo, medio, imp: {capital, intereses, honorarios, <id de gasto>}, plan, nota}]
--   planes      [{id, fecha, estado, deuda, base, quita, anticipo, anticipo_vto, n, cada, tasa, primer_vto,
--                 caducidad, cuotas: [{n, vto, importe}], nota, cierre}]
--   gestiones   [{id, creado, fecha, tipo, texto, promesa_fecha?, promesa_monto?, hecha?}]
--   (creado: cuándo se anotó, AAAA-MM-DDTHH:MM:SS.mmmZ; ordena lo que tiene la misma fecha)
--
-- La liquidación (capital, intereses, honorarios y gastos, con los pagos imputados) no se guarda:
-- se calcula a la fecha que se pida, en la app (docs/cobranzas/calculo.js) y acá
-- (gestor.liquidacion_deudor), con las mismas reglas. Las pruebas comparan las dos.

-- ───────────────────────── Tablas ─────────────────────────

create table public.deudores (
  id              uuid primary key default gen_random_uuid(),
  nombre          text not null check (btrim(nombre) <> '' and length(nombre) <= 200),
  trato           text not null default '' check (length(trato) <= 100),
  dni             text not null default '' check (length(dni) <= 40),
  socio           text not null default '' check (length(socio) <= 40),
  domicilio       text not null default '' check (length(domicilio) <= 300),
  email           text not null default '' check (length(email) <= 200),
  telefonos       jsonb not null default '[]'::jsonb check (jsonb_typeof(telefonos) = 'array'),
  acreedor        text not null default 'Asociación Mutual Bell' check (length(acreedor) <= 200),
  estado          text not null default 'En gestión'
                  check (estado in ('En gestión', 'En juicio', 'Cancelado', 'Incobrable', 'Archivado')),
  expte           text not null default '' check (expte = '' or expte ~ '^[0-9]+$'),
  tasa            numeric(7,4) not null default 5 check (tasa >= 0 and tasa <= 100),
  hon_pct         numeric(7,4) not null default 0 check (hon_pct >= 0 and hon_pct <= 100),
  operaciones     jsonb not null default '[]'::jsonb check (jsonb_typeof(operaciones) = 'array'),
  cuotas          jsonb not null default '[]'::jsonb check (jsonb_typeof(cuotas) = 'array'),
  gastos          jsonb not null default '[]'::jsonb check (jsonb_typeof(gastos) = 'array'),
  pagos           jsonb not null default '[]'::jsonb check (jsonb_typeof(pagos) = 'array'),
  planes          jsonb not null default '[]'::jsonb check (jsonb_typeof(planes) = 'array'),
  gestiones       jsonb not null default '[]'::jsonb check (jsonb_typeof(gestiones) = 'array'),
  proxima         text not null default '' check (length(proxima) <= 500),
  vence           date,
  notas           text not null default '' check (length(notas) <= 20000),
  creado          date not null default (now() at time zone 'America/Argentina/Cordoba')::date,
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.deudores is
  'Cobranzas: una fila por deudor. `estado`: En gestión | En juicio | Cancelado | Incobrable | Archivado. `tasa`: interés moratorio simple, % mensual (cada 30 días, desde el vencimiento de cada cuota). `hon_pct`: honorarios, % sobre capital + intereses. `trato`: cómo nombrarlo en los mensajes (vacío: el nombre). `expte`: la causa del gestor, si pasó a juicio. Las listas (telefonos, operaciones, cuotas, gastos, pagos, planes, gestiones) se describen en supabase/migrations/0008_cobranzas.sql. La liquidación sale de gestor.liquidacion_deudor; para pagos y gestiones usar gestor.registrar_pago y gestor.anotar_gestion.';
comment on column public.deudores.cuotas is
  'Lo que se debe, cuota por cuota: [{id, op, n, de, vto:"AAAA-MM-DD", importe, doc, nota}]. `de` vacío: saldo de una cuota pagada en parte (en el listado de la Mutual, DOCUMENTO-R). Las cuotas con vencimiento futuro son "a vencer".';
comment on column public.deudores.pagos is
  'Pagos: [{id, fecha, recibo, medio, imp:{capital, intereses, honorarios, <id de gasto>: importe}, plan, nota}]. Lo imputado a capital cancela las cuotas en orden de vencimiento. `plan`: id del plan al que se aplica (vacío si no).';
comment on column public.deudores.planes is
  'Planes de pago: [{id, fecha, estado:"vigente"|"cumplido"|"caido"|"anulado", deuda, base, quita, anticipo, anticipo_vto, n, cada, tasa, primer_vto, caducidad, cuotas:[{n, vto, importe}], nota, cierre}]. Los pagos con `plan` se aplican a sus cuotas en orden.';
comment on column public.deudores.gestiones is
  'Historial de gestiones: [{id, fecha, tipo, texto, promesa_fecha?, promesa_monto?, hecha?}]. Tipos: gestor.tipos_gestion().';

create table public.modelos_mensaje (
  id              text primary key default gen_random_uuid()::text,
  titulo          text not null check (btrim(titulo) <> '' and length(titulo) <= 200),
  cuerpo          text not null check (btrim(cuerpo) <> '' and length(cuerpo) <= 5000),
  orden           integer not null default 0,
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.modelos_mensaje is
  'Modelos de mensajes de WhatsApp para los deudores. Los campos entre llaves dobles ({{nombre}}, {{deuda}}, {{plan_detalle}}…) se completan con los datos del deudor; la lista está en docs/cobranzas/app.js (CAMPOS_MENSAJE).';

create table public.ajustes_cobranzas (
  id              integer primary key default 1 check (id = 1),
  tasa            numeric(7,4) not null default 5 check (tasa >= 0 and tasa <= 100),
  tasa_sistema    numeric(7,4) not null default 9 check (tasa_sistema >= 0 and tasa_sistema <= 100),
  contado_pct     numeric(7,4) not null default 80 check (contado_pct > 0 and contado_pct <= 100),
  oferta_dias     integer not null default 7 check (oferta_dias between 1 and 90),
  gracia          integer not null default 5 check (gracia between 0 and 60),
  caducidad       integer not null default 2 check (caducidad between 1 and 24),
  acreedor        text not null default 'Asociación Mutual Bell' check (length(acreedor) <= 200),
  firma           text not null default 'Dr. Emiliano Soler · Abogado' check (length(firma) <= 300),
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.ajustes_cobranzas is
  'Una sola fila. `tasa`: la de los deudores nuevos (% mensual simple). `tasa_sistema`: la del sistema de la Mutual (% mensual capitalizable), solo para comparar. `contado_pct`: % de la deuda en una oferta de contado; `oferta_dias`: cuántos días vale. `gracia`: días después del vencimiento de una cuota de plan antes de contarla impaga. `caducidad`: cuotas impagas para que el plan caiga. `firma` y `acreedor` van en los mensajes.';

create trigger sello before insert or update on public.deudores          for each row execute function gestor.tg_sello();
create trigger sello before insert or update on public.modelos_mensaje   for each row execute function gestor.tg_sello();
create trigger sello before insert or update on public.ajustes_cobranzas for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.deudores          for each row execute function gestor.tg_auditar('id');
create trigger auditar after insert or update or delete on public.modelos_mensaje   for each row execute function gestor.tg_auditar('id');
create trigger auditar after insert or update or delete on public.ajustes_cobranzas for each row execute function gestor.tg_auditar('id');

-- ───────────────────────── Permisos ─────────────────────────
-- Igual que el resto: solo usuarios con sesión iniciada Y autorizados en gestor.miembros.

alter table public.deudores          enable row level security;
alter table public.modelos_mensaje   enable row level security;
alter table public.ajustes_cobranzas enable row level security;
create policy solo_miembros on public.deudores for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.modelos_mensaje for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.ajustes_cobranzas for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));

revoke all on public.deudores, public.modelos_mensaje, public.ajustes_cobranzas from public, anon, authenticated;
grant select, insert, update, delete on public.deudores, public.modelos_mensaje to authenticated;
grant select, update on public.ajustes_cobranzas to authenticated; -- una sola fila: se cambia, no se crea ni se borra
grant all on public.deudores, public.modelos_mensaje, public.ajustes_cobranzas to service_role;

do $$
begin
  alter publication supabase_realtime add table public.deudores, public.modelos_mensaje, public.ajustes_cobranzas;
exception when undefined_object or duplicate_object then null;
end $$;

-- Sin estadísticas del planificador, como las demás tablas (ver 0001).
create or replace function gestor.sin_estadisticas() returns void
language plpgsql set search_path = ''
as $$
declare r record;
begin
  for r in
    select c.relname, a.attname
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda', 'deudores', 'modelos_mensaje', 'ajustes_cobranzas')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de las tablas de la app (gestor y cobranzas). Volver a llamarla en cada migración que agregue columnas o tablas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Datos iniciales ─────────────────────────

insert into public.ajustes_cobranzas (id) values (1);

-- Mensajes para mandar por WhatsApp desde la ficha. Respetan el art. 8 bis de la Ley 24.240: en
-- la etapa extrajudicial, nada que se parezca a un reclamo judicial ni que intimide.
insert into public.modelos_mensaje (id, orden, titulo, cuerpo) values
('aviso', 1, 'Aviso de deuda',
 'Hola {{nombre}}, le escribo del Estudio Soler, en representación de {{acreedor}}.

Le informo que su {{operacion}} tiene {{detalle_cuotas}} sin pagar. Al {{fecha}}, el saldo adeudado es de {{deuda}}, intereses incluidos.

Me gustaría que lo conversemos para encontrar una forma de regularizarlo. Quedo a su disposición por este medio.

{{firma}}'),
('contado', 2, 'Propuesta de pago de contado',
 'Hola {{nombre}}, le escribo del Estudio Soler, en representación de {{acreedor}}.

Al {{fecha}}, su deuda asciende a {{deuda}}. Si la cancela de contado hasta el {{vence_oferta}}, puede hacerlo con un único pago de {{contado}}.

Si le interesa, respóndame este mensaje y le paso los datos para el pago.

{{firma}}'),
('plan', 3, 'Propuesta de plan de pagos',
 'Hola {{nombre}}, le escribo del Estudio Soler, en representación de {{acreedor}}.

Para regularizar su deuda ({{deuda}} al {{fecha}}), le propongo un plan de pagos: {{plan_detalle}}.

Si está de acuerdo, confírmeme por este medio y le envío el detalle por escrito.

{{firma}}'),
('recordatorio', 4, 'Recordatorio de cuota del plan',
 'Hola {{nombre}}, le recuerdo que el {{proxima_cuota_vto}} vence la cuota {{proxima_cuota_n}} de su plan de pagos, por {{proxima_cuota_importe}}.

Cualquier consulta, quedo a disposición.

{{firma}}'),
('atraso', 5, 'Cuotas del plan atrasadas',
 'Hola {{nombre}}, registramos {{plan_impagas}} de su plan de pagos sin abonar, por un total de {{plan_atrasado}}.

Le pido que las regularice a la brevedad para mantener vigente el plan. Si tuvo algún inconveniente, avíseme y lo vemos.

{{firma}}'),
('recibo', 6, 'Pago recibido',
 'Hola {{nombre}}, confirmo que recibimos su pago de {{ultimo_pago}} del {{ultimo_pago_fecha}}.

Su saldo pendiente es de {{saldo}}. Muchas gracias.

{{firma}}');

-- ───────────────────────── Funciones para Claude ─────────────────────────

create function gestor.estados_deudor() returns text[]
language sql immutable set search_path = ''
as $$ select array['En gestión','En juicio','Cancelado','Incobrable','Archivado'] $$;

create function gestor.tipos_gestion() returns text[]
language sql immutable set search_path = ''
as $$ select array['Llamada','WhatsApp','Visita','Email','Carta documento','Promesa de pago','Nota'] $$;
comment on function gestor.tipos_gestion() is 'Los tipos de gestión que acepta la ficha del deudor.';

-- Cuándo se anotó algo, como lo escribe la app (toISOString): ordena lo que tiene la misma fecha.
create function gestor.ahora() returns text
language sql stable set search_path = ''
as $$ select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Ids cortos para los elementos de las listas, como los que arma la app.
create function gestor.id_corto() returns text
language sql volatile set search_path = ''
as $$ select substr(md5(random()::text || clock_timestamp()::text), 1, 8) $$;

-- Un importe del jsonb, en centavos. Lo que no es un número (o es negativo) cuenta como cero.
create function gestor.centavos(v jsonb) returns bigint
language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(v) = 'number' then greatest(round((v #>> '{}')::numeric * 100), 0)::bigint
              when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then round((v #>> '{}')::numeric * 100)::bigint
              else 0 end
$$;

-- De centavos a pesos, con dos decimales.
create function gestor.pesos(c bigint) returns numeric
language sql immutable set search_path = ''
as $$ select round(c / 100.0, 2) $$;

-- Una fecha AAAA-MM-DD del jsonb, o null si no hay (o no tiene esa forma).
create function gestor.fecha_de(t text) returns date
language sql immutable set search_path = ''
as $$ select case when coalesce(t, '') ~ '^\d{4}-\d{2}-\d{2}$' then t::date end $$;

-- La liquidación de un deudor a una fecha. Mismas reglas que docs/cobranzas/calculo.js:
--   · Interés simple: tasa % mensual por cada 30 días, cuota por cuota desde su vencimiento,
--     sobre el capital que queda de esa cuota. Lo imputado a capital cancela las cuotas en orden
--     de vencimiento y, desde la fecha del pago, deja de generar interés.
--   · Honorarios: hon_pct % sobre capital + intereses devengados (los de las cuotas incluidas).
--   · Gastos y honorarios fijos: su importe, si su fecha es hasta la de la liquidación.
--   · Los pagos posteriores a la fecha no cuentan. Se redondea al centavo, cuota por cuota.
--   · p_a_vencer: incluir también el capital de las cuotas que todavía no vencieron.
--   · sistema: cómo lo calcula el sistema de la Mutual (tasa_sistema % mensual capitalizable sobre
--     el saldo de cada cuota vencida), solo para comparar.
create function gestor.liquidacion_deudor(p_deudor uuid, p_fecha date default null, p_a_vencer boolean default false)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  d public.deudores;
  f date := coalesce(p_fecha, gestor.hoy());
  v_ts numeric;
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
  sis_cap bigint := 0; sis_tot bigint := 0;
  g_pag bigint;
  tot_dev bigint := 0; tot_pag bigint := 0;
begin
  select * into d from public.deudores where id = p_deudor;
  if not found then raise exception 'No existe el deudor %', p_deudor; end if;
  select a2.tasa_sistema into v_ts from public.ajustes_cobranzas a2 where a2.id = 1;
  v_ts := coalesce(v_ts, 9);

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
      sis_cap := sis_cap + c_rem[i];
      sis_tot := sis_tot + round(c_rem[i] * power(1 + v_ts / 100, dias::numeric / 30))::bigint;
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
    'vencidas', vencidas, 'dias_mora', dias_mora,
    'sistema', jsonb_build_object('tasa', trim_scale(v_ts), 'capital', gestor.pesos(sis_cap),
                                  'intereses', gestor.pesos(sis_tot - sis_cap), 'total', gestor.pesos(sis_tot)));
end $$;
comment on function gestor.liquidacion_deudor(uuid, date, boolean) is
  'Liquidación de un deudor a una fecha (por defecto, hoy): cuotas con su interés, rubros (capital, intereses, honorarios, gastos) con lo devengado, lo pagado y el saldo, total, y la comparación con el sistema de la Mutual. Las mismas cuentas que la ficha de la app.';

-- Registra un pago y su imputación por rubro. p_imp: {"capital": 100000, "intereses": 20000, ...};
-- además de capital, intereses y honorarios, se puede imputar a un gasto por su id.
create function gestor.registrar_pago(
  p_deudor uuid, p_fecha date, p_imp jsonb, p_recibo text default '', p_medio text default '',
  p_nota text default '', p_plan text default '', p_autor text default 'Claude'
) returns jsonb
language plpgsql set search_path = ''
as $$
declare d public.deudores; k text; v jsonb; total numeric := 0; validos text[]; imp jsonb := '{}'::jsonb;
begin
  perform set_config('gestor.autor', p_autor, true);
  select * into d from public.deudores where id = p_deudor for update;
  if not found then raise exception 'No existe el deudor %', p_deudor; end if;
  if p_fecha is null then raise exception 'Falta la fecha del pago'; end if;
  if p_fecha > gestor.hoy() then raise exception 'La fecha del pago (%) es posterior a hoy', p_fecha; end if;
  if p_imp is null or jsonb_typeof(p_imp) <> 'object' then
    raise exception 'La imputación tiene que ser un objeto, por ejemplo {"capital": 100000, "intereses": 20000}';
  end if;
  validos := array['capital', 'intereses', 'honorarios'] || coalesce((select array_agg(g ->> 'id') from jsonb_array_elements(d.gastos) g), '{}');
  for k, v in select * from jsonb_each(p_imp) loop
    if not (k = any (validos)) then
      raise exception 'Rubro desconocido: "%". Se puede imputar a: %', k, array_to_string(validos, ', ');
    end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 then
      raise exception 'Lo imputado a % tiene que ser un número no negativo', k;
    end if;
    if (v #>> '{}')::numeric > 0 then
      imp := imp || jsonb_build_object(k, round((v #>> '{}')::numeric, 2));
      total := total + (v #>> '{}')::numeric;
    end if;
  end loop;
  if total <= 0 then raise exception 'El pago no imputa ningún importe'; end if;
  if coalesce(p_plan, '') <> '' and not exists
     (select 1 from jsonb_array_elements(d.planes) x where x ->> 'id' = p_plan and x ->> 'estado' = 'vigente') then
    raise exception 'El deudor no tiene un plan vigente con id %', p_plan;
  end if;
  update public.deudores
     set pagos = pagos || jsonb_build_array(jsonb_build_object(
           'id', gestor.id_corto(), 'creado', gestor.ahora(), 'fecha', to_char(p_fecha, 'YYYY-MM-DD'), 'recibo', coalesce(btrim(p_recibo), ''),
           'medio', coalesce(btrim(p_medio), ''), 'imp', imp, 'plan', coalesce(p_plan, ''), 'nota', coalesce(btrim(p_nota), '')))
   where id = p_deudor;
  return gestor.liquidacion_deudor(p_deudor, gestor.hoy());
end $$;
comment on function gestor.registrar_pago(uuid, date, jsonb, text, text, text, text, text) is
  'Agrega un pago con su imputación por rubro (capital, intereses, honorarios o el id de un gasto) y devuelve la liquidación a hoy. p_plan: id del plan vigente al que se aplica, si corresponde.';

-- Anota una gestión en el historial del deudor. Con p_promesa_fecha queda como promesa de pago.
create function gestor.anotar_gestion(
  p_deudor uuid, p_texto text, p_tipo text default 'Nota', p_fecha date default null,
  p_promesa_fecha date default null, p_promesa_monto numeric default null, p_autor text default 'Claude'
) returns text
language plpgsql set search_path = ''
as $$
declare g jsonb; v_nombre text;
begin
  perform set_config('gestor.autor', p_autor, true);
  if coalesce(btrim(p_texto), '') = '' then raise exception 'Falta el texto de la gestión'; end if;
  if not (p_tipo = any (gestor.tipos_gestion())) then
    raise exception 'Tipo de gestión desconocido: "%". Los tipos son: %', p_tipo, array_to_string(gestor.tipos_gestion(), ', ');
  end if;
  g := jsonb_build_object('id', gestor.id_corto(), 'creado', gestor.ahora(), 'fecha', to_char(coalesce(p_fecha, gestor.hoy()), 'YYYY-MM-DD'),
                          'tipo', p_tipo, 'texto', btrim(p_texto));
  if p_promesa_fecha is not null then
    g := g || jsonb_build_object('promesa_fecha', to_char(p_promesa_fecha, 'YYYY-MM-DD'), 'promesa_monto', coalesce(p_promesa_monto, 0));
  end if;
  update public.deudores set gestiones = gestiones || jsonb_build_array(g) where id = p_deudor returning nombre into v_nombre;
  if not found then raise exception 'No existe el deudor %', p_deudor; end if;
  return format('%s: gestión "%s" anotada', v_nombre, p_tipo);
end $$;
comment on function gestor.anotar_gestion(uuid, text, text, date, date, numeric, text) is
  'Anota una gestión (llamada, WhatsApp, visita…) en el historial del deudor; con p_promesa_fecha (y p_promesa_monto) queda como promesa de pago.';

-- Fija (o borra, con texto vacío) la próxima acción de un deudor y su fecha.
create function gestor.proxima_deudor(p_deudor uuid, p_texto text, p_vence date default null, p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare v_nombre text;
begin
  perform set_config('gestor.autor', p_autor, true);
  update public.deudores
     set proxima = coalesce(btrim(p_texto), ''),
         vence = case when coalesce(btrim(p_texto), '') = '' then null else p_vence end
   where id = p_deudor returning nombre into v_nombre;
  if not found then raise exception 'No existe el deudor %', p_deudor; end if;
  return format('%s: próxima acción %s', v_nombre, case when coalesce(btrim(p_texto), '') = '' then 'borrada' else 'anotada' end);
end $$;

-- ───────────────────────── Deshacer, con las tablas de cobranzas ─────────────────────────
-- Igual que en 0007, más deudores, modelos de mensaje y ajustes.
create or replace function gestor.deshacer(p_cambio bigint, p_forzar boolean default false, p_autor text default 'Claude') returns text
language plpgsql set search_path = ''
as $$
declare c gestor.cambios; posteriores integer; v_antes jsonb; v_estado text;
begin
  perform set_config('gestor.autor', p_autor, true);
  select * into c from gestor.cambios where id = p_cambio;
  if not found then raise exception 'No existe el cambio %', p_cambio; end if;
  select count(*) into posteriores from gestor.cambios where tabla = c.tabla and clave = c.clave and id > c.id;
  if posteriores > 0 and not p_forzar then
    raise exception 'Después del cambio % hubo % cambio(s) más en % %. Deshacerlo también los pisa: revisalos en gestor.cambios y, si corresponde, repetí con p_forzar => true.',
      p_cambio, posteriores, c.tabla, c.clave;
  end if;

  if c.operacion = 'alta' then
    raise exception 'El cambio % es el alta de % %. Deshacerla sería eliminar el registro, y esta función no elimina nada.',
      p_cambio, c.tabla, c.clave;
  end if;

  if c.tabla = 'causas' then
    v_antes := c.antes;
    if not (v_antes ? 'ubicacion') then
      v_antes := gestor.forma_0007(v_antes);
      select x.estado into v_estado from public.causas x where x.expte = c.clave;
      if found then v_antes := v_antes || jsonb_build_object('estado', v_estado); end if;
    end if;
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, ubicacion, estado, cautelar, situacion, proxima, vence, ultima, fecha, notas, historial, liquidacion, demandados, titulos)
    select r.expte, r.actor, r.demandado, r.tipo, r.nom, r.oficina, r.ubicacion, r.estado, r.cautelar, r.situacion, r.proxima, r.vence, r.ultima, r.fecha, r.notas, r.historial,
           nullif(r.liquidacion, 'null'::jsonb), coalesce(r.demandados, '[]'::jsonb), coalesce(r.titulos, '[]'::jsonb)
      from jsonb_populate_record(null::public.causas, v_antes) r
    on conflict (expte) do update set
      actor = excluded.actor, demandado = excluded.demandado, tipo = excluded.tipo, nom = excluded.nom, oficina = excluded.oficina,
      ubicacion = excluded.ubicacion, estado = excluded.estado, cautelar = excluded.cautelar, situacion = excluded.situacion,
      proxima = excluded.proxima, vence = excluded.vence, ultima = excluded.ultima,
      fecha = excluded.fecha, notas = excluded.notas, historial = excluded.historial, liquidacion = excluded.liquidacion,
      demandados = excluded.demandados, titulos = excluded.titulos;
  elsif c.tabla = 'acuerdos' then
    insert into public.acuerdos (id, deudor, expte, notas, cuotas, creado)
    select r.id, r.deudor, r.expte, r.notas, r.cuotas, r.creado from jsonb_populate_record(null::public.acuerdos, c.antes) r
    on conflict (id) do update set
      deudor = excluded.deudor, expte = excluded.expte, notas = excluded.notas, cuotas = excluded.cuotas, creado = excluded.creado;
  elsif c.tabla = 'plantillas' then
    insert into public.plantillas (id, titulo, cuerpo)
    select r.id, r.titulo, r.cuerpo from jsonb_populate_record(null::public.plantillas, c.antes) r
    on conflict (id) do update set titulo = excluded.titulo, cuerpo = excluded.cuerpo;
  elsif c.tabla = 'agenda' then
    insert into public.agenda (id, expte, titulo, cuerpo, fecha, realizar, estado, resultado, presentado, creado, ahora)
    select r.id, r.expte, r.titulo, r.cuerpo, r.fecha, r.realizar, r.estado, r.resultado, r.presentado, r.creado, r.ahora
      from jsonb_populate_record(null::public.agenda, c.antes) r
    on conflict (id) do update set
      expte = excluded.expte, titulo = excluded.titulo, cuerpo = excluded.cuerpo, fecha = excluded.fecha, realizar = excluded.realizar,
      estado = excluded.estado, resultado = excluded.resultado, presentado = excluded.presentado, creado = excluded.creado,
      ahora = excluded.ahora;
  elsif c.tabla = 'deudores' then
    insert into public.deudores (id, nombre, trato, dni, socio, domicilio, email, telefonos, acreedor, estado, expte, tasa, hon_pct,
                                 operaciones, cuotas, gastos, pagos, planes, gestiones, proxima, vence, notas, creado)
    select r.id, r.nombre, r.trato, r.dni, r.socio, r.domicilio, r.email, r.telefonos, r.acreedor, r.estado, r.expte, r.tasa, r.hon_pct,
           r.operaciones, r.cuotas, r.gastos, r.pagos, r.planes, r.gestiones, r.proxima, r.vence, r.notas, r.creado
      from jsonb_populate_record(null::public.deudores, c.antes) r
    on conflict (id) do update set
      nombre = excluded.nombre, trato = excluded.trato, dni = excluded.dni, socio = excluded.socio, domicilio = excluded.domicilio,
      email = excluded.email, telefonos = excluded.telefonos, acreedor = excluded.acreedor, estado = excluded.estado,
      expte = excluded.expte, tasa = excluded.tasa, hon_pct = excluded.hon_pct, operaciones = excluded.operaciones,
      cuotas = excluded.cuotas, gastos = excluded.gastos, pagos = excluded.pagos, planes = excluded.planes,
      gestiones = excluded.gestiones, proxima = excluded.proxima, vence = excluded.vence, notas = excluded.notas,
      creado = excluded.creado;
  elsif c.tabla = 'modelos_mensaje' then
    insert into public.modelos_mensaje (id, titulo, cuerpo, orden)
    select r.id, r.titulo, r.cuerpo, r.orden from jsonb_populate_record(null::public.modelos_mensaje, c.antes) r
    on conflict (id) do update set titulo = excluded.titulo, cuerpo = excluded.cuerpo, orden = excluded.orden;
  elsif c.tabla = 'ajustes_cobranzas' then
    update public.ajustes_cobranzas a set
      tasa = r.tasa, tasa_sistema = r.tasa_sistema, contado_pct = r.contado_pct, oferta_dias = r.oferta_dias,
      gracia = r.gracia, caducidad = r.caducidad, acreedor = r.acreedor, firma = r.firma
      from jsonb_populate_record(null::public.ajustes_cobranzas, c.antes) r
     where a.id = 1;
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Nada del esquema privado es alcanzable por los roles de la API (ver 0001).
revoke all on all tables in schema gestor from public, anon, authenticated;
revoke all on all functions in schema gestor from public, anon, authenticated;

-- Que la API vea las tablas nuevas sin esperar.
notify pgrst, 'reload schema';
