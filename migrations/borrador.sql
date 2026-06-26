-- Borrador / Oficial por línea (F2).
-- estado = 'oficial' (lo ven todos) | 'borrador' (copia privada de quien tiene el lock).
-- Al entrar a una línea, el programador forkea el oficial a un borrador propio; sus cambios
-- van al borrador (autoguardado) y el resto sigue viendo el oficial. "Plasmar Programa"
-- promueve el borrador a oficial. Mientras la columna NO exista, la app funciona como antes.
alter table public.produccion_programada
  add column if not exists estado text not null default 'oficial';

create index if not exists idx_pp_estado_linea
  on public.produccion_programada(estado, linea);
