// ─────────────────────────────────────────────────────────────────────────────
// Cálculo de duración de una WO en el Gantt.
//
//   minutos_producción = (cajas × botellas_por_caja) / botellas_hora × 60
//   minutos_totales    = minutos_producción + setup respecto a la WO anterior
//
// La velocidad (botellas/hora) sale de `velocidades_botella`, igual que el
// secuenciador/optimizador: se busca por (codigo de botella IFR | tipo | línea).
//   - codigo de botella IFR: viene de `producciones_insumos` (familia='BOTELLA'),
//     keyeado por WO (orden).
//   - tipo: ISEA → vestido (vino de estiba) · ISVT/otros → directo (vino directo).
//
// El setup entre WOs arranca con un valor fijo configurable (DEFAULT_SETUP_MIN).
// La matriz completa de setup (color/formato/velcorin/azúcar/caja) se puede
// enchufar después reusando las tablas setup_* de ProgramacionCQ.
// ─────────────────────────────────────────────────────────────────────────────

export interface VelocidadRow {
  codigo: string
  tipo: 'directo' | 'vestido'
  linea: string
  botellas_hora: number
}

export interface InsumoBotellaRow {
  orden: string
  insumo: string       // código IFR de la botella
  familia: string      // 'BOTELLA'
}

export interface DuracionMaps {
  // "codigo|tipo|linea" → botellas/hora
  velocidad: Map<string, number>
  // orden (WO) → código IFR de botella
  botella: Map<string, string>
  // orden (WO) → insumo activo (para inferir ISEA/ISVT)
  insumoActivo: Map<string, string>
}

// Velocidad nominal de respaldo (botellas/hora) cuando no hay dato en la tabla.
export const DEFAULT_BOTELLAS_HORA = 9000
// Botellas por caja por defecto (la mayoría de los SKUs son 6 ó 12).
export const DEFAULT_BOTELLAS_POR_CAJA = 6
// Setup fijo por cambio de WO (minutos) hasta enchufar la matriz completa.
export const DEFAULT_SETUP_MIN = 30

export function buildDuracionMaps(
  velocidades: VelocidadRow[],
  insumos: InsumoBotellaRow[],
  insumoActivoPorWo: Record<string, string> = {}
): DuracionMaps {
  return {
    velocidad: new Map(velocidades.map(r => [`${r.codigo}|${r.tipo}|${r.linea}`, r.botellas_hora])),
    botella: new Map(
      insumos.filter(r => r.familia === 'BOTELLA').map(r => [r.orden, r.insumo])
    ),
    insumoActivo: new Map(Object.entries(insumoActivoPorWo)),
  }
}

/** botellas/hora para una WO en una línea, o 0 si no hay dato. */
export function botellasHora(wo: string, linea: string, t: DuracionMaps): number {
  const botellaCodigo = t.botella.get(wo)
  if (!botellaCodigo) return 0
  const insumo = t.insumoActivo.get(wo) ?? ''
  const tipo: 'vestido' | 'directo' = insumo.startsWith('ISEA') ? 'vestido' : 'directo'
  return t.velocidad.get(`${botellaCodigo}|${tipo}|${linea}`) ?? 0
}

/**
 * Minutos de producción pura de una WO en una línea.
 * @param cajas cantidad de cajas de la WO
 * @param botellasPorCaja unidades por caja (6/12); default DEFAULT_BOTELLAS_POR_CAJA
 */
export function minutosProduccion(
  cajas: number,
  linea: string,
  wo: string,
  t: DuracionMaps,
  botellasPorCaja = DEFAULT_BOTELLAS_POR_CAJA
): number {
  const cj = Math.max(0, cajas || 0)
  const bph = botellasHora(wo, linea, t) || DEFAULT_BOTELLAS_HORA
  const botellas = cj * (botellasPorCaja || DEFAULT_BOTELLAS_POR_CAJA)
  if (bph <= 0) return 0
  return Math.round((botellas / bph) * 60)
}

/**
 * Setup en minutos entre la WO anterior y la actual en una línea.
 * v1: valor fijo (0 si es la primera de la línea). Refinable con la matriz setup_*.
 */
export function minutosSetup(
  woAnterior: string | null,
  _woActual: string,
  _linea: string,
  setupFijo = DEFAULT_SETUP_MIN
): number {
  if (!woAnterior) return 0
  return setupFijo
}
