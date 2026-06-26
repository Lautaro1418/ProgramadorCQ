-- F2 (follow-up): Realtime del programa oficial.
-- Con esto, cuando un programador hace "Plasmar Programa", el resto ve el cambio al
-- instante (sin recargar). La app ignora los cambios de borrador y los de las líneas
-- que uno mismo tiene tomadas, así no interrumpe la edición propia.
-- Seguro de correr aunque la tabla ya esté en la publicación (ignora el duplicado).
do $$
begin
  alter publication supabase_realtime add table public.produccion_programada;
exception when duplicate_object then null;
end $$;

-- Opcional: permite filtrar mejor los DELETE de borradores en el cliente (no imprescindible).
-- alter table public.produccion_programada replica identity full;
