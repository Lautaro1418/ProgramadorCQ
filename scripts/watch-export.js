// Watcher del export de LM.
//
// Corre en una máquina de planta que vea Z:\FraccionamientoCQ (idealmente la misma
// donde ya vive sync-supabase.ps1). Escucha pedidos que la app deja en `export_log`
// y ejecuta el export contra PROG-LM.xlsm. La app corre en Vercel y no puede llegar
// a la red interna, por eso el trabajo pesado pasa acá.
//
//   node scripts/watch-export.js                    -> escucha con el archivo por defecto
//   node scripts/watch-export.js --archivo "<ruta>" -> escucha escribiendo en otro archivo
//   node scripts/watch-export.js --una-vez          -> procesa lo pendiente y termina
//
// Necesita SUPABASE_SERVICE_ROLE_KEY en .env.local. Dejalo corriendo (o como tarea
// programada). Si se cae, los pedidos quedan en 'pendiente' y se toman al reiniciar.
const fs = require('fs');
const path = require('path');
const { exportar, resumen, ARCHIVO_DEFAULT } = require('./export-lm.js');

const POLL_MS = 10000;
const RAIZ = path.join(__dirname, '..');

function supabase() {
  const env = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8');
  const val = k => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
  const key = val('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('falta SUPABASE_SERVICE_ROLE_KEY en .env.local');
  const { createClient } = require('@supabase/supabase-js');
  return createClient(val('NEXT_PUBLIC_SUPABASE_URL'), key);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Toma el pedido pendiente más viejo y lo ejecuta. Devuelve true si procesó algo. */
async function procesarUno(sb, archivo) {
  const { data: pend, error } = await sb.from('export_log')
    .select('id,usuario_email,linea').eq('status', 'pendiente').order('id').limit(1);
  if (error) throw new Error('leyendo export_log: ' + error.message);
  const pedido = pend?.[0];
  if (!pedido) return false;

  log(`#${pedido.id} tomado (${pedido.usuario_email ?? 'sin usuario'})`);
  await sb.from('export_log').update({ status: 'en_proceso' }).eq('id', pedido.id);

  try {
    const r = await exportar({ archivo, aplicar: true });
    const detalle = r.total
      ? `${resumen(r)}. Backup: ${path.basename(r.backup)}. Abrí PROG-LM en Excel para que recalcule.`
      : 'No hay órdenes de LM en el programa oficial: no se escribió nada.';
    await sb.from('export_log').update({
      status: 'completado', completed_at: new Date().toISOString(), detalle, archivo,
    }).eq('id', pedido.id);
    log(`#${pedido.id} completado — ${detalle}`);
  } catch (e) {
    await sb.from('export_log').update({
      status: 'error', completed_at: new Date().toISOString(), detalle: String(e.message).slice(0, 500), archivo,
    }).eq('id', pedido.id);
    log(`#${pedido.id} ERROR — ${e.message}`);
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const archivo = args.includes('--archivo') ? args[args.indexOf('--archivo') + 1] : ARCHIVO_DEFAULT;
  const unaVez = args.includes('--una-vez');
  const sb = supabase();

  log('Watcher de export LM iniciado');
  log('Archivo destino: ' + archivo);
  if (!fs.existsSync(archivo)) log('OJO: por ahora no veo el archivo (¿Z: desconectada?). Igual sigo escuchando.');

  if (unaVez) { while (await procesarUno(sb, archivo)); log('Nada más pendiente.'); return; }

  log(`Escuchando pedidos cada ${POLL_MS / 1000}s. Ctrl+C para salir.`);
  for (;;) {
    try { while (await procesarUno(sb, archivo)); }
    catch (e) { log('fallo del ciclo (reintento): ' + e.message); }   // no matar el watcher por un error puntual
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
