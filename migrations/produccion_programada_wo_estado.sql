-- F2 fix: la unique en `wo` (heredada de ProgramadorProduccion) impide que la misma WO
-- exista a la vez como 'oficial' y como 'borrador'. Eso rompe el fork del borrador y tira
-- "duplicate key ... produccion_programada_wo_unique" al programar.
-- Se reemplaza por unique (wo, estado): una WO puede estar 1 vez por estado, no duplicada.
alter table public.produccion_programada drop constraint if exists produccion_programada_wo_unique;
drop index if exists produccion_programada_wo_unique;

create unique index if not exists produccion_programada_wo_estado_uniq
  on public.produccion_programada (wo, estado);
