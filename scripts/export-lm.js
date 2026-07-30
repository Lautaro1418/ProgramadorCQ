// Exporta el programa de la línea móvil (LM) desde la app a PROG-LM.xlsm.
//
// La app es la única fuente de LM: cada semana exportada se REESCRIBE completa
// (si borrás una orden en la app, desaparece del Excel). Solo se escriben las 3
// celdas que antes se tipeaban a mano — E (WO), M (CAJAS), Q (FRACC) — y PROG-LM
// sigue calculando el resto. proglinea LM.xlsx no se toca: lee de PROG-LM.
//
//   node scripts/export-lm.js                    -> PREVISUALIZA (no escribe nada)
//   node scripts/export-lm.js --escribir         -> escribe, con backup previo
//   node scripts/export-lm.js --archivo "<ruta>" -> usar otro archivo (ej. una copia)
//   node scripts/export-lm.js --demo             -> self-check del mapeo
//
// Necesita SUPABASE_SERVICE_ROLE_KEY en .env.local (la anon no puede leer el programa).
const fs = require('fs');
const path = require('path');
const { escribir, semanasDelArchivo } = require('./write-lm.js');

const ARCHIVO_DEFAULT = 'Z:/FraccionamientoCQ/programación/PROG-LM.xlsm';
const RAIZ = path.join(__dirname, '..');
const DIAS = ['L', 'M', 'X', 'J', 'V', 'S'];   // 0=lunes … 5=sábado (la hoja no tiene domingo)

/** Lunes ISO de 'YYYY-MM-DD' (en UTC, para no correrse de día por zona horaria). */
function lunesDe(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
/** Letra de día de la hoja. null = domingo. */
function diaDe(iso) {
  return DIAS[(new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7] ?? null;
}

/** Agrupa las órdenes por hoja Semana1..5 y les asigna día + secuencia. */
function mapear(programa, semanas) {
  const lunesASemana = new Map(Object.entries(semanas).map(([s, l]) => [l, Number(s)]));
  const porSemana = {}, descartadas = [];
  const ord = [...programa].sort((a, b) =>
    a.fecha.localeCompare(b.fecha) || (a.orden_en_dia ?? 0) - (b.orden_en_dia ?? 0));
  const seq = {};
  for (const p of ord) {
    const sem = lunesASemana.get(lunesDe(p.fecha));
    const dia = diaDe(p.fecha);
    if (!sem) { descartadas.push({ ...p, motivo: 'fecha fuera de las 5 semanas del archivo' }); continue; }
    if (!dia) { descartadas.push({ ...p, motivo: 'domingo: la hoja no tiene ese bloque' }); continue; }
    const k = `${sem}|${dia}`;
    seq[k] = (seq[k] ?? 0) + 1;
    if (seq[k] > 51) { descartadas.push({ ...p, motivo: 'más de 51 órdenes en el día' }); continue; }
    (porSemana[sem] ??= []).push({
      dia, sec: seq[k], wo: Number(p.wo),
      cajas: p.cajas_ajustado ?? p.cajas ?? 0,
      // LM es todo estiba -> siempre fraccionado. No se usa p.fraccionado: la app lo
      // deriva de ope_ordenes.linea_fracc, que viene siempre NULL (daría 'NO' y el OEE
      // de PROG-LM, que suma solo los "SI", quedaría en 0).
      fracc: 'SI',
    });
  }
  return { porSemana, descartadas };
}

/** Lee el programa OFICIAL de LM desde Supabase. */
async function leerPrograma() {
  const envPath = path.join(RAIZ, '.env.local');
  if (!fs.existsSync(envPath)) throw new Error('falta .env.local en ' + RAIZ);
  const env = fs.readFileSync(envPath, 'utf8');
  const val = k => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
  const key = val('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('falta SUPABASE_SERVICE_ROLE_KEY en .env.local (la anon no puede leer el programa)');

  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(val('NEXT_PUBLIC_SUPABASE_URL'), key);
  const { data, error } = await sb.from('produccion_programada')
    .select('wo,linea,fecha,cajas,cajas_ajustado,fraccionado,orden_en_dia,estado')
    .eq('linea', 'LM').eq('estado', 'oficial').order('fecha').order('orden_en_dia');
  if (error) throw new Error('Supabase: ' + error.message);
  return data ?? [];
}

/** Copia de seguridad con fecha, al lado del archivo. */
function backup(archivo) {
  const t = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const dest = `${archivo}.bak-${t}`;
  fs.copyFileSync(archivo, dest);
  return dest;
}

/**
 * Exporta el programa de LM. Con aplicar=false solo calcula (previsualización).
 * Devuelve un resumen usable por la consola o por el watcher.
 */
async function exportar({ archivo = ARCHIVO_DEFAULT, aplicar = false } = {}) {
  if (!fs.existsSync(archivo)) throw new Error('no existe el archivo: ' + archivo);
  const semanas = semanasDelArchivo(archivo);
  const programa = await leerPrograma();
  const { porSemana, descartadas } = mapear(programa, semanas);
  const total = Object.values(porSemana).reduce((n, o) => n + o.length, 0);

  let copia = null;
  if (aplicar && total) {
    copia = backup(archivo);
    for (const [sem, ordenes] of Object.entries(porSemana)) escribir(archivo, Number(sem), ordenes);
  }
  return { archivo, semanas, porSemana, descartadas, total, backup: copia, aplicado: !!copia };
}

/** Resumen de una línea, para el detalle que ve el usuario en la app. */
function resumen(r) {
  const partes = Object.entries(r.porSemana).map(([s, o]) => `S${s}: ${o.length}`);
  return `${r.total} órdenes (${partes.join(', ') || 'ninguna'})`
    + (r.descartadas.length ? ` · ${r.descartadas.length} sin exportar` : '');
}

async function main() {
  const args = process.argv.slice(2);
  const archivo = args.includes('--archivo') ? args[args.indexOf('--archivo') + 1] : ARCHIVO_DEFAULT;
  const aplicar = args.includes('--escribir');

  const r = await exportar({ archivo, aplicar });
  console.log('Archivo : ' + r.archivo);
  console.log('Semanas : ' + Object.entries(r.semanas).map(([s, l]) => `S${s}=${l}`).join('  '));
  console.log('Programa: ' + r.total + ' órdenes de LM (oficial) en la app\n');
  if (!r.total) { console.log('No hay nada programado en LM: no se escribe nada.'); return; }

  for (const [sem, ordenes] of Object.entries(r.porSemana)) {
    console.log(`Semana${sem} (${r.semanas[sem]}): ${ordenes.length} órdenes`);
    for (const o of ordenes) console.log(`   ${o.dia}${String(o.sec).padStart(2)}  WO ${o.wo}  ${o.cajas} cj`);
  }
  if (r.descartadas.length) {
    console.log('\nNO se exportan (' + r.descartadas.length + '):');
    for (const d of r.descartadas) console.log(`   WO ${d.wo}  ${d.fecha}  -> ${d.motivo}`);
  }
  if (!r.aplicado) {
    console.log('\n--- PREVISUALIZACIÓN: no se escribió nada. Agregá --escribir para aplicarlo. ---');
    return;
  }
  console.log('\nBackup: ' + path.basename(r.backup));
  console.log('Escrito. Abrí el archivo en Excel para que recalcule.');
}

// ── self-check del mapeo (no toca archivos ni Supabase) ──
function demo() {
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${a} != ${b}`); };
  const semanas = { 1: '2026-07-27', 2: '2026-08-03', 3: '2026-08-10', 4: '2026-08-17', 5: '2026-08-24' };
  eq(lunesDe('2026-07-29'), '2026-07-27', 'miércoles -> su lunes');
  eq(lunesDe('2026-07-27'), '2026-07-27', 'lunes -> sí mismo');
  eq(diaDe('2026-08-01'), 'S', 'sábado');
  eq(diaDe('2026-08-02'), null, 'domingo no tiene bloque');

  const { porSemana, descartadas } = mapear([
    { wo: '111', fecha: '2026-07-27', cajas: 100, cajas_ajustado: null, fraccionado: 'NO', orden_en_dia: 1 },
    { wo: '222', fecha: '2026-07-27', cajas: 200, cajas_ajustado: 150, fraccionado: 'NO', orden_en_dia: 2 },
    { wo: '333', fecha: '2026-08-05', cajas: 300, cajas_ajustado: null, fraccionado: 'NO', orden_en_dia: 1 },
    { wo: '444', fecha: '2026-08-02', cajas: 10, cajas_ajustado: null, fraccionado: 'NO', orden_en_dia: 1 },
    { wo: '555', fecha: '2027-01-04', cajas: 10, cajas_ajustado: null, fraccionado: 'NO', orden_en_dia: 1 },
  ], semanas);

  eq(porSemana[1].length, 2, 'semana 1 tiene 2 órdenes');
  eq(porSemana[1][1].sec, 2, 'segunda del lunes');
  eq(porSemana[1][1].cajas, 150, 'usa las cajas ajustadas, no las de sistema');
  eq(porSemana[1][0].fracc, 'SI', 'FRACC siempre SI en LM');
  eq(porSemana[2][0].dia, 'X', '2026-08-05 es miércoles');
  eq(porSemana[2][0].sec, 1, 'la secuencia reinicia por día');
  eq(descartadas.length, 2, 'domingo y fecha fuera de rango quedan afuera');
  console.log('self-check OK');
}

if (require.main === module) {
  if (process.argv.includes('--demo')) demo();
  else main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
module.exports = { exportar, resumen, mapear, lunesDe, diaDe, ARCHIVO_DEFAULT };
