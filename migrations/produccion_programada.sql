-- Programación de producción: cada fila es una WO asignada a una línea, fecha y hora.
-- Vive en la MISMA base de datos que ProgramacionCQ (lee ope_ordenes / velocidades_botella).
create table if not exists produccion_programada (
  id            bigint generated always as identity primary key,
  wo            text not null,
  linea         text not null,                 -- L1 / L2 / L0 / TM
  fecha         date not null,                 -- día de inicio (clave de columna en el Gantt)
  hora_inicio   timestamptz not null,          -- inicio exacto
  hora_fin      timestamptz not null,          -- fin (puede cruzar la medianoche)
  duracion_min  integer not null default 0,    -- minutos de producción pura (cajas / velocidad)
  setup_min     integer not null default 0,    -- minutos de setup respecto a la WO anterior
  orden_en_dia  integer not null default 0,    -- orden de la WO dentro de la línea/día

  -- Snapshot de datos de la WO para renderizar el bloque sin join a ope_ordenes
  descripcion   text,
  cajas         numeric,
  fraccionado   text,                          -- SI / NO

  usuario_email  text,
  usuario_nombre text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Una WO se programa una sola vez (si se mueve de línea/día es un UPDATE)
  constraint produccion_programada_wo_unique unique (wo)
);

create index if not exists produccion_programada_linea_fecha_idx
  on produccion_programada (linea, fecha);

alter table produccion_programada enable row level security;

-- Cualquier usuario autenticado puede leer y escribir
create policy "auth select" on produccion_programada
  for select to authenticated using (true);
create policy "auth insert" on produccion_programada
  for insert to authenticated with check (true);
create policy "auth update" on produccion_programada
  for update to authenticated using (true) with check (true);
create policy "auth delete" on produccion_programada
  for delete to authenticated using (true);
