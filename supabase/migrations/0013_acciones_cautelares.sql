-- Acciones cautelares: el escrito que pide un embargo de haberes o un secuestro automotor va a la
-- agenda con su oficio adjunto (botón "Acción cautelar" de la ficha).
--
-- 1. `agenda.adjuntos`: los oficios que van con el escrito. Cada uno se guarda como el texto ya
--    completado, con las marcas de docs/oficio.js: [{nombre, modelo, doc, sha256, datos}]. El PDF
--    no se guarda: la app (para verlo o bajarlo) y la tarea del SAC (para adjuntarlo) lo arman
--    igual a partir de ese texto, con el mismo programa y las mismas tipografías. `sha256` lo pone
--    la base: la tarea copia el texto y, antes de armar el PDF, confirma con esa huella que lo
--    copió exacto. `datos` son los del formulario, para proponerlos la próxima vez.
-- 2. gestor.agenda_adjuntos(id): lo que la tarea necesita de cada adjunto, en renglones cortos de
--    solo ASCII y sin comillas, cada uno con su control (gestor.texto_seguro): si uno se copia
--    mal, se sabe cuál.
-- 3. Las cuatro plantillas de las acciones cautelares: los modelos de oficio (que la ficha completa
--    con los datos de la causa) y los escritos "Solicita…". Se pueden corregir en Plantillas.
-- 4. gestor.deshacer restaura también los adjuntos; gestor.sin_estadisticas vuelve a cubrir
--    consultas_cheques, que 0012 había dejado afuera de la lista.

select set_config('gestor.autor', 'Claude', true);

-- ───────────────────────── Adjuntos de la agenda ─────────────────────────

alter table public.agenda add column adjuntos jsonb not null default '[]'::jsonb;
alter table public.agenda add constraint agenda_adjuntos_forma
  check (jsonb_typeof(adjuntos) = 'array' and jsonb_array_length(adjuntos) <= 3 and octet_length(adjuntos::text) <= 60000);
comment on column public.agenda.adjuntos is
  'Oficios que van adjuntos al escrito: [{nombre: "… .pdf", modelo: id de la plantilla, doc: el oficio completado (marcas de docs/oficio.js), sha256: huella de doc (la pone la base), datos: los del formulario}]. El PDF se arma a partir de doc. La tarea del SAC los lee con gestor.agenda_adjuntos(id).';

-- La huella de cada adjunto la calcula la base, y un adjunto no cambia una vez que la tarea tomó el escrito.
create function gestor.tg_adjuntos() returns trigger
language plpgsql set search_path = ''
as $$
declare e jsonb; r jsonb := '[]'::jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.adjuntos is not distinct from old.adjuntos then return new; end if;
    if old.estado in ('presentando', 'presentado') then
      raise exception '%: sus adjuntos ya no se cambian', case old.estado when 'presentado' then 'El escrito ya se presentó' else 'El escrito se está presentando' end;
    end if;
  end if;
  for e in select x from jsonb_array_elements(new.adjuntos) as x loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Cada adjunto tiene que ser un objeto'; end if;
    if coalesce(e->>'nombre', '') !~ '^[A-Za-z0-9 ._-]{1,150}\.pdf$' then
      raise exception 'Nombre de adjunto inválido: "%" (sin acentos ni signos, terminado en .pdf)', coalesce(e->>'nombre', '');
    end if;
    if btrim(coalesce(e->>'doc', '')) = '' or length(e->>'doc') > 20000 then
      raise exception 'El adjunto "%" no tiene texto, o es demasiado largo', e->>'nombre';
    end if;
    r := r || jsonb_build_array(e || jsonb_build_object('sha256', encode(sha256(convert_to(e->>'doc', 'UTF8')), 'hex')));
  end loop;
  new.adjuntos := r;
  return new;
end $$;
create trigger adjuntos before insert or update of adjuntos on public.agenda
  for each row execute function gestor.tg_adjuntos();

comment on table public.agenda is
  'Escritos para presentar en el SAC. `fecha`: el día en que se presentan (la tarea diaria toma los pendientes de ese día o atrasados). `ahora`: la persona pidió presentarlo en el momento (botón «Ahora»). `realizar`: si no está vacío, el texto de la próxima acción que se da por realizada al presentar (solo si la causa la sigue teniendo igual). `estado`: borrador (lo armó el chat) → pendiente (la persona lo confirmó en la app) → presentando (una corrida de la tarea lo tomó) → presentado | error; o cancelado. `resultado`: qué pasó al presentarlo. `adjuntos`: los oficios que van con el escrito (acciones cautelares).';

-- El oficio en una forma que se copia sin errores (la tarea del SAC lo lee con el conector y lo
-- escribe en un archivo): solo ASCII, sin comillas ni barras, que ninguna capa de JSON cambia.
--   ~n salto de línea · ~sNN NN espacios seguidos (02 a 99; ~s01, uno solo al principio o al final)
--   ~XXXX la letra U+XXXX (lo de más allá de U+FFFF, como par sustituto)
-- Quedan tal cual las letras sin acento, los números, el espacio suelto y . , ; : ( ) / - _ ? ! + * = % # @ $ [ ] { } | ' ^
-- Es el espejo de dev/texto-seguro.mjs: las pruebas comparan los dos.
create function gestor.texto_seguro(p text) returns text
language plpgsql immutable set search_path = ''
as $$
declare r text := ''; i integer := 1; n integer := length(p); ch text; u integer; k integer;
begin
  while i <= n loop
    ch := substr(p, i, 1);
    if ch = ' ' and substr(p, i + 1, 1) = ' ' then
      k := 1;
      while i + k <= n and substr(p, i + k, 1) = ' ' and k < 99 loop k := k + 1; end loop;
      r := r || '~s' || lpad(k::text, 2, '0');
      i := i + k;
      continue;
    end if;
    if ch = ' ' and (i = 1 or i = n) then r := r || '~s01';
    elsif ch = E'\n' then r := r || '~n';
    elsif ch ~ '^[]A-Za-z0-9 .,;:()/_?!+*=%#@$|''^{}[-]$' then r := r || ch;
    else
      u := ascii(ch);
      if u < 65536 then r := r || '~' || lpad(to_hex(u), 4, '0');
      else r := r || '~' || to_hex(55296 + ((u - 65536) >> 10)) || '~' || to_hex(56320 + ((u - 65536) & 1023));
      end if;
    end if;
    i := i + 1;
  end loop;
  return r;
end $$;

-- Lo que la tarea del SAC copia de cada adjunto, en orden: un renglón "oficio <control> <partes>
-- <nombre>" y después las partes del texto, de hasta 240 letras, cada una con su número y su
-- control ("<k> <control> <parte>"). Ninguna parte empieza ni termina con un espacio.
create function gestor.agenda_adjuntos(p_id uuid)
returns table (n integer, nombre text, linea text)
language plpgsql stable set search_path = ''
as $$
declare adj record; e text; largo integer; pos integer; fin integer; partes text[]; k integer;
begin
  for adj in
    select t.orden::integer as orden, t.x as x
      from public.agenda a
      cross join lateral jsonb_array_elements(a.adjuntos) with ordinality as t(x, orden)
     where a.id = p_id
     order by t.orden
  loop
    e := gestor.texto_seguro(adj.x->>'doc');
    largo := length(e); pos := 1; partes := '{}';
    while pos <= largo loop
      fin := least(pos + 239, largo);
      while fin < largo and fin > pos and (substr(e, fin, 1) = ' ' or substr(e, fin + 1, 1) = ' ') loop fin := fin - 1; end loop;
      partes := partes || substr(e, pos, fin - pos + 1);
      pos := fin + 1;
    end loop;
    n := adj.orden; nombre := adj.x->>'nombre';
    linea := 'oficio ' || left(adj.x->>'sha256', 16) || ' ' || coalesce(array_length(partes, 1), 0) || ' ' || (adj.x->>'nombre');
    return next;
    for k in 1 .. coalesce(array_length(partes, 1), 0) loop
      linea := k || ' ' || left(encode(sha256(convert_to(partes[k], 'UTF8')), 'hex'), 8) || ' ' || partes[k];
      return next;
    end loop;
  end loop;
end $$;
comment on function gestor.agenda_adjuntos(uuid) is
  'Para la tarea que presenta en el SAC: los renglones de cada oficio adjunto a un escrito (n: el adjunto), en orden. Se copian tal cual a un archivo, uno por renglón, y dev/oficio-pdf.mjs controla cada uno y arma el PDF. Sin filas: el escrito no lleva adjuntos.';

-- ───────────────────────── Plantillas de las acciones cautelares ─────────────────────────
-- Los mismos textos que MODELOS en docs/oficio.js (las pruebas lo comparan). Si ya existen, no se tocan.

insert into public.plantillas (id, titulo, cuerpo) values
('oficio-embargo-haberes', 'Oficio de embargo de haberes', $tx${{ciudad}},     de               de {{anio}}
Sr. Titular Empresa {{empleador}}
[[CUIT {{cuit_empleador}}]]
[[{{domicilio_empleador}}]]
S _________ /____________D

>Se hace saber a Ud. que en los autos caratulados **“{{autos}} - {{tipo_oficio}} (Expte. Nº {{expediente}})”**, que tramitan por ante el Juzgado de 1era Instancia y **{{nom_ordinal}}** Nominación en lo Civil y Comercial de esta ciudad, Secretaría a cargo del autorizante Oficina de Ejecuciones Particulares, se ha resuelto librar a Ud. el presente oficio a fin de que una vez recibido y previa formalidades de ley, proceda **A TRABAR EMBARGO** sobre los haberes que percibe **{{persona}} DNI {{dni}}** hasta cubrir la suma de pesos **{{monto_letras}} ($ {{monto}})**. La medida deberá hacerse efectiva tanto sobre los haberes ordinario cuanto sobre las remuneraciones extraordinarias que perciba o a percibir por el demandado, en proporción de ley, ello es, sobre el diez por ciento (10%) sobre lo que exceda del salario mínimo vital y móvil y en tanto no supere el doble de aquél, y en un veinte por ciento (20%) en caso contrario (arts. 147 L.C.T. y Dec. 484/87).

Que los importes que por tal concepto sean retenidos deberán ser depositados a la orden de este Juzgado y para estos autos en cuenta judicial nº {{cuenta_judicial}} CBU {{cbu}} Banco de Córdoba en el plazo de 2 días; de liquidados los haberes, bajo apercibimiento de ley.

Se deja constancia que el Dr. SOLER CARLOS EMILIANO MP 3-35383, y/o quien este designe se encuentra facultado para diligenciar el presente.

Sírvase devolverlo directamente al tribunal con todo lo actuado.

>>Saluda a Ud. atentamente$tx$),
('oficio-secuestro-automotor', 'Oficio de secuestro automotor', $tx${{ciudad}},     de               de {{anio}}
Sr. Oficial de Justicia
[[{{sede_oficial}}]]
S____________/_____________D

>Se hace saber a Ud. que en los autos **{{autos}} – {{tipo_oficio}} (Expte. Nº {{expediente}}”**, que tramitan por ante el Juzgado de 1º Instancia y **{{nom}}**° Nominación en lo Civil y Comercial de esta ciudad, Secretaría a cargo del autorizante, Oficina de Ejecuciones Particulares se ha resuelto librar a Ud. el presente oficio a fin de que una vez recibido y previas formalidades de ley, se constituya en el domicilio de la demandado sito en calle {{calle}} Nro. {{numero}} de la ciudad de {{localidad}}, Provincia de Córdoba, y/o vía pública y proceda a **SECUESTRAR** el automotor marca {{marca}} dominio {{dominio}} modelo {{modelo}}[[, año {{anio_vehiculo}}]], motor {{motor}}, chasis {{chasis}} de propiedad del demandado **{{persona}} DNI {{dni}}**[[ pudiendo el ejecutado enervar el secuestro abonando la suma de Pesos **{{monto_letras}} (${{monto}}) con más intereses y costas**]]**.**

>El martillero Sr. FRANCO DANIELE y/o quien se designe, se encuentra autorizado a correr con el diligenciamiento del presente. Efectuada la medida, deberá poner en posesión del bien secuestrado del Martillero quien deberá aceptar el cargo de depositario judicial en este acto.

>Se lo autoriza a allanar domicilio y hacer uso de la fuerza pública en caso de ser necesario, y se lo faculta de lunes a sábado de 8.00 hs. a 22.00hs. (art. 44 C.P.C.C.). Se abstendrá de realizar la medida para el caso de encontrarse el bien en cuestión retenido por autoridad pública en dependencia oficial.

>Diligenciado que sea el presente, sírvase devolverlo a este Juzgado con todo lo actuado.

>>SALUDO A UD. ATTE.-$tx$),
('solicita-embargo-haberes', 'Solicita embargo de haberes', $tx$Que vengo a solicitar se trabe embargo sobre los haberes que percibe el demandado {{persona}} DNI {{dni}} como dependiente de {{empleador}}, hasta cubrir la suma de pesos {{monto_letras}} ($ {{monto}}), en la proporción de ley.

Que a tales fines acompaño oficio dirigido al empleador y solicito se libre el mismo.

Por todo ello,
- Ordene el embargo de haberes solicitado.
- Libre oficio de embargo.

ES DE LEY$tx$),
('solicita-secuestro-automotor', 'Solicita secuestro de vehículo automotor', $tx$Que vengo a solicitar se ordene el secuestro del automotor marca {{marca}} modelo {{modelo}} dominio {{dominio}}, de propiedad del demandado {{persona}} DNI {{dni}}.

Que acompaño oficio de secuestro automotor y solicito se libre el mismo.

Por todo ello,
- Ordene el secuestro del automotor.
- Libre oficio de secuestro.

ES DE LEY$tx$)
on conflict (id) do nothing;

comment on table public.plantillas is
  'Plantillas de escritos. En título y cuerpo se pueden usar {{caratula}}, {{expediente}}, {{actor}}, {{demandado}}, {{tipo}}, {{nominacion}} y {{oficina}}. Las de id "oficio-…" son modelos de oficio de las acciones cautelares (marcas en docs/oficio.js); "solicita-embargo-haberes" y "solicita-secuestro-automotor" son los escritos que las acompañan, con los campos del formulario ({{persona}}, {{dni}}, {{empleador}}, {{monto}}…).';

-- ───────────────────────── Estadísticas ─────────────────────────

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
       and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda', 'deudores', 'modelos_mensaje',
                         'ajustes_cobranzas', 'consultas_bcra', 'consultas_cheques', 'vehiculos', 'ubicaciones', 'ajustes_prenda')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de las tablas de la app. Volver a llamarla en cada migración que agregue columnas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Deshacer, con los adjuntos ─────────────────────────
-- Igual que en 0012; en la agenda también restaura `adjuntos` (una foto anterior a 0013 no los tiene: quedan vacíos).

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
    insert into public.agenda (id, expte, titulo, cuerpo, fecha, realizar, estado, resultado, presentado, creado, ahora, adjuntos)
    select r.id, r.expte, r.titulo, r.cuerpo, r.fecha, r.realizar, r.estado, r.resultado, r.presentado, r.creado, r.ahora,
           coalesce(r.adjuntos, '[]'::jsonb)
      from jsonb_populate_record(null::public.agenda, c.antes) r
    on conflict (id) do update set
      expte = excluded.expte, titulo = excluded.titulo, cuerpo = excluded.cuerpo, fecha = excluded.fecha, realizar = excluded.realizar,
      estado = excluded.estado, resultado = excluded.resultado, presentado = excluded.presentado, creado = excluded.creado,
      ahora = excluded.ahora, adjuntos = excluded.adjuntos;
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
  elsif c.tabla = 'consultas_bcra' then
    insert into public.consultas_bcra (id, cuit, denominacion, momento, consultado_por, periodo, semaforo, peor_situacion, entidades,
                                       deuda_total, cheques, cheques_impagos, motivos, resultado)
    select r.id, r.cuit, r.denominacion, r.momento, r.consultado_por, r.periodo, r.semaforo, r.peor_situacion, r.entidades,
           r.deuda_total, r.cheques, r.cheques_impagos, r.motivos, r.resultado
      from jsonb_populate_record(null::public.consultas_bcra, c.antes) r
    on conflict (id) do update set
      cuit = excluded.cuit, denominacion = excluded.denominacion, momento = excluded.momento, consultado_por = excluded.consultado_por,
      periodo = excluded.periodo, semaforo = excluded.semaforo, peor_situacion = excluded.peor_situacion, entidades = excluded.entidades,
      deuda_total = excluded.deuda_total, cheques = excluded.cheques, cheques_impagos = excluded.cheques_impagos,
      motivos = excluded.motivos, resultado = excluded.resultado;
  elsif c.tabla = 'consultas_cheques' then
    insert into public.consultas_cheques (id, entidad, entidad_nombre, numero, denunciado, fecha_bcra, momento, consultado_por, resultado)
    select r.id, r.entidad, r.entidad_nombre, r.numero, r.denunciado, r.fecha_bcra, r.momento, r.consultado_por, r.resultado
      from jsonb_populate_record(null::public.consultas_cheques, c.antes) r
    on conflict (id) do update set
      entidad = excluded.entidad, entidad_nombre = excluded.entidad_nombre, numero = excluded.numero, denunciado = excluded.denunciado,
      fecha_bcra = excluded.fecha_bcra, momento = excluded.momento, consultado_por = excluded.consultado_por, resultado = excluded.resultado;
  elsif c.tabla = 'vehiculos' then
    insert into public.vehiculos (id, dominio, marca, modelo, anio, deudor, dni, telefono, operacion, expte, situacion,
                                  consentimiento, imei, equipo, instalado, traccar_id, sim, zona_km, notas)
    select r.id, r.dominio, r.marca, r.modelo, r.anio, r.deudor, r.dni, r.telefono, r.operacion, r.expte, r.situacion,
           r.consentimiento, r.imei, r.equipo, r.instalado, r.traccar_id, r.sim, r.zona_km, r.notas
      from jsonb_populate_record(null::public.vehiculos, c.antes) r
    on conflict (id) do update set
      dominio = excluded.dominio, marca = excluded.marca, modelo = excluded.modelo, anio = excluded.anio, deudor = excluded.deudor,
      dni = excluded.dni, telefono = excluded.telefono, operacion = excluded.operacion, expte = excluded.expte, situacion = excluded.situacion,
      consentimiento = excluded.consentimiento, imei = excluded.imei, equipo = excluded.equipo, instalado = excluded.instalado,
      traccar_id = excluded.traccar_id, sim = excluded.sim, zona_km = excluded.zona_km, notas = excluded.notas;
  elsif c.tabla = 'ajustes_prenda' then
    update public.ajustes_prenda a set
      politica = r.politica, zona_km = r.zona_km, base_lat = r.base_lat, base_lon = r.base_lon
      from jsonb_populate_record(null::public.ajustes_prenda, c.antes) r
     where a.id = 1;
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Las funciones nuevas nacen ejecutables por PUBLIC: se les quita, como en 0001.
revoke all on all functions in schema gestor from public, anon, authenticated;
