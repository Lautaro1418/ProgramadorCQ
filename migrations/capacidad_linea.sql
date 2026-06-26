-- Capacidad / turnos por línea y semana (F4).
-- Una fila por (línea, semana). `semana` = lunes ISO de la semana (date).
-- turno:  L1/L0 → '3T' (lun 06:00 → sáb 13:00, 127 h) | '4T' (lun→dom 24h, 168 h)
--         L2/TM → 'mañana' (Lun-Vie 06-14 + Sáb 06-13, 47 h) | 'tarde' (Lun-Vie 14-22, 40 h)
-- paradas_op / paradas_ext: porcentajes (0..100) que recortan la capacidad.
-- capacidad efectiva = horas_turno × (1 − (paradas_op + paradas_ext)/100).
create table if not exists public.capacidad_linea (
  linea       text not null,
  semana      date not null,
  turno       text,
  paradas_op  numeric not null default 0,
  paradas_ext numeric not null default 0,
  primary key (linea, semana)
);

alter table public.capacidad_linea enable row level security;

drop policy if exists capacidad_linea_all on public.capacidad_linea;
create policy capacidad_linea_all on public.capacidad_linea
  for all to authenticated using (true) with check (true);
