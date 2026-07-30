-- Pedidos de exportación de LM a PROG-LM.xlsm.
--
-- Mismo patrón que `refresh_log`: la app (en Vercel) inserta un pedido con
-- status='pendiente' y un watcher que corre en una máquina de planta —la que ve
-- Z:\FraccionamientoCQ— lo levanta por polling, ejecuta el export y actualiza el
-- estado. Vercel no puede llegar a la red interna, por eso el trabajo es local.
create table if not exists public.export_log (
  id            bigint generated always as identity primary key,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  status        text not null default 'pendiente',  -- pendiente | en_proceso | completado | error
  linea         text not null default 'LM',
  usuario_email text,
  usuario_nombre text,
  detalle       text,                               -- resumen de lo hecho, o el error
  archivo       text                                -- ruta escrita (queda como traza)
);

create index if not exists idx_export_log_status on public.export_log (status, id);

alter table public.export_log enable row level security;

-- Los usuarios autenticados pueden pedir un export y ver el resultado.
-- El watcher usa la service_role, que no pasa por RLS.
drop policy if exists "auth select" on public.export_log;
create policy "auth select" on public.export_log
  for select to authenticated using (true);

drop policy if exists "auth insert" on public.export_log;
create policy "auth insert" on public.export_log
  for insert to authenticated with check (true);
