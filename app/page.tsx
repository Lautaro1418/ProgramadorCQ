'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
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

// Backlog: ordenes con estado >= 40 (40/41 listas · 45 en proceso · 60 c/control pendiente · 98 OK),
// excepto 99 (canceladas). Las < 40 no se muestran.

// Alto del timeline de un día (24h). 20px por hora.
const DIA_H = 480
const HORA_INICIO_DEFAULT = 6   // si el día está vacío, la primera WO arranca 06:00

// Lock por línea (F1b): heartbeat cada 3 min; el lock vence a los 10 min sin refresco.
const LOCK_TTL_MS  = 10 * 60 * 1000
const HEARTBEAT_MS = 3 * 60 * 1000
interface LockRow { linea: string; usuario_email: string; usuario_nombre: string | null; last_seen: string }

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
  cajas: number | null            // cantidad de SISTEMA (ope_ordenes) al programar
  cajas_ajustado: number | null   // ajuste manual; null = usar la de sistema
  fraccionado: string | null
  sku?: string | null             // cod_item_largo (en memoria, NO persiste)
  codEq?: string | null           // codigo de vino derivado (en memoria, para agrupar)
}

// Cajas efectivas: el ajuste manual si existe, si no la de sistema.
function cajasEf(p: Programada): number {
  return p.cajas_ajustado ?? (p.cajas ?? 0)
}

// Recalcula la cadena de un día/línea: cada bloque arranca donde terminó el anterior,
// recalculando la duración con las cajas efectivas. Devuelve los bloques actualizados.
function recalcCadena(delDia: Programada[], lineaKey: string, fechaIso: string, m: DuracionMaps): Programada[] {
  const sorted = [...delDia].sort((a, b) => a.orden_en_dia - b.orden_en_dia)
  let prevFin: Date | null = null
  return sorted.map((p, i) => {
    const inicio = prevFin ?? new Date(`${fechaIso}T${String(HORA_INICIO_DEFAULT).padStart(2, '0')}:00:00`)
    const dur = minutosProduccion(cajasEf(p), lineaKey, p.wo, m)
    const fin = new Date(inicio.getTime() + (p.setup_min + dur) * 60000)
    prevFin = fin
    return { ...p, hora_inicio: inicio.toISOString(), hora_fin: fin.toISOString(), duracion_min: dur, orden_en_dia: i + 1 }
  })
}

// Formato de duracion: 150 -> "2h 30m", 45 -> "45m".
function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min))
  const h = Math.floor(m / 60), r = m % 60
  return h > 0 ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`
}

// Codigo de vino desde el insumo activo (ISVTPA1077-.. -> A1077). Para agrupar.
function codEqDeInsumo(insumo: string | null | undefined): string | null {
  if (!insumo) return null
  const i = insumo.trim()
  return i.startsWith('ISVTP') ? i.replace(/^ISVTP/, '').replace(/-.*$/, '').trim() : i
}

// Posicion (px) de un bloque en el timeline del dia.
function posBloque(p: Programada): { top: number; h: number } {
  const ini = new Date(p.hora_inicio)
  const minM = ini.getHours() * 60 + ini.getMinutes()
  const total = p.setup_min + p.duracion_min
  const top = (minM / 1440) * DIA_H
  const rawH = (total / 1440) * DIA_H
  const h = Math.max(18, Math.min(rawH, DIA_H - top))
  return { top, h }
}

// Color (hsl) determinista por codigo de vino, para el borde del grupo.
function colorDeVino(key: string): string {
  let hsh = 0
  for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) % 360
  return `hsl(${hsh}, 65%, 42%)`
}

// Grupos de bloques consecutivos con el mismo vino (para encerrarlos con un borde).
function gruposVino(bloques: Programada[]): { key: string; top: number; height: number; n: number }[] {
  const sorted = [...bloques].sort((a, b) => a.orden_en_dia - b.orden_en_dia)
  const out: { key: string; top: number; height: number; n: number }[] = []
  let i = 0
  while (i < sorted.length) {
    const key = sorted[i].codEq ?? sorted[i].wo
    let j = i
    while (j + 1 < sorted.length && (sorted[j + 1].codEq ?? sorted[j + 1].wo) === key) j++
    const a = posBloque(sorted[i]), b = posBloque(sorted[j])
    out.push({ key: String(key), top: a.top, height: (b.top + b.h) - a.top, n: j - i + 1 })
    i = j + 1
  }
  return out
}

// ── Página ───────────────────────────────────────────────────────────────────
export default function ProgramadorPage() {
  const { perfil, isAdmin } = useAuth()
  const [linea, setLinea]   = useState<Linea | null>(null)
  const [monday, setMonday] = useState(() => mondayOf(new Date()))
  const [backlog, setBacklog]       = useState<WoBacklog[]>([])
  const [programadas, setProgramadas] = useState<Programada[]>([])
  const [maps, setMaps]     = useState<DuracionMaps>(() => buildDuracionMaps([], []))
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [dragWo, setDragWo]   = useState<string | null>(null)
  const [info, setInfo]       = useState<{ id: number; x: number; y: number } | null>(null)
  const [dragBlock, setDragBlock] = useState<number | null>(null)
  const [locks, setLocks]     = useState<Record<string, LockRow>>({})
  const heldRef = useRef<Set<string>>(new Set())

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
        .gte('estado', 40)
        .neq('estado', 99)
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
    const m = buildDuracionMaps(
      (velRes.data ?? []) as VelocidadRow[],
      (insRes.data ?? []) as InsumoBotellaRow[],
    )

    // Merge: si el SISTEMA (ope_ordenes.cajas_jde) cambió la cantidad de una WO ya
    // programada, se descarta el ajuste manual y se adopta la nueva de sistema.
    let merged = programadasData
    const progWos = [...new Set(programadasData.map(p => p.wo))]
    if (progWos.length) {
      const [sysRes, prodVinoRes] = await Promise.all([
        supabase.from('ope_ordenes').select('orden,cajas_jde,cod_item_largo').in('orden', progWos),
        supabase.from('producciones').select('orden,insumo').in('orden', progWos),
      ])
      const sysMap = new Map((sysRes.data ?? []).map(r => {
        const rr = r as { orden: unknown; cajas_jde: unknown }
        return [String(rr.orden), Number(rr.cajas_jde)]
      }))
      const skuMap = new Map((sysRes.data ?? []).map(r => {
        const rr = r as { orden: unknown; cod_item_largo: unknown }
        return [String(rr.orden), (rr.cod_item_largo as string | null) ?? null]
      }))
      const vinoMap = new Map((prodVinoRes.data ?? []).map(r => {
        const rr = r as { orden: unknown; insumo: unknown }
        return [String(rr.orden), codEqDeInsumo(rr.insumo as string | null)]
      }))
      const diasTocados = new Set<string>()
      merged = programadasData.map(p => {
        const sys = sysMap.get(p.wo)
        if (sys != null && !Number.isNaN(sys) && sys !== (p.cajas ?? 0)) {
          diasTocados.add(`${p.linea}|${p.fecha}`)
          return { ...p, cajas: sys, cajas_ajustado: null }
        }
        return p
      })
      if (diasTocados.size) {
        for (const p of merged) {
          const orig = programadasData.find(o => o.id === p.id)
          if (orig && orig.cajas !== p.cajas) {
            await supabase.from('produccion_programada').update({ cajas: p.cajas, cajas_ajustado: null }).eq('id', p.id)
          }
        }
        for (const key of diasTocados) {
          const [ln, fe] = key.split('|')
          const recalced = recalcCadena(merged.filter(x => x.linea === ln && x.fecha === fe), ln, fe, m)
          const byId = new Map(recalced.map(r => [r.id, r]))
          merged = merged.map(x => byId.get(x.id) ?? x)
          for (const rc of recalced) {
            await supabase.from('produccion_programada').update({
              hora_inicio: rc.hora_inicio, hora_fin: rc.hora_fin, duracion_min: rc.duracion_min, orden_en_dia: rc.orden_en_dia,
            }).eq('id', rc.id)
          }
        }
      }
      // Enriquecer (en memoria) con SKU + codigo de vino para pintar los bloques
      merged = merged.map(p => ({ ...p, sku: skuMap.get(p.wo) ?? null, codEq: vinoMap.get(p.wo) ?? null }))
    }

    setProgramadas(merged)
    setBacklog(woRows.filter(w => !yaProg.has(w.orden)))
    setMaps(m)
    setLoading(false)
  }, [monday])

  useEffect(() => { cargar() }, [cargar])

  // ── Lock por línea (F1b): solo 1 programador edita una línea a la vez ─────────
  async function loadLocks() {
    const { data } = await supabase
      .from('linea_edicion').select('linea,usuario_email,usuario_nombre,last_seen')
    const map: Record<string, LockRow> = {}
    ;(data ?? []).forEach(r => { const rr = r as LockRow; map[rr.linea] = rr })
    setLocks(map)
  }

  async function tomarLinea(L: Linea) {
    if (!isAdmin || !perfil?.email) return
    // No robar si otra persona la tiene activa (dentro del TTL)
    const { data: r } = await supabase
      .from('linea_edicion').select('usuario_email,last_seen').eq('linea', L).maybeSingle()
    const row = r as { usuario_email: string; last_seen: string } | null
    if (row && row.usuario_email !== perfil.email &&
        Date.now() - new Date(row.last_seen).getTime() < LOCK_TTL_MS) {
      loadLocks(); return
    }
    await supabase.from('linea_edicion').upsert({
      linea: L, usuario_email: perfil.email, usuario_nombre: perfil.nombre,
      last_seen: new Date().toISOString(),
    }, { onConflict: 'linea' })
    heldRef.current.add(L)
    loadLocks()
  }

  // Carga inicial de locks + Realtime + poll de respaldo (por si Realtime no está activo)
  useEffect(() => {
    loadLocks()
    const poll = setInterval(loadLocks, 30000)
    const ch = supabase.channel('rt-linea-edicion')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'linea_edicion' }, () => loadLocks())
      .subscribe()
    return () => { clearInterval(poll); supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Al entrar a una línea (admin), tomar el lock
  useEffect(() => {
    if (linea && isAdmin) tomarLinea(linea)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linea, isAdmin, perfil?.email])

  // Heartbeat: refrescar last_seen de las líneas tomadas
  useEffect(() => {
    if (!isAdmin || !perfil?.email) return
    const email = perfil.email
    const id = setInterval(() => {
      ;[...heldRef.current].forEach(L => {
        supabase.from('linea_edicion').update({ last_seen: new Date().toISOString() })
          .eq('linea', L).eq('usuario_email', email).then(() => {})
      })
    }, HEARTBEAT_MS)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, perfil?.email])

  // Liberar las líneas tomadas al salir / cerrar la pestaña
  useEffect(() => {
    const release = () => {
      const email = perfil?.email
      if (!email) return
      ;[...heldRef.current].forEach(L => {
        supabase.from('linea_edicion').delete().eq('linea', L).eq('usuario_email', email).then(() => {})
      })
    }
    window.addEventListener('beforeunload', release)
    return () => { window.removeEventListener('beforeunload', release); release() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfil?.email])

  // ── Programar una WO (drop sobre un día) ─────────────────────────────────────
  async function programar(wo: WoBacklog, fechaIso: string) {
    if (!linea) return
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

  // ── Ajustar cajas de un bloque programado (recalcula la cadena del día) ───────
  async function ajustarCajas(p: Programada, nuevo: number | null) {
    const sys = p.cajas ?? 0
    const ajustado = (nuevo == null || nuevo <= 0 || nuevo === sys) ? null : Math.round(nuevo)
    const base = programadas.map(x => x.id === p.id ? { ...x, cajas_ajustado: ajustado } : x)
    const recalced = recalcCadena(base.filter(x => x.linea === p.linea && x.fecha === p.fecha), p.linea, p.fecha, maps)
    const byId = new Map(recalced.map(r => [r.id, r]))
    setProgramadas(base.map(x => byId.get(x.id) ?? x))
    await supabase.from('produccion_programada').update({ cajas_ajustado: ajustado }).eq('id', p.id)
    for (const rc of recalced) {
      await supabase.from('produccion_programada').update({
        hora_inicio: rc.hora_inicio, hora_fin: rc.hora_fin, duracion_min: rc.duracion_min, orden_en_dia: rc.orden_en_dia,
      }).eq('id', rc.id)
    }
  }

  // ── Mover un bloque (arrastrar a otro día o reordenar dentro del día) ─────────
  async function moverBloque(blockId: number, targetFecha: string, beforeId: number | null) {
    if (!linea || !puedeEditar || beforeId === blockId) return
    const moved = programadas.find(p => p.id === blockId)
    if (!moved) return
    const oldFecha = moved.fecha

    let arr = programadas.map(p => p.id === blockId ? { ...p, fecha: targetFecha } : { ...p })
    const movedRow = arr.find(p => p.id === blockId)!

    // Día destino: insertar antes de beforeId (o al final)
    const destino = arr.filter(p => p.linea === linea && p.fecha === targetFecha && p.id !== blockId)
      .sort((a, b) => a.orden_en_dia - b.orden_en_dia)
    const idx = beforeId == null ? -1 : destino.findIndex(p => p.id === beforeId)
    const ordenDestino = idx < 0 ? [...destino, movedRow] : [...destino.slice(0, idx), movedRow, ...destino.slice(idx)]
    ordenDestino.forEach((p, i) => { p.orden_en_dia = i + 1 })

    const dias = new Set([targetFecha])
    if (oldFecha !== targetFecha) {
      arr.filter(p => p.linea === linea && p.fecha === oldFecha)
        .sort((a, b) => a.orden_en_dia - b.orden_en_dia)
        .forEach((p, i) => { p.orden_en_dia = i + 1 })
      dias.add(oldFecha)
    }

    for (const fe of dias) {
      const recalced = recalcCadena(arr.filter(p => p.linea === linea && p.fecha === fe), linea, fe, maps)
      const byId = new Map(recalced.map(r => [r.id, r]))
      arr = arr.map(p => byId.get(p.id) ?? p)
    }
    setProgramadas(arr)

    for (const p of arr.filter(p => p.linea === linea && dias.has(p.fecha))) {
      await supabase.from('produccion_programada').update({
        fecha: p.fecha, orden_en_dia: p.orden_en_dia,
        hora_inicio: p.hora_inicio, hora_fin: p.hora_fin, duracion_min: p.duracion_min,
      }).eq('id', p.id)
    }
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

  const infoBlock = info ? (programadas.find(p => p.id === info.id) ?? null) : null

  // Lock vigente de una línea (null si no hay o si venció el TTL)
  const lockVigenteDe = (l: string): LockRow | null => {
    const lk = locks[l]
    return lk && Date.now() - new Date(lk.last_seen).getTime() < LOCK_TTL_MS ? lk : null
  }
  const lockDeOtro = (l: string): LockRow | null => {
    const lk = lockVigenteDe(l)
    return lk && lk.usuario_email !== (perfil?.email ?? '') ? lk : null
  }
  const editaOtro  = linea ? lockDeOtro(linea) : null
  const puedeEditar = isAdmin && !!linea && !editaOtro

  // Pantalla de selección de línea al entrar
  if (linea === null) {
    return <SelectorLinea isAdmin={isAdmin} onPick={l => setLinea(l)} />
  }

  return (
    <div className="w-full">
      {/* Pestañas de línea + navegación de semana */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setLinea(null)} title="Cambiar de línea"
            className="px-2.5 py-2 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-500 text-sm">⟵</button>
          {!isAdmin && (
            <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-amber-100 text-amber-800">Solo lectura</span>
          )}
          {isAdmin && !editaOtro && (
            <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">Editás vos</span>
          )}
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
                {lockDeOtro(l) && (
                  <span className="ml-1" title={`La edita ${lockDeOtro(l)!.usuario_nombre || lockDeOtro(l)!.usuario_email}`}>🔒</span>
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

      {editaOtro && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="text-base">🔒</span>
          La línea <b>{linea}</b> la está editando <b>{editaOtro.usuario_nombre || editaOtro.usuario_email}</b>. Estás en modo solo lectura.
        </div>
      )}

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
                draggable={puedeEditar}
                onDragStart={() => { if (puedeEditar) setDragWo(w.orden) }}
                onDragEnd={() => setDragWo(null)}
                className={`border rounded-lg px-2.5 py-2 transition-colors ${puedeEditar ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'} ${
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
                      if (puedeEditar) {
                        if (dragWo) { const wo = backlog.find(w => w.orden === dragWo); if (wo) programar(wo, d.iso) }
                        else if (dragBlock != null) { moverBloque(dragBlock, d.iso, null) }
                      }
                      setDragWo(null); setDragBlock(null)
                    }}
                    className={`relative mx-0.5 rounded-md border border-dashed transition-colors ${
                      (dragWo || dragBlock != null) ? 'border-red-300 bg-red-50/40' : 'border-stone-200 bg-stone-50/40'
                    }`}
                    style={{ height: DIA_H }}
                  >
                    {/* Líneas de turno (06/14/22) */}
                    {[6, 14, 22].map(h => (
                      <div key={h} className="absolute left-0 right-0 border-t border-stone-200/70"
                        style={{ top: (h / 24) * DIA_H }} />
                    ))}

                    {/* Borde de grupo de vino (órdenes consecutivas del mismo vino) */}
                    {gruposVino(bloques).filter(g => g.n >= 2).map((g, gi) => (
                      <div key={`g${gi}`} className="absolute left-0 right-0 rounded-md pointer-events-none z-0"
                        style={{ top: g.top - 2, height: g.height + 4, border: `2px solid ${colorDeVino(g.key)}` }} />
                    ))}

                    {bloques.map(p => (
                      <Bloque key={p.id} p={p} puedeEditar={puedeEditar}
                        onInfo={e => setInfo({ id: p.id, x: e.clientX, y: e.clientY })}
                        onQuitar={() => quitar(p)}
                        onMoveStart={() => { setDragBlock(p.id); setDragWo(null) }}
                        onMoveEnd={() => { setDragBlock(null); setDragWo(null) }}
                        onMoveDropHere={() => { if (dragBlock != null && dragBlock !== p.id) moverBloque(dragBlock, p.fecha, p.id); setDragBlock(null); setDragWo(null) }} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-stone-400 mt-3">
        Arrastrá una WO del panel izquierdo a un día para programarla en la línea <b>{linea}</b>.
        La duración se calcula por cajas ÷ velocidad de línea + setup. <b>Click</b> en un bloque para ver su info ·
        pasá el mouse y <b>doble-click en la ✕</b> para quitarlo.
      </p>

      {/* Popover de info al hacer click en un bloque */}
      {info && infoBlock && (
        <InfoPopover p={infoBlock} x={info.x} y={info.y} puedeEditar={puedeEditar}
          onClose={() => setInfo(null)}
          onAjustar={v => ajustarCajas(infoBlock, v)} />
      )}
    </div>
  )
}

// ── Bloque del Gantt ─────────────────────────────────────────────────────────
function Bloque({ p, puedeEditar, onInfo, onQuitar, onMoveStart, onMoveEnd, onMoveDropHere }: {
  p: Programada
  puedeEditar: boolean
  onInfo: (e: MouseEvent) => void
  onQuitar: () => void
  onMoveStart: () => void
  onMoveEnd: () => void
  onMoveDropHere: () => void
}) {
  const { top, h } = posBloque(p)
  const totalMin = p.setup_min + p.duracion_min
  const bandH = p.setup_min > 0 && totalMin > 0
    ? Math.max(9, Math.min(h * (p.setup_min / totalMin), h * 0.45))
    : 0

  const adj   = p.cajas_ajustado != null
  const ef    = cajasEf(p)
  const sys   = p.cajas ?? 0
  const arrow = adj ? (ef > sys ? '↑' : ef < sys ? '↓' : '') : ''

  return (
    <div
      className="group absolute left-0.5 right-0.5 z-10"
      style={{ top, height: h }}
      draggable={puedeEditar}
      onDragStart={e => { if (!puedeEditar) { e.preventDefault(); return } e.stopPropagation(); onMoveStart() }}
      onDragEnd={onMoveEnd}
      onDragOver={e => { if (puedeEditar) e.preventDefault() }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); onMoveDropHere() }}
    >
      <div
        onClick={onInfo}
        className={`w-full h-full rounded-md bg-red-800 hover:bg-red-700 text-white overflow-hidden shadow border-2 border-red-950/70 flex flex-col ${puedeEditar ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
      >
        {/* Banda de setup = tiempo entre órdenes (con F3 será el real por componente) */}
        {bandH > 0 && (
          <div
            className="shrink-0 flex items-center justify-center text-[8px] font-semibold text-white/90"
            style={{ height: bandH, backgroundImage: 'repeating-linear-gradient(45deg,#7f1d1d,#7f1d1d 4px,#9f1239 4px,#9f1239 8px)' }}
            title={`Setup ${p.setup_min} min`}
          >
            {bandH > 11 ? `⚙ ${p.setup_min}m` : ''}
          </div>
        )}
        {/* Contenido: N° de orden grande + SKU + duración */}
        <div className="flex-1 min-h-0 px-1.5 py-0.5 overflow-hidden leading-tight">
          <div className="text-[13px] font-bold font-mono truncate">{p.wo}</div>
          {p.sku && <div className="text-[9px] font-mono text-white/75 truncate">{p.sku}</div>}
          <div className="text-[10px] text-white/90 tabular-nums truncate">
            {fmtDur(p.duracion_min)}
            {adj && <span className="ml-1 font-semibold">{arrow}{ef.toLocaleString('es-AR')}cj</span>}
          </div>
        </div>
      </div>
      {/* ✕ al pasar el mouse · doble-click para quitar (solo si puede editar) */}
      {puedeEditar && (
        <button
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => { e.stopPropagation(); onQuitar() }}
          title="Doble-click para quitar del programa"
          aria-label="Quitar (doble-click)"
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-white/90 text-red-700 text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-white"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ── Popover de info de un bloque (click) ──────────────────────────────────────
function InfoPopover({ p, x, y, puedeEditar, onClose, onAjustar }: {
  p: Programada; x: number; y: number; puedeEditar: boolean; onClose: () => void; onAjustar: (nuevo: number | null) => void
}) {
  const totalMin = p.setup_min + p.duracion_min
  const sys = p.cajas ?? 0
  const ef  = cajasEf(p)
  const adj = p.cajas_ajustado != null
  const arrow = adj ? (ef > sys ? '↑' : ef < sys ? '↓' : '') : ''
  const [val, setVal] = useState(String(ef))

  const W = 256, H = 340
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = Math.max(8, Math.min(x, vw - W - 8))
  const top  = Math.max(8, Math.min(y, vh - H - 8))
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed z-50 w-64 bg-white border border-stone-200 rounded-xl shadow-xl p-3 text-xs" style={{ left, top }}>
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <span className="font-mono font-bold text-stone-900 text-sm">{p.wo}</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-sm leading-none">✕</button>
        </div>
        <div className="text-stone-600 mb-2 leading-snug">{p.descripcion ?? '—'}</div>
        <dl className="space-y-1">
          <Row k="Línea" v={p.linea} />
          <Row k="Día" v={p.fecha} />
          <Row k="Horario" v={`${fmtHora(p.hora_inicio)}–${fmtHora(p.hora_fin)}`} />
          <Row k="Total" v={`${totalMin} min`} />
          <Row k="Producción" v={`${p.duracion_min} min`} />
          <Row k="Setup" v={`${p.setup_min} min`} />
          <Row k="Fracc." v={p.fraccionado ?? '—'} />
        </dl>

        {/* Cajas editable: original tachada + nueva con flecha */}
        <div className="border-t border-stone-100 mt-2 pt-2">
          <div className="text-stone-400 mb-1">Cajas</div>
          <div className="flex items-baseline gap-2 mb-2">
            {adj && <span className="text-stone-400 line-through tabular-nums">{sys.toLocaleString('es-AR')}</span>}
            <span className={`text-lg font-bold tabular-nums ${adj ? (ef > sys ? 'text-amber-700' : 'text-emerald-700') : 'text-stone-800'}`}>
              {arrow && <span className="mr-0.5">{arrow}</span>}{ef.toLocaleString('es-AR')}
            </span>
          </div>
          {puedeEditar && (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  type="number" value={val} min={0}
                  onChange={e => setVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') onAjustar(Number(val) || 0) }}
                  className="flex-1 w-full border border-stone-200 rounded-md px-2 py-1 text-xs tabular-nums focus:outline-none focus:border-red-400"
                />
                <button onClick={() => onAjustar(Number(val) || 0)}
                  className="px-2.5 py-1 rounded-md bg-red-900 text-onbrand text-[11px] font-medium hover:bg-red-800 shrink-0">
                  Ajustar
                </button>
                {adj && (
                  <button onClick={() => { setVal(String(sys)); onAjustar(null) }} title="Volver a la cantidad de sistema"
                    className="px-2 py-1 rounded-md border border-stone-200 text-stone-500 text-[11px] hover:bg-stone-50 shrink-0">↺</button>
                )}
              </div>
              <p className="text-[10px] text-stone-400 mt-1.5 leading-snug">
                El ajuste se descarta solo cuando el sistema cambie esta cantidad.
              </p>
            </>
          )}
        </div>

        {puedeEditar && (
          <p className="text-[10px] text-stone-400 mt-2 leading-snug">
            Para quitar: pasá el mouse sobre el bloque y doble-click en la ✕.
          </p>
        )}
      </div>
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-stone-400">{k}</dt>
      <dd className="text-stone-700 font-medium text-right">{v}</dd>
    </div>
  )
}

// ── Selección de línea al entrar ──────────────────────────────────────────────
function SelectorLinea({ isAdmin, onPick }: { isAdmin: boolean; onPick: (l: Linea) => void }) {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
      <h1 className="text-xl font-bold text-stone-800 mb-1">¿A qué línea querés entrar?</h1>
      <p className="text-sm text-stone-500 mb-6">
        {isAdmin
          ? 'Como programador podés ver y editar.'
          : 'Modo solo lectura (visita): vas a poder ver, pero no modificar.'}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {LINEAS.map(l => (
          <button key={l} onClick={() => onPick(l)}
            className="w-28 h-24 rounded-xl border border-stone-200 bg-white hover:border-red-400 hover:bg-red-50/40 shadow-sm flex flex-col items-center justify-center transition-colors">
            <span className="text-2xl font-bold text-stone-800">{l}</span>
            <span className="text-[11px] text-stone-400 mt-1">{l === 'TM' ? 'Tareas manuales' : 'Fraccionamiento'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
