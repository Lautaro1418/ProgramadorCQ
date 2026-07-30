// Escribe órdenes en las hojas Semana1..5 de PROG-LM.xlsm.
//
// Solo toca las 3 celdas que el programador tipeaba a mano: E (WO), M (CAJAS), Q (FRACC).
// A (día) y B (fecha) ya vienen pre-cargadas en el template y no se tocan; el resto de las
// columnas (VX, país, litros, insumos, OEE) las sigue calculando el propio PROG-LM.
//
// Requiere 7-Zip: se actualiza la entrada del zip en su lugar, sin recomprimir todo el
// archivo (preserva macros, estilos y las 100+ entradas restantes).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function buscar7z() {
  const cand = [
    process.env.SEVENZIP,
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
  ].filter(Boolean);
  for (const c of cand) if (fs.existsSync(c)) return c;
  try { execFileSync('7z', ['i'], { stdio: 'pipe' }); return '7z'; } catch { /* no está en PATH */ }
  throw new Error('No encuentro 7-Zip. Instalalo o poné la ruta del .exe en la variable SEVENZIP.');
}

// Semana1..5 -> archivo de hoja (según xl/_rels/workbook.xml.rels de PROG-LM).
const HOJA = { 1: 'sheet4.xml', 2: 'sheet5.xml', 3: 'sheet6.xml', 4: 'sheet7.xml', 5: 'sheet8.xml' };
// Primera fila de datos de cada bloque de día. Cada bloque tiene 51 filas.
const BLOQUE = { L: 11, M: 64, X: 117, J: 170, V: 223, S: 276 };
const FILAS_POR_DIA = 51;

const colIdx = s => [...s].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Setea una celda con un valor literal. Inserta la <c> si no existía. */
function setCell(xml, col, row, value, isText) {
  const ref = col + row;
  const inner = isText ? `<is><t>${esc(value)}</t></is>` : `<v>${value}</v>`;
  const tAttr = isText ? ' t="inlineStr"' : '';
  const rowRe = new RegExp(`(<row r="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const mr = xml.match(rowRe);
  if (!mr) throw new Error(`fila ${row} no encontrada`);
  let body = mr[2];

  const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const mc = body.match(cellRe);
  if (mc) {
    const attrs = mc[1].replace(/\s+t="[^"]*"/g, '');   // el tipo lo define esta función
    // El XML trae fórmulas con "$" ($F$2). Como replacer-string, "$2" significaría
    // "grupo 2" y duplicaría la fila entera -> siempre replacer como función.
    body = body.replace(cellRe, () => `<c r="${ref}"${attrs}${tAttr}>${inner}</c>`);
  } else {
    const nuevo = `<c r="${ref}"${tAttr}>${inner}</c>`;
    const target = colIdx(col);
    const cells = [...body.matchAll(/<c r="([A-Z]{1,2})\d+"/g)];
    const after = cells.find(m => colIdx(m[1]) > target);
    body = after ? body.slice(0, after.index) + nuevo + body.slice(after.index) : body + nuevo;
  }
  return xml.replace(rowRe, () => mr[1] + body + mr[3]);
}

/** Vacía una celda conservando su estilo. */
function clearCell(xml, col, row) {
  const ref = col + row;
  const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const mc = xml.match(cellRe);
  if (!mc) return xml;
  const attrs = mc[1].replace(/\s+t="[^"]*"/g, '');
  return xml.replace(cellRe, () => `<c r="${ref}"${attrs}/>`);
}

/** Borra las órdenes de los 6 bloques de día (la semana se reescribe completa). */
function limpiarSemana(xml) {
  for (const base of Object.values(BLOQUE))
    for (let i = 0; i < FILAS_POR_DIA; i++)
      for (const col of ['E', 'M', 'Q']) xml = clearCell(xml, col, base + i);
  return xml;
}

/** Fila destino según día (L M X J V S) y secuencia (1..51). */
function filaDe(dia, sec) {
  const base = BLOQUE[dia];
  if (!base) throw new Error(`día inválido: ${dia} (usar L M X J V S)`);
  if (sec < 1 || sec > FILAS_POR_DIA) throw new Error(`secuencia fuera de rango: ${sec}`);
  return base + sec - 1;
}

const serialAFecha = n => new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);

/** Lunes de cada hoja Semana1..5, leyendo su celda F2 -> { 1:'2026-07-27', ... } */
function semanasDelArchivo(xlsmPath) {
  const zip = buscar7z();
  const stage = path.join(path.dirname(xlsmPath), '_stage_r');
  fs.rmSync(stage, { recursive: true, force: true });
  execFileSync(zip, ['x', xlsmPath, `-o${stage}`, ...Object.values(HOJA).map(h => 'xl/worksheets/' + h), '-y'], { stdio: 'pipe' });
  const out = {};
  for (const [sem, hoja] of Object.entries(HOJA)) {
    const xml = fs.readFileSync(path.join(stage, 'xl/worksheets', hoja), 'utf8');
    const m = xml.match(/<c r="F2"[^>]*>(?:<f>[\s\S]*?<\/f>)?<v>([\d.]+)<\/v>/);
    if (m) out[Number(sem)] = serialAFecha(Number(m[1]));
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return out;
}

/** Reescribe una semana completa. ordenes: [{dia,sec,wo,cajas,fracc}] */
function escribir(xlsmPath, semana, ordenes) {
  const zip = buscar7z();
  const hoja = HOJA[semana];
  if (!hoja) throw new Error(`semana inválida: ${semana} (1..5)`);
  const stage = path.join(path.dirname(xlsmPath), '_stage');
  fs.rmSync(stage, { recursive: true, force: true });
  execFileSync(zip, ['x', xlsmPath, `-o${stage}`, 'xl/worksheets/' + hoja, 'xl/workbook.xml', '-y'], { stdio: 'pipe' });

  const hojaPath = path.join(stage, 'xl/worksheets', hoja);
  let xml = limpiarSemana(fs.readFileSync(hojaPath, 'utf8'));
  for (const o of ordenes) {
    const f = filaDe(o.dia, o.sec);
    xml = setCell(xml, 'E', f, o.wo, false);
    xml = setCell(xml, 'M', f, o.cajas, false);
    xml = setCell(xml, 'Q', f, o.fracc ?? 'SI', true);
  }
  fs.writeFileSync(hojaPath, xml);

  // Sin esto Excel mostraría los valores cacheados viejos en vez de recalcular.
  const wbPath = path.join(stage, 'xl/workbook.xml');
  let wb = fs.readFileSync(wbPath, 'utf8');
  if (!/fullCalcOnLoad="1"/.test(wb)) {
    fs.writeFileSync(wbPath, wb.replace(/<calcPr([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>'));
  }

  execFileSync(zip, ['u', xlsmPath, 'xl/worksheets/' + hoja, 'xl/workbook.xml'], { cwd: stage, stdio: 'pipe' });
  fs.rmSync(stage, { recursive: true, force: true });
  return ordenes.map(o => ({ ...o, fila: filaDe(o.dia, o.sec) }));
}

// ── self-check (no toca archivos) ──
function demo() {
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${a} != ${b}`); };
  eq(filaDe('L', 1), 11, 'lunes sec1');
  eq(filaDe('L', 51), 61, 'lunes sec51 (última antes del resumen 62)');
  eq(filaDe('M', 1), 64, 'martes sec1');
  eq(filaDe('S', 51), 326, 'sábado sec51');

  const x0 = '<row r="11" s="1"><c r="E11"><v>1</v></c><c r="Q11" t="s"><v>5</v></c></row>';
  const x1 = setCell(setCell(x0, 'E', 11, 999, false), 'M', 11, 42, false);
  eq((x1.match(/<c r="E11"/g) || []).length, 1, 'E11 no duplicada');
  if (!x1.includes('<c r="E11"><v>999</v></c>')) throw new Error('E11 no se actualizó');
  if (!/<c r="M11"><v>42<\/v><\/c><c r="Q11"/.test(x1)) throw new Error('M11 mal insertada (va antes de Q)');

  // el caso que corrompió el archivo la primera vez: "$" en las fórmulas de la fila
  const y0 = '<row r="11"><c r="B11"><f>+$F$2</f><v>46230</v></c><c r="Q11"><v>1</v></c></row>';
  const y1 = setCell(y0, 'E', 11, 777, false);
  eq((y1.match(/<c r="B11"/g) || []).length, 1, 'B11 duplicada por el $ de la fórmula');
  if (!y1.includes('<f>+$F$2</f>')) throw new Error('la fórmula +$F$2 se corrompió');

  const z = limpiarSemana('<row r="11"><c r="E11" s="5"><v>123</v></c><c r="M11"><v>9</v></c></row>');
  if (!z.includes('<c r="E11" s="5"/>')) throw new Error('limpiarSemana no vació E11 (o perdió el estilo)');
  console.log('self-check OK');
}

module.exports = { escribir, filaDe, setCell, clearCell, limpiarSemana, semanasDelArchivo, BLOQUE, FILAS_POR_DIA };
if (require.main === module) demo();
