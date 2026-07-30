'use client'
// Muestra el "Programable" que genera ProgramacionCQ (/programador), leído tal cual
// de `programador_programable_guardado`. NO se recalcula acá: se lee el JSON que esa
// app guardó, así el agrupamiento, el orden y la línea sugerida son siempre idénticos
// a los que ve el programador allá.

export interface ProgItem {
  wo: string
  cod?: string; desc?: string
  linea?: string
  litros?: number; cajas?: number
  minimo?: string; motivo?: string; botella?: string
  prioridad?: string; comentario?: string
  insumo?: string; insumoDesc?: string
}
export interface ProgCarga { linea: string; litros: number; capacidad: number }
export interface ProgramableData {
  directo: ProgItem[]; tm: ProgItem[]; estibas: ProgItem[]; sinClasif: ProgItem[]
  carga: ProgCarga[]; totalCajas: number; totalLitros: number
}

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('es-AR', { maximumFractionDigits: 0 })

/** Color del badge de línea: destaca la de la pestaña actual. */
function lineaCls(l: string | undefined, actual: string) {
  if (!l) return 'bg-stone-100 text-stone-500'
  return l === actual ? 'bg-red-900 text-onbrand' : 'bg-stone-200 text-stone-600'
}

export default function ProgramablePanel({
  datos, linea, guardadoEl, puedeEditar, programables, dragWo, dragGrupo,
  onDragStart, onDragGrupoStart, onDragEnd,
}: {
  datos: ProgramableData | null
  linea: string
  guardadoEl: string | null
  puedeEditar: boolean
  programables: Set<string>          // WOs que están en el backlog => se pueden arrastrar
  dragWo: string | null
  dragGrupo: string[] | null
  onDragStart: (wo: string) => void
  onDragGrupoStart: (wos: string[]) => void
  onDragEnd: () => void
}) {
  if (!datos) {
    return (
      <p className="text-xs text-stone-400">
        No hay un programable guardado (o no tenés permiso para verlo). Generalo en
        ProgramacionCQ → Programador → Programable y volvé a Actualizar.
      </p>
    )
  }

  // El array ya viene agrupado y ordenado: se corta un grupo nuevo cuando cambia el código,
  // sin reordenar nada, para respetar exactamente lo que generó ProgramacionCQ.
  const grupos: { cod: string; desc: string; items: ProgItem[] }[] = []
  for (const it of datos.directo) {
    const ult = grupos[grupos.length - 1]
    if (!ult || ult.cod !== (it.cod ?? '')) grupos.push({ cod: it.cod ?? '', desc: it.desc ?? '', items: [it] })
    else ult.items.push(it)
  }

  return (
    <div className="space-y-2">
      {guardadoEl && (
        <p className="text-[10px] text-stone-400">
          Generado en ProgramacionCQ el {guardadoEl.slice(8, 10)}/{guardadoEl.slice(5, 7)} {guardadoEl.slice(11, 16)}
        </p>
      )}

      {/* Carga por línea */}
      <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-stone-400 mb-1">Carga por línea</div>
        {datos.carga.filter(c => c.capacidad > 0 || c.litros > 0).map(c => {
          const pct = c.capacidad > 0 ? (c.litros / c.capacidad) * 100 : 0
          return (
            <div key={c.linea} className="flex items-center gap-1.5 text-[11px] mb-0.5">
              <span className={`w-7 text-center rounded font-semibold ${lineaCls(c.linea, linea)}`}>{c.linea}</span>
              <div className="flex-1 h-1.5 rounded-full bg-stone-200 overflow-hidden">
                <div className={`h-full ${pct > 100 ? 'bg-red-600' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <span className="tabular-nums text-stone-500">
                {fmt(c.litros)}{c.capacidad > 0 && ` / ${fmt(c.capacidad)}`}
              </span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-stone-400">
        <span>{datos.directo.length} órdenes de fraccionado</span>
        <span>· {datos.tm.length} TM</span>
        <span>· {datos.estibas.length} estibas</span>
        {datos.sinClasif.length > 0 && <span>· {datos.sinClasif.length} sin clasificar</span>}
      </div>

      {grupos.map((g, gi) => {
        const wosDelGrupo = g.items.map(x => x.wo).filter(w => programables.has(w))
        const grupoArrastrable = puedeEditar && wosDelGrupo.length > 0
        const litrosGrupo = g.items.reduce((s, x) => s + (x.litros ?? 0), 0)
        const arrastrandoEste = !!dragGrupo && dragGrupo.length === wosDelGrupo.length
          && wosDelGrupo.every(w => dragGrupo.includes(w))
        return (
          <div key={`${g.cod}-${gi}`}>
            <div
              draggable={grupoArrastrable}
              onDragStart={() => grupoArrastrable && onDragGrupoStart(wosDelGrupo)}
              onDragEnd={onDragEnd}
              title={grupoArrastrable
                ? `Arrastrá para programar las ${wosDelGrupo.length} órdenes del grupo juntas`
                : 'Ninguna orden de este grupo está en el backlog'}
              className={`flex items-baseline gap-1.5 mt-2 mb-1 border-t pt-1.5 px-1 rounded ${
                grupoArrastrable ? 'cursor-grab active:cursor-grabbing hover:bg-stone-50' : 'cursor-default'
              } ${arrastrandoEste ? 'border-red-400 bg-red-50' : 'border-stone-200'}`}
            >
              {grupoArrastrable && <span className="text-stone-300 text-[11px]">⠿</span>}
              <span className="text-[11px] font-bold text-stone-700">{g.cod}</span>
              <span className="text-[10px] text-stone-500 truncate flex-1">{g.desc}</span>
              <span className="text-[10px] text-stone-400 tabular-nums whitespace-nowrap">
                {g.items.length} · {fmt(litrosGrupo)} L
              </span>
            </div>
            {g.items.map((item, i) => {
              const arrastrable = puedeEditar && programables.has(item.wo)
              const esDeEstaLinea = item.linea === linea
              return (
                <div key={`${item.wo}-${i}`} className="mb-1.5"><div
              draggable={arrastrable}
              onDragStart={() => arrastrable && onDragStart(item.wo)}
              onDragEnd={onDragEnd}
              title={item.motivo ?? ''}
              className={`border rounded-lg px-2 py-1.5 transition-colors ${
                arrastrable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default opacity-70'
              } ${dragWo === item.wo ? 'border-red-400 bg-red-50'
                 : esDeEstaLinea ? 'border-stone-300 bg-white' : 'border-stone-200 bg-stone-50/60'}`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="font-mono font-semibold text-stone-800 text-xs">{item.wo}</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${lineaCls(item.linea, linea)}`}>
                  {item.linea ?? '—'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-stone-500 mt-0.5 tabular-nums">
                <span>{fmt(item.litros)} L</span>
                {item.botella && <span className="font-mono text-stone-400">{item.botella}</span>}
              </div>
              {item.prioridad && (
                <div className="text-[10px] text-stone-400 truncate mt-0.5">{item.prioridad}</div>
              )}
              {item.motivo && (
                <div className="text-[10px] text-stone-400 truncate mt-0.5 italic">{item.motivo}</div>
              )}
              {!programables.has(item.wo) && (
                <div className="text-[10px] text-amber-600 mt-0.5">no está en el backlog</div>
              )}
                </div></div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
