'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { mondayOf, addDays, toISODate, getISOWeek, semanaDesde, fmtHora } from '@/lib/fechas'
import {
  buildDuracionMaps, minutosProduccion, minutosSetup,
  type DuracionMaps, type VelocidadRow, type InsumoBotellaRow,
} from '@/lib/duracion'

// ── Constantes ───────────────────────────────────────────────────────────────
const LINEAS = ['L1', 'L2', 'L0', 'TM'] as const
type Linea = (typeof LINEAS)[number]

const ESTADOS_BACKLOG = [40, 41, 45]   // aprobada / lote activo / en proceso

// Alto del timeline de un día (24h). 20px por hora.
const DIA_H = 480
const HORA_INICIO_DEFAULT = 6   // si el día está vacío, la primera WO arranca 06:00

// ── Tipos ────────────────────────────────────────────────────────────────────
interface WoBacklog {
  orden: string
  descripcion: string | null
  cajas: number
  linea_fracc: string | null
  fraccionado: 'SI' | 'NO'
  fe_solicitada: string | null
}

interface Programada {
  id: number
  wo: string
  linea: string
  fecha: string            // YYYY-MM-DD (día de inicio)
  hora_inicio: string      // ISO
  hora_fin: string         // ISO
  duracion_min: number
  setup_min: number
  orden_en_dia: number
  descripcion: string | null
  cajas: number | null
  fraccionado: string | null
}

// ── Página ───────────────────────────────────────────────────────────────────
export default function ProgramadorPage() {
  const { perfil } = useAuth()
  const [linea, setLinea]   = useState<Linea>('L1')
  const [monday, setMonday] = useState(() => mondayOf(new Date()))
  const [backlog, setBacklog]       = useState<WoBacklog[]>([])
  const [programadas, setProgramadas] = useState<Programada[]>([])
  const [maps, setMaps]     = useState<DuracionMaps>(() => buildDuracionMaps([], []))
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [dragWo, setDragWo]   = useState<string | null>(null)

  const dias = useMemo(() => semanaDesde(monday), [monday])

  // ── Carga de datos ─────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setLoading(true)
    const desde = toISODate(monday)
    const hasta = toISODate(addDays(monday, 14))   // semana actual + siguiente

    // Backlog: WOs de JDE aprobadas/en proceso, ventana de 2 semanas
    const woRows: WoBacklog[] = []
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from('ope_ordenes')
        .select('orden,descripcion,cajas_jde,cant_declarada,linea_fracc,fe_solicitada,estado')
        .in('estado', ESTADOS_BACKLOG)
        .gte('fe_solicitada', desde)
        .lt('fe_solicitada', hasta)
        .range(from, from + 999)
      if (!data || data.length === 0) break
      for (const r of data as Record<string, unknown>[]) {
        woRows.push({
          orden: String(r.orden),
          descripcion: (r.descripcion as string) ?? null,
          cajas: Number(r.cajas_jde ?? r.cant_declarada ?? 0),
          linea_fracc: (r.linea_fracc as string) ?? null,
          fraccionado: r.linea_fracc ? 'SI' : 'NO',
          fe_solicitada: (r.fe_solicitada as string) ?? null,
        })
      }
      if (data.length < 1000) break
    }

    // Ya programadas (todas las líneas, para excluir del backlog y pintar la grilla)
    const { data: prog } = await supabase
      .from('produccion_programada')
      .select('*')
      .order('orden_en_dia')

    // Velocidades + botella por WO (para duración)
    const [velRes, insRes] = await Promise.all([
      supabase.from('velocidades_botella').select('codigo,tipo,linea,botellas_hora'),
      supabase.from('producciones_insumos')
        .select('orden,insumo,familia,fe_solicitada')
        .gte('fe_solicitada', desde)
        .lt('fe_solicitada', hasta),
    ])

    const programadasData = (prog ?? []) as Programada[]
    const yaProg = new Set(programadasData.map(p => p.wo))

    setProgramadas(programadasData)
    setBacklog(woRows.filter(w => !yaProg.has(w.orden)))
    setMaps(buildDuracionMaps(
      (velRes.data ?? []) as VelocidadRow[],
      (insRes.data ?? []) as InsumoBotellaRow[],
    ))
    setLoading(false)
  }, [monday])

  useEffect(() => { cargar() }, [cargar])

  // ── Programar una WO (drop sobre un día) ─────────────────────────────────────
  async function programar(wo: WoBacklog, fechaIso: string) {
    // Bloques existentes de esta línea+día, para encadenar al final
    const delDia = programadas
      .filter(p => p.linea === linea && p.fecha === fechaIso)
      .sort((a, b) => a.orden_en_dia - b.orden_en_dia)

    const ultimo = delDia[delDia.length - 1] ?? null
    const inicio = ultimo
      ? new Date(ultimo.hora_fin)
      : new Date(`${fechaIso}T${String(HORA_INICIO_DEFAULT).padStart(2, '0')}:00:00`)

    const setupMin = minutosSetup(ultimo?.wo ?? null, wo.orden, linea)
    const durMin   = minutosProduccion(wo.cajas, linea, wo.orden, maps)
    const totalMin = setupMin + durMin

    const fin = new Date(inicio.getTime() + totalMin * 60000)

    const fila = {
      wo: wo.orden,
      linea,
      fecha: fechaIso,
      hora_inicio: inicio.toISOString(),
      hora_fin: fin.toISOString(),
      duracion_min: durMin,
      setup_min: setupMin,
      orden_en_dia: (ultimo?.orden_en_dia ?? 0) + 1,
      descripcion: wo.descripcion,
      cajas: wo.cajas,
      fraccionado: wo.fraccionado,
      usuario_email: perfil?.email ?? null,
      usuario_nombre: perfil?.nombre ?? null,
    }

    const { data, error } = await supabase
      .from('produccion_programada')
      .insert(fila)
      .select('*')
      .single()

    if (error) { alert('Error al programar: ' + error.message); return }
    setProgramadas(prev => [...prev, data as Programada])
    setBacklog(prev => prev.filter(w => w.orden !== wo.orden))
  }

  // ── Quitar una WO programada (vuelve al backlog) ────────────────────────────
  async function quitar(p: Programada) {
    const { error } = await supabase.from('produccion_programada').delete().eq('id', p.id)
    if (error) { alert('Error al quitar: ' + error.message); return }
    setProgramadas(prev => prev.filter(x => x.id !== p.id))
    cargar()
  }

  // ── Backlog filtrado ────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase()
  const backlogVisible = useMemo(() => backlog.filter(w =>
    !q || w.orden.toLowerCase().includes(q) || (w.descripcion ?? '').toLowerCase().includes(q)
  ), [backlog, q])

  const progLinea = useMemo(
    () => programadas.filter(p => p.linea === linea),
    [programadas, linea]
  )

  return (
    <div className="max-w-[1500px] mx-auto">
      {/* Pestañas de línea + navegación de semana */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex gap-1.5">
          {LINEAS.map(l => {
            const n = programadas.filter(p => p.linea === l).length
            return (
              <button
                key={l}
                onClick={() => setLinea(l)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  linea === l
                    ? 'bg-red-900 text-onbrand'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {l}
                {n > 0 && (
                  <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-full ${
                    linea === l ? 'bg-red-800' : 'bg-stone-300 text-stone-700'
                  }`}>{n}</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setMonday(m => addDays(m, -7))}
            className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 text-sm">←</button>
          <div className="text-sm font-medium text-stone-700 min-w-[150px] text-center">
            Semana {getISOWeek(monday)} · {toISODate(monday).slice(5)} → {toISODate(addDays(monday, 6)).slice(5)}
          </div>
          <button onClick={() => setMonday(m => addDays(m, 7))}
            className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 text-sm">→</button>
          <button onClick={() => setMonday(mondayOf(new Date()))}
            className="px-3 py-1.5 rounded-lg bg-stone-800 text-white text-sm font-medium">Hoy</button>
        </div>
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-4">
        {/* ── Backlog ── */}
        <div className="bg-white border border-stone-200 rounded-xl p-3 h-[560px] flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-stone-500">
              WOs sin programar
            </h2>
            <span className="text-[11px] text-stone-400">{backlogVisible.length}</span>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar WO o descripción…"
            className="w-full border border-stone-200 rounded-lg px-2.5 py-1.5 text-xs mb-2 focus:outline-none focus:border-red-400"
          />
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {loading && <p className="text-xs text-stone-400">Cargando…</p>}
            {!loading && backlogVisible.length === 0 && (
              <p className="text-xs text-stone-400 italic">No hay WOs pendientes en esta ventana.</p>
            )}
            {backlogVisible.map(w => (
              <div
                key={w.orden}
                draggable
                onDragStart={() => setDragWo(w.orden)}
                onDragEnd={() => setDragWo(null)}
                className={`border rounded-lg px-2.5 py-2 cursor-grab active:cursor-grabbing transition-colors ${
                  dragWo === w.orden ? 'border-red-400 bg-red-50' : 'border-stone-200 bg-stone-50 hover:border-stone-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-stone-800 text-xs">{w.orden}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    w.fraccionado === 'SI' ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-500'
                  }`}>{w.fraccionado === 'SI' ? 'Fracc.' : 'No fracc.'}</span>
                </div>
                <div className="text-[11px] text-stone-600 truncate mt-0.5" title={w.descripcion ?? ''}>
                  {w.descripcion ?? '—'}
                </div>
                <div className="text-[11px] text-stone-400 mt-0.5 tabular-nums">
                  {w.cajas.toLocaleString('es-AR')} cajas
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Grilla Gantt semanal ── */}
        <div className="bg-white border border-stone-200 rounded-xl p-3 overflow-x-auto">
          <div className="flex" style={{ minWidth: 760 }}>
            {/* Eje de horas */}
            <div className="shrink-0 w-9 pt-7">
              <div className="relative" style={{ height: DIA_H }}>
                {Array.from({ length: 9 }, (_, i) => i * 3).map(h => (
                  <div key={h} className="absolute left-0 right-0 text-[9px] text-stone-400 tabular-nums -translate-y-1/2"
                    style={{ top: (h / 24) * DIA_H }}>
                    {String(h).padStart(2, '0')}h
                  </div>
                ))}
              </div>
            </div>

            {/* Columnas de días */}
            {dias.map(d => {
              const bloques = progLinea
                .filter(p => p.fecha === d.iso)
                .sort((a, b) => a.orden_en_dia - b.orden_en_dia)
              const isToday = d.iso === toISODate(new Date())
              return (
                <div key={d.iso} className="flex-1 min-w-[92px] border-l border-stone-100">
                  {/* Encabezado del día */}
                  <div className={`text-center pb-1 mb-0.5 ${isToday ? 'text-red-800' : 'text-stone-600'}`}>
                    <div className="text-[11px] font-semibold">{d.dow}</div>
                    <div className="text-[10px] tabular-nums">{d.label}</div>
                  </div>

                  {/* Timeline drop-zone */}
                  <div
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                      const wo = backlog.find(w => w.orden === dragWo)
                      if (wo) programar(wo, d.iso)
                      setDragWo(null)
                    }}
                    className={`relative mx-0.5 rounded-md border border-dashed transition-colors ${
                      dragWo ? 'border-red-300 bg-red-50/40' : 'border-stone-200 bg-stone-50/40'
                    }`}
                    style={{ height: DIA_H }}
                  >
                    {/* Líneas de turno (06/14/22) */}
                    {[6, 14, 22].map(h => (
                      <div key={h} className="absolute left-0 right-0 border-t border-stone-200/70"
                        style={{ top: (h / 24) * DIA_H }} />
                    ))}

                    {bloques.map(p => <Bloque key={p.id} p={p} onQuitar={() => quitar(p)} />)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-stone-400 mt-3">
        Arrastrá una WO del panel izquierdo a un día para programarla en la línea <b>{linea}</b>.
        La duración se calcula por cajas ÷ velocidad de línea + setup. Click en un bloque para quitarlo.
      </p>
    </div>
  )
}

// ── Bloque del Gantt ─────────────────────────────────────────────────────────
function Bloque({ p, onQuitar }: { p: Programada; onQuitar: () => void }) {
  const ini = new Date(p.hora_inicio)
  const minDesdeMedianoche = ini.getHours() * 60 + ini.getMinutes()
  const totalMin = p.setup_min + p.duracion_min

  const top = (minDesdeMedianoche / 1440) * DIA_H
  const rawH = (totalMin / 1440) * DIA_H
  const h = Math.max(18, Math.min(rawH, DIA_H - top))
  const cruzaMedianoche = top + rawH > DIA_H

  return (
    <button
      onClick={onQuitar}
      title={`${p.wo} · ${p.descripcion ?? ''}\n${fmtHora(p.hora_inicio)}–${fmtHora(p.hora_fin)} · ${totalMin} min${p.setup_min ? ` (setup ${p.setup_min})` : ''}\nClick para quitar`}
      className="absolute left-0.5 right-0.5 rounded-md bg-red-800 hover:bg-red-700 text-white text-left px-1.5 py-1 overflow-hidden shadow-sm"
      style={{ top, height: h }}
    >
      <div className="text-[10px] font-mono font-semibold leading-tight truncate">{p.wo}</div>
      {h > 30 && (
        <div className="text-[9px] opacity-80 leading-tight tabular-nums">
          {fmtHora(p.hora_inicio)}{cruzaMedianoche ? ' ↓' : `–${fmtHora(p.hora_fin)}`}
        </div>
      )}
      {h > 44 && (
        <div className="text-[9px] opacity-70 leading-tight truncate">{p.cajas?.toLocaleString('es-AR')} cj</div>
      )}
    </button>
  )
}
