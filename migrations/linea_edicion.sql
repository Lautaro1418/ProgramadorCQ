-- Lock de edición por línea (F1b): 1 fila por línea con quién la está editando.
-- El cliente refresca last_seen cada ~3 min (heartbeat); si pasan >10 min sin refresco,
-- el lock se considera libre y otro programador puede tomar la línea.
-- Para el indicador en tiempo real, activar Realtime de esta tabla en
-- Supabase → Database → Replication (igual funciona sin Realtime vía polling cada 30s).
create table if not exists public.linea_edicion (
  linea          text primary key,            -- L0 / L1 / L2 / TM (1 fila por línea)
  usuario_email  text not null,
  usuario_nombre text,
  last_seen      timestamptz not null default now()
);

alter table public.linea_edicion enable row level security;

drop policy if exists linea_edicion_all on public.linea_edicion;
create policy linea_edicion_all on public.linea_edicion
  for all to authenticated using (true) with check (true);
