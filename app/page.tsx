'use client'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { mondayOf, addDays, toISODate, getISOWeek, semanaDesde, fmtHora } from '@/lib/fechas'
import {
  buildDuracionMaps, minutosProduccion,
  type DuracionMaps, type VelocidadRow, type InsumoBotellaRow,
} from '@/lib/duracion'
import { buildSetupMaps, emptySetupMaps, setupEntre, type SetupMaps } from '@/lib/setups'
import RefreshButton from '@/components/RefreshButton'

// ── Constantes ───────────────────────────────────────────────────────────────
const LINEAS = ['L1', 'L2', 'L0', 'TM'] as const
type Linea = (typeof LINEAS)[number]

// Backlog: ordenes con estado >= 40 (40/41 listas · 45 en proceso · 60 c/control pendiente · 98 OK),
// excepto 99 (canceladas). Las < 40 no se muestran.

// Alto del timeline de un día (24h).
const DIA_H = 560
const HORA_INICIO_DEFAULT = 6   // si el día está vacío, la primera WO arranca 06:00

// Lock por línea (F1b): heartbeat cada 3 min; el lock vence a los 10 min sin refresco.
const LOCK_TTL_MS  = 10 * 60 * 1000
const HEARTBEAT_MS = 3 * 60 * 1000
interface LockRow { linea: string; usuario_email: string; usuario_nombre: string | null; last_seen: string }

// Capacidad / turnos por línea y semana (F4).
interface CapRow { linea: string; semana: string; turno: string; paradas_op: number; paradas_ext: number }
const esL1L0 = (l: string) => l === 'L1' || l === 'L0'
const defaultTurno = (l: string) => (esL1L0(l) ? '3T' : 'mañana')
function turnoOpciones(l: string): { val: string; label: string }[] {
  return esL1L0(l)
    ? [{ val: '3T', label: '3 turnos · L→Sáb 13h' }, { val: '4T', label: '4 turnos · L→Dom' }]
    : [{ val: 'mañana', label: 'Mañana · +Sáb' }, { val: 'tarde', label: 'Tarde' }]
}
// Horas disponibles por semana según el turno elegido.
function horasSemana(l: string, turno: string): number {
  if (esL1L0(l)) return turno === '4T' ? 168 : 127   // 3T = lun 06:00 → sáb 13:00
  return turno === 'tarde' ? 40 : 47                  // mañana = Lun-Vie 06-14 + Sáb 06-13
}
// Horas disponibles un día puntual (dow 0=Lun..6=Dom) según el turno. La suma = horasSemana.
function horasDia(l: string, turno: string, dow: number): number {
  if (esL1L0(l)) {
    if (turno === '4T') return 24                         // 24h los 7 días = 168
    return [18, 24, 24, 24, 24, 13, 0][dow] ?? 0          // 3T: lun 06→24, mar-vie 24, sáb→13 = 127
  }
  if (turno === 'tarde') return dow <= 4 ? 8 : 0          // Lun-Vie 14-22 = 40
  return dow <= 4 ? 8 : dow === 5 ? 7 : 0                 // mañana: Lun-Vie 06-14 + Sáb 06-13 = 47
}
const fmtH = (min: number) => `${(min / 60).toLocaleString('es-AR', { maximumFractionDigits: 1 })} h`

// ¿Tengo yo el lock vigente de la línea L? (helper de módulo para usar sin orden de declaración)
function lockMioDe(locks: Record<string, LockRow>, l: string, email: string | null | undefined): boolean {
  const lk = locks[l]
  return !!lk && Date.now() - new Date(lk.last_seen).getTime() < LOCK_TTL_MS && lk.usuario_email === (email ?? '')
}

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
  setupLabel?: string             // componente que manda en el setup (en memoria)
  estado?: string                 // 'oficial' | 'borrador' (F2)
  vinoCode?: string | null        // codigo de vino a mostrar (A2091) — en memoria
  esEstiba?: boolean              // insumo ISE = estiba — en memoria
  botella?: string | null         // codigo de botella (A04) — en memoria
}

// Cajas efectivas: el ajuste manual si existe, si no la de sistema.
function cajasEf(p: Programada): number {
  return p.cajas_ajustado ?? (p.cajas ?? 0)
}

// Recalcula la cadena de un día/línea: cada bloque arranca donde terminó el anterior,
// recomputando el setup real (según la orden previa) y la duración con las cajas efectivas.
function recalcCadena(delDia: Programada[], lineaKey: string, fechaIso: string, m: DuracionMaps, sm: SetupMaps): Programada[] {
  const sorted = [...delDia].sort((a, b) => a.orden_en_dia - b.orden_en_dia)
  let prevFin: Date | null = null
  let prevWo: string | null = null
  return sorted.map((p, i) => {
    const { min: setupMin, label } = setupEntre(prevWo, p.wo, lineaKey, sm)
    // El setup ocurre en el HUECO antes de la orden: producción arranca tras el setup.
    const inicio = prevFin
      ? new Date(prevFin.getTime() + setupMin * 60000)
      : new Date(`${fechaIso}T${String(HORA_INICIO_DEFAULT).padStart(2, '0')}:00:00`)
    const dur = minutosProduccion(cajasEf(p), lineaKey, p.wo, m)
    const fin = new Date(inicio.getTime() + dur * 60000)
    prevFin = fin; prevWo = p.wo
    return { ...p, hora_inicio: inicio.toISOString(), hora_fin: fin.toISOString(), duracion_min: dur, setup_min: setupMin, setupLabel: label, orden_en_dia: i + 1 }
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

// Layout apilado (sin escala de horas): cada bloque tiene un alto MÍNIMO para que se vean
// sus datos, y crece si la orden/setup demanda más minutos. El % diario es el medidor de capacidad.
const PX_PER_MIN  = 0.32
const MIN_ORDER_H = 84   // alcanza para N°, SKU, vino, botella, cantidad
const MIN_SETUP_H = 20
function alturaBloque(min: number, isSetup: boolean): number {
  return Math.round(Math.max(isSetup ? MIN_SETUP_H : MIN_ORDER_H, min * PX_PER_MIN))
}

// Código de vino para mostrar: ISVTPA2091 → A2091, ISVTPC1071-25 → C1071,
// ISEC1071A04491 → C1071 (estiba). Devuelve el code + si es estiba.
function vinoInfo(insumo: string | null | undefined): { code: string | null; estiba: boolean } {
  if (!insumo) return { code: null, estiba: false }
  const s = insumo.trim().toUpperCase()
  const estiba = s.startsWith('ISE')
  const m = s.replace(/^ISVTP/, '').replace(/^ISE/, '').match(/[A-Z]\d{3,4}/)
  return { code: m ? m[0] : null, estiba }
}
// Código de botella: IFR0030A04 → A04 (los 3 del final).
function botellaCode(ifr: string | null | undefined): string | null {
  if (!ifr) return null
  const s = ifr.trim()
  return s.length >= 3 ? s.slice(-3) : s
}

// Color (hsl) determinista por codigo de vino, para el borde del grupo.
function colorDeVino(key: string): string {
  let hsh = 0
  for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) % 360
  return `hsl(${hsh}, 65%, 42%)`
}

// ── Página ───────────────────────────────────────────────────────────────────
export default function ProgramadorPage() {
  const { perfil, isAdmin } = useAuth()
  const [linea, setLinea]   = useState<Linea | null>(null)
  const [monday, setMonday] = useState(() => mondayOf(new Date()))
  const [zoom, setZoom]     = useState<'dia' | 'semana' | 'mes'>('semana')
  const [anchor, setAnchor] = useState<string>(() => toISODate(new Date()))
  const [backlog, setBacklog]       = useState<WoBacklog[]>([])
  const [programadas, setProgramadas] = useState<Programada[]>([])
  const [maps, setMaps]     = useState<DuracionMaps>(() => buildDuracionMaps([], []))
  const [setupMaps, setSetupMaps] = useState<SetupMaps>(() => emptySetupMaps())
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [dragWo, setDragWo]   = useState<string | null>(null)
  const [info, setInfo]       = useState<{ id: number; x: number; y: number } | null>(null)
  const [dragBlock, setDragBlock] = useState<number | null>(null)
  const [locks, setLocks]     = useState<Record<string, LockRow>>({})
  const heldRef = useRef<Set<string>>(new Set())
  const [capacidad, setCapacidad] = useState<Record<string, CapRow>>({})
  const [draftEnabled, setDraftEnabled] = useState(false)   // F2: existe la columna `estado`
  const forkedRef = useRef<Set<string>>(new Set())

  // Días visibles según el zoom: 1 día / 7 (semana) / 28 (4 semanas)
  const dias = useMemo(() => {
    if (zoom === 'dia') {
      const f = new Date(anchor + 'T00:00:00')
      return semanaDesde(mondayOf(f)).filter(d => d.iso === anchor)
    }
    if (zoom === 'mes') return [0, 7, 14, 21].flatMap(off => semanaDesde(addDays(monday, off)))
    return semanaDesde(monday)
  }, [zoom, anchor, monday])
  // La capacidad/% uso es SIEMPRE semanal (semana de `monday`), independiente del zoom
  const semanaDias = useMemo(() => semanaDesde(monday).map(d => d.iso), [monday])

  // ── Carga de datos ─────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setLoading(true)
    // F2: ¿existe la columna `estado`? Si no, la app se comporta como antes (todo oficial).
    const { error: estadoErr } = await supabase.from('produccion_programada').select('estado').limit(1)
    setDraftEnabled(!estadoErr)
    const desde = toISODate(monday)
    const hasta = toISODate(addDays(monday, 28))   // hasta 4 semanas (para el zoom 4-sem)

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

    const programadasData = ((prog ?? []) as Programada[]).map(p => ({ ...p, estado: p.estado ?? 'oficial' }))
    const m = buildDuracionMaps(
      (velRes.data ?? []) as VelocidadRow[],
      (insRes.data ?? []) as InsumoBotellaRow[],
    )

    // Setups reales (F3): tablas setup_* + atributos por orden (backlog ∪ programadas)
    const ordenesAttrs = [...new Set([...woRows.map(w => w.orden), ...programadasData.map(p => p.wo)])]
    const setupM = await buildSetupMaps(ordenesAttrs)

    // Merge: si el SISTEMA (ope_ordenes.cajas_jde) cambió la cantidad de una WO ya
    // programada, se descarta el ajuste manual y se adopta la nueva de sistema.
    let merged: Programada[] = programadasData
    const progWos = [...new Set(programadasData.map(p => p.wo))]
    if (progWos.length) {
      const [sysRes, prodVinoRes, botRes] = await Promise.all([
        supabase.from('ope_ordenes').select('orden,cajas_jde,cod_item_largo').in('orden', progWos),
        supabase.from('producciones').select('orden,insumo').in('orden', progWos),
        supabase.from('producciones_insumos').select('orden,insumo').eq('familia', 'BOTELLA').in('orden', progWos),
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
        return [String(rr.orden), vinoInfo(rr.insumo as string | null)]
      }))
      const botMap = new Map((botRes.data ?? []).map(r => {
        const rr = r as { orden: unknown; insumo: unknown }
        return [String(rr.orden), botellaCode(rr.insumo as string | null)]
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
          const recalced = recalcCadena(merged.filter(x => x.linea === ln && x.fecha === fe), ln, fe, m, setupM)
          const byId = new Map(recalced.map(r => [r.id, r]))
          merged = merged.map(x => byId.get(x.id) ?? x)
          for (const rc of recalced) {
            await supabase.from('produccion_programada').update({
              hora_inicio: rc.hora_inicio, hora_fin: rc.hora_fin, duracion_min: rc.duracion_min, setup_min: rc.setup_min, orden_en_dia: rc.orden_en_dia,
            }).eq('id', rc.id)
          }
        }
      }
      // Enriquecer (en memoria) con SKU + vino + botella para pintar los bloques
      merged = merged.map(p => {
        const v = vinoMap.get(p.wo)
        return {
          ...p,
          sku: skuMap.get(p.wo) ?? null,
          codEq: v?.code ?? null,
          vinoCode: v?.code ?? null,
          esEstiba: v?.estiba ?? false,
          botella: botMap.get(p.wo) ?? null,
        }
      })
    }

    // Recalcular el timeline en memoria con setups reales (corrige el setup fijo viejo).
    // No se persiste acá: cada edición (programar/mover/ajustar) ya persiste su día.
    let finalProg = merged
    const dayKeys = [...new Set(merged.map(p => `${p.linea}|${p.fecha}`))]
    for (const key of dayKeys) {
      const [ln, fe] = key.split('|')
      const rc = recalcCadena(merged.filter(p => p.linea === ln && p.fecha === fe), ln, fe, m, setupM)
      const byId = new Map(rc.map(r => [r.id, r]))
      finalProg = finalProg.map(p => byId.get(p.id) ?? p)
    }

    // Capacidad / turnos de la semana (config por línea)
    const semanasCap = [0, 7, 14, 21].map(o => toISODate(addDays(monday, o)))
    const { data: capData } = await supabase
      .from('capacidad_linea').select('*').in('semana', semanasCap)
    const capMap: Record<string, CapRow> = {}
    ;(capData ?? []).forEach(r => { const rr = r as CapRow; capMap[`${rr.linea}|${rr.semana}`] = rr })

    setProgramadas(finalProg)
    setBacklog(woRows)
    setMaps(m)
    setSetupMaps(setupM)
    setCapacidad(capMap)
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

  // F2: al tener el lock de una línea, forkear su borrador una sola vez
  useEffect(() => {
    if (!draftEnabled || !linea || !isAdmin) return
    if (!lockMioDe(locks, linea, perfil?.email) || forkedRef.current.has(linea)) return
    forkedRef.current.add(linea)
    ensureDraft(linea)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftEnabled, linea, isAdmin, locks, perfil?.email])

  // F2: cuando alguien PLASMA (cambia el oficial), recargar para verlo al instante.
  // Se ignoran los cambios de borrador (no los ve nadie más) y los de mis propias líneas
  // tomadas (no interrumpir mi edición). Requiere Realtime de produccion_programada.
  useEffect(() => {
    if (!draftEnabled) return
    let t: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => { if (t) clearTimeout(t); t = setTimeout(() => cargar(), 800) }
    const ch = supabase.channel('rt-programa')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'produccion_programada' }, payload => {
        const row = (payload.new ?? payload.old ?? {}) as { linea?: string; estado?: string }
        if (row.estado === 'borrador') return                    // borradores: privados
        if (row.linea && heldRef.current.has(row.linea)) return  // mi propia línea: no pisar
        scheduleReload()
      })
      .subscribe()
    return () => { if (t) clearTimeout(t); supabase.removeChannel(ch) }
  }, [draftEnabled, cargar])

  // ── Programar una WO (drop sobre un día) ─────────────────────────────────────
  async function programar(wo: WoBacklog, fechaIso: string) {
    if (!linea) return
    // F2: asegurar que el borrador exista antes de agregar (evita ver solo la WO nueva
    // si se suelta apenas se entra a la línea, antes de que termine el fork)
    if (draftEnabled && lockMioDe(locks, linea, perfil?.email)
        && !programadas.some(p => p.linea === linea && p.estado === 'borrador')) {
      await ensureDraft(linea)
    }
    // Bloques existentes de esta línea+día, para encadenar al final (vista efectiva)
    const delDia = programadasVisible
      .filter(p => p.linea === linea && p.fecha === fechaIso)
      .sort((a, b) => a.orden_en_dia - b.orden_en_dia)

    const ultimo = delDia[delDia.length - 1] ?? null
    const inicio = ultimo
      ? new Date(ultimo.hora_fin)
      : new Date(`${fechaIso}T${String(HORA_INICIO_DEFAULT).padStart(2, '0')}:00:00`)

    const { min: setupMin, label: setupLabel } = setupEntre(ultimo?.wo ?? null, wo.orden, linea, setupMaps)
    const durMin   = minutosProduccion(wo.cajas, linea, wo.orden, maps)
    const totalMin = setupMin + durMin

    const fin = new Date(inicio.getTime() + totalMin * 60000)

    const fila: Record<string, unknown> = {
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
    // F2: la WO se agrega al borrador si tengo el lock de la línea
    if (draftEnabled) fila.estado = lockMioDe(locks, linea, perfil?.email) ? 'borrador' : 'oficial'

    const { data, error } = await supabase
      .from('produccion_programada')
      .insert(fila)
      .select('*')
      .single()

    if (error) { alert('Error al programar: ' + error.message); return }
    setProgramadas(prev => [...prev, { ...(data as Programada), setupLabel }])
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
    const visibles = programadasVisible
      .filter(x => x.linea === p.linea && x.fecha === p.fecha)
      .map(x => x.id === p.id ? { ...x, cajas_ajustado: ajustado } : x)
    const recalced = recalcCadena(visibles, p.linea, p.fecha, maps, setupMaps)
    const byId = new Map(recalced.map(r => [r.id, r]))
    setProgramadas(prev => prev.map(x => byId.get(x.id) ?? x))
    await supabase.from('produccion_programada').update({ cajas_ajustado: ajustado }).eq('id', p.id)
    for (const rc of recalced) {
      await supabase.from('produccion_programada').update({
        hora_inicio: rc.hora_inicio, hora_fin: rc.hora_fin, duracion_min: rc.duracion_min, setup_min: rc.setup_min, orden_en_dia: rc.orden_en_dia,
      }).eq('id', rc.id)
    }
  }

  // ── Mover un bloque (arrastrar a otro día o reordenar dentro del día) ─────────
  async function moverBloque(blockId: number, targetFecha: string, beforeId: number | null) {
    if (!linea || !puedeEditar || beforeId === blockId) return
    const moved = programadas.find(p => p.id === blockId)
    if (!moved) return
    const oldFecha = moved.fecha

    let arr = programadasVisible.map(p => p.id === blockId ? { ...p, fecha: targetFecha } : { ...p })
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
      const recalced = recalcCadena(arr.filter(p => p.linea === linea && p.fecha === fe), linea, fe, maps, setupMaps)
      const byId = new Map(recalced.map(r => [r.id, r]))
      arr = arr.map(p => byId.get(p.id) ?? p)
    }
    const byIdMov = new Map(arr.map(r => [r.id, r]))
    setProgramadas(prev => prev.map(x => byIdMov.get(x.id) ?? x))

    for (const p of arr.filter(p => p.linea === linea && dias.has(p.fecha))) {
      await supabase.from('produccion_programada').update({
        fecha: p.fecha, orden_en_dia: p.orden_en_dia, setup_min: p.setup_min,
        hora_inicio: p.hora_inicio, hora_fin: p.hora_fin, duracion_min: p.duracion_min,
      }).eq('id', p.id)
    }
  }

  // ── Borrador / Plasmar (F2) ──────────────────────────────────────────────────
  // Forkea el oficial de la línea a un borrador propio (si todavía no tengo uno).
  async function ensureDraft(L: string) {
    const { data: existing } = await supabase.from('produccion_programada')
      .select('id,usuario_email').eq('linea', L).eq('estado', 'borrador')
    const rows = (existing ?? []) as { id: number; usuario_email: string | null }[]
    if (rows.some(r => r.usuario_email === (perfil?.email ?? ''))) return   // ya tengo borrador propio
    if (rows.length) await supabase.from('produccion_programada').delete().eq('linea', L).eq('estado', 'borrador')
    const { data: oficiales } = await supabase.from('produccion_programada')
      .select('*').eq('linea', L).eq('estado', 'oficial')
    const ofs = (oficiales ?? []) as Programada[]
    if (ofs.length) {
      await supabase.from('produccion_programada').insert(ofs.map(p => ({
        wo: p.wo, linea: p.linea, fecha: p.fecha, hora_inicio: p.hora_inicio, hora_fin: p.hora_fin,
        duracion_min: p.duracion_min, setup_min: p.setup_min, orden_en_dia: p.orden_en_dia,
        descripcion: p.descripcion, cajas: p.cajas, cajas_ajustado: p.cajas_ajustado,
        fraccionado: p.fraccionado, estado: 'borrador',
        usuario_email: perfil?.email ?? null, usuario_nombre: perfil?.nombre ?? null,
      })))
    }
    await cargar()
  }

  // Publica el borrador de la línea como oficial (lo ve todo el mundo) y deja un
  // borrador fresco para seguir editando (no queda la línea sin borrador).
  async function plasmar() {
    if (!linea || !puedeEditar || !draftEnabled) return
    const L = linea
    const { data: viejos } = await supabase.from('produccion_programada')
      .select('id').eq('linea', L).eq('estado', 'oficial')
    // Promover borrador→oficial primero (sin ventana de pérdida), luego borrar el oficial viejo.
    await supabase.from('produccion_programada').update({ estado: 'oficial' })
      .eq('linea', L).eq('estado', 'borrador')
    const ids = (viejos ?? []).map(r => (r as { id: number }).id)
    if (ids.length) await supabase.from('produccion_programada').delete().in('id', ids)
    await ensureDraft(L)   // re-forkea un borrador fresco desde el nuevo oficial (incluye cargar)
  }

  // Descarta el borrador de la línea: vuelve a un borrador limpio = copia del oficial.
  async function descartarBorrador() {
    if (!linea || !puedeEditar || !draftEnabled) return
    const L = linea
    await supabase.from('produccion_programada').delete().eq('linea', L).eq('estado', 'borrador')
    await ensureDraft(L)
  }

  // ── Guardar capacidad / turno de la línea-semana (F4) ────────────────────────
  async function guardarCapacidad(patch: Partial<Pick<CapRow, 'turno' | 'paradas_op' | 'paradas_ext'>>) {
    if (!linea || !puedeEditar) return
    const semana = toISODate(monday)
    const cur = capacidad[`${linea}|${semana}`]
    const row: CapRow = {
      linea, semana,
      turno:       patch.turno       ?? cur?.turno       ?? defaultTurno(linea),
      paradas_op:  patch.paradas_op  ?? cur?.paradas_op  ?? 0,
      paradas_ext: patch.paradas_ext ?? cur?.paradas_ext ?? 0,
    }
    setCapacidad(prev => ({ ...prev, [`${linea}|${semana}`]: row }))
    await supabase.from('capacidad_linea').upsert(row, { onConflict: 'linea,semana' })
  }

  // ── Vista efectiva (F2): borrador para la línea que edito, oficial para el resto ──
  const q = search.trim().toLowerCase()
  const programadasVisible = useMemo(() => {
    if (!draftEnabled) return programadas
    const draftLines = new Set(programadas.filter(p => p.estado === 'borrador').map(p => p.linea))
    return programadas.filter(p => {
      const verBorrador = draftLines.has(p.linea) && lockMioDe(locks, p.linea, perfil?.email)
      return verBorrador ? p.estado === 'borrador' : p.estado === 'oficial'
    })
  }, [programadas, locks, draftEnabled, perfil?.email])

  const progWosVisible = useMemo(() => new Set(programadasVisible.map(p => p.wo)), [programadasVisible])
  const backlogVisible = useMemo(() => backlog.filter(w =>
    !progWosVisible.has(w.orden) &&
    (!q || w.orden.toLowerCase().includes(q) || (w.descripcion ?? '').toLowerCase().includes(q))
  ), [backlog, q, progWosVisible])

  const progLinea = useMemo(
    () => programadasVisible.filter(p => p.linea === linea),
    [programadasVisible, linea]
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
  const hayBorrador = draftEnabled && !!linea && lockMioDe(locks, linea, perfil?.email) &&
    programadas.some(p => p.linea === linea && p.estado === 'borrador')

  // Capacidad de la línea/semana actual (F4)
  const semKey = toISODate(monday)
  const capActual   = linea ? capacidad[`${linea}|${semKey}`] : undefined
  const turnoActual = linea ? (capActual?.turno ?? defaultTurno(linea)) : ''
  const paradasOp   = capActual?.paradas_op ?? 0
  const paradasExt  = capActual?.paradas_ext ?? 0
  const horasDisp   = linea ? horasSemana(linea, turnoActual) : 0
  const capMin = horasDisp * 60 * Math.max(0, 1 - (paradasOp + paradasExt) / 100)
  const minProgSemana = programadasVisible
    .filter(p => p.linea === linea && semanaDias.includes(p.fecha))
    .reduce((s, p) => s + p.setup_min + p.duracion_min, 0)
  const pctUso = capMin > 0 ? (minProgSemana / capMin) * 100 : 0
  const usoColor = pctUso >= 100 ? 'text-red-700' : pctUso >= 85 ? 'text-amber-700' : 'text-emerald-700'
  const barColor = pctUso >= 100 ? 'bg-red-600' : pctUso >= 85 ? 'bg-amber-500' : 'bg-emerald-500'

  // Navegación / zoom
  const navPrev = () => {
    if (zoom === 'dia') { const a = toISODate(addDays(new Date(anchor + 'T00:00:00'), -1)); setAnchor(a); setMonday(mondayOf(new Date(a + 'T00:00:00'))) }
    else setMonday(m => addDays(m, zoom === 'mes' ? -28 : -7))
  }
  const navNext = () => {
    if (zoom === 'dia') { const a = toISODate(addDays(new Date(anchor + 'T00:00:00'), 1)); setAnchor(a); setMonday(mondayOf(new Date(a + 'T00:00:00'))) }
    else setMonday(m => addDays(m, zoom === 'mes' ? 28 : 7))
  }
  const irHoy = () => { setAnchor(toISODate(new Date())); setMonday(mondayOf(new Date())) }
  const verDia = (iso: string) => { setAnchor(iso); setMonday(mondayOf(new Date(iso + 'T00:00:00'))); setZoom('dia') }
  const navLabel = zoom === 'dia'
    ? `${dias[0]?.dow ?? ''} ${dias[0]?.label ?? ''}`
    : zoom === 'mes'
      ? `Sem ${getISOWeek(monday)}–${getISOWeek(addDays(monday, 21))} · ${toISODate(monday).slice(5)}→${toISODate(addDays(monday, 27)).slice(5)}`
      : `Semana ${getISOWeek(monday)} · ${toISODate(monday).slice(5)}→${toISODate(addDays(monday, 6)).slice(5)}`
  const colMin  = zoom === 'dia' ? 360 : zoom === 'mes' ? 46 : 108
  const gridMin = 40 + dias.length * colMin

  // % de uso de un día (capacidad del turno de la semana de ese día). -1 = sin turno ese día.
  const pctDia = (isoDay: string): number => {
    const dt = new Date(isoDay + 'T00:00:00')
    const dow = (dt.getDay() + 6) % 7
    const cap = linea ? capacidad[`${linea}|${toISODate(mondayOf(dt))}`] : undefined
    const turno = linea ? (cap?.turno ?? defaultTurno(linea)) : ''
    const paradas = (cap?.paradas_op ?? 0) + (cap?.paradas_ext ?? 0)
    const capMin = (linea ? horasDia(linea, turno, dow) : 0) * 60 * Math.max(0, 1 - paradas / 100)
    const used = programadasVisible
      .filter(p => p.linea === linea && p.fecha === isoDay)
      .reduce((s, p) => s + p.setup_min + p.duracion_min, 0)
    if (capMin <= 0) return used > 0 ? Infinity : -1
    return (used / capMin) * 100
  }

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
            const n = programadasVisible.filter(p => p.linea === l).length
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

        <div className="flex items-center gap-2 flex-wrap">
          <RefreshButton onComplete={cargar} />
          {/* Zoom: Día / Semana / 4 sem */}
          <div className="flex rounded-lg bg-stone-100 p-0.5">
            {([['dia', 'Día'], ['semana', 'Semana'], ['mes', '4 sem']] as const).map(([z, lbl]) => (
              <button key={z}
                onClick={() => { if (z === 'dia') setMonday(mondayOf(new Date(anchor + 'T00:00:00'))); setZoom(z) }}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                  zoom === z ? 'bg-white text-red-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
                }`}>
                {lbl}
              </button>
            ))}
          </div>
          <button onClick={navPrev}
            className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 text-sm">←</button>
          <div className="text-sm font-medium text-stone-700 min-w-[160px] text-center">{navLabel}</div>
          <button onClick={navNext}
            className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 text-sm">→</button>
          <button onClick={irHoy}
            className="px-3 py-1.5 rounded-lg bg-stone-800 text-white text-sm font-medium">Hoy</button>
        </div>
      </div>

      {editaOtro && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="text-base">🔒</span>
          La línea <b>{linea}</b> la está editando <b>{editaOtro.usuario_nombre || editaOtro.usuario_email}</b>. Estás en modo solo lectura.
        </div>
      )}

      {/* Borrador sin publicar (F2) */}
      {hayBorrador && (
        <div className="mb-3 flex items-center justify-between flex-wrap gap-2 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm">
          <span className="text-stone-700">Estás editando un <b>borrador</b> de {linea}. El resto ve el programa oficial hasta que lo plasmes.</span>
          <div className="flex items-center gap-2">
            <button onClick={descartarBorrador}
              className="px-2.5 py-1 rounded-lg border border-stone-300 bg-white text-stone-600 text-xs hover:bg-stone-100">Descartar borrador</button>
            <button onClick={plasmar}
              className="px-3 py-1 rounded-lg bg-red-900 text-onbrand text-xs font-semibold hover:bg-red-800 shadow-sm">Plasmar Programa</button>
          </div>
        </div>
      )}

      {/* Panel de capacidad / turnos (F4) */}
      <div className="mb-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5">
        <div className="flex items-center justify-between flex-wrap gap-x-5 gap-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-stone-500">Turno</span>
            {turnoOpciones(linea).map(o => (
              <button key={o.val} disabled={!puedeEditar}
                onClick={() => guardarCapacidad({ turno: o.val })}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  turnoActual === o.val ? 'bg-red-900 text-onbrand' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                } ${!puedeEditar ? 'opacity-60 cursor-default' : ''}`}>
                {o.label}
              </button>
            ))}
            <span className="text-[11px] text-stone-400 tabular-nums">{horasDisp} h/sem</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500">% paradas op.</label>
            <NumInput value={paradasOp} disabled={!puedeEditar} onSave={n => guardarCapacidad({ paradas_op: n })} />
            <label className="text-xs text-stone-500">% paradas ext.</label>
            <NumInput value={paradasExt} disabled={!puedeEditar} onSave={n => guardarCapacidad({ paradas_ext: n })} />
          </div>
        </div>
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs mb-0.5">
            <span className="text-stone-500">Uso de la semana</span>
            <span className={`font-semibold tabular-nums ${usoColor}`}>
              {pctUso.toFixed(0)}% · {fmtH(minProgSemana)} / {fmtH(capMin)}
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-stone-100 overflow-hidden">
            <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pctUso)}%` }} />
          </div>
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
          <div className="flex" style={{ minWidth: gridMin }}>
            {dias.map(d => {
              const bloques = progLinea
                .filter(p => p.fecha === d.iso)
                .sort((a, b) => a.orden_en_dia - b.orden_en_dia)
              const isToday = d.iso === toISODate(new Date())
              return (
                <div key={d.iso} className="flex-1 flex flex-col border-l border-stone-100" style={{ minWidth: colMin }}>
                  {/* Encabezado del día (click = zoom a ese día) */}
                  <button
                    onClick={() => (zoom === 'dia' ? setZoom('semana') : verDia(d.iso))}
                    title={zoom === 'dia' ? 'Volver a la semana' : 'Ver este día en detalle'}
                    className={`block w-full text-center pb-1 mb-0.5 rounded hover:bg-stone-100 ${isToday ? 'text-red-800' : 'text-stone-600'}`}>
                    <div className="text-[11px] font-semibold">{d.dow}</div>
                    <div className="text-[10px] tabular-nums">{d.label}</div>
                    <PctBadge pct={pctDia(d.iso)} />
                  </button>

                  {/* Lista apilada de órdenes (drop-zone) */}
                  <div
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                      if (puedeEditar) {
                        if (dragWo) { const wo = backlog.find(w => w.orden === dragWo); if (wo) programar(wo, d.iso) }
                        else if (dragBlock != null) { moverBloque(dragBlock, d.iso, null) }
                      }
                      setDragWo(null); setDragBlock(null)
                    }}
                    className={`flex-1 flex flex-col gap-0.5 mx-0.5 p-0.5 rounded-md border border-dashed transition-colors ${
                      (dragWo || dragBlock != null) ? 'border-red-300 bg-red-50/40' : 'border-stone-200 bg-stone-50/40'
                    }`}
                    style={{ minHeight: DIA_H }}
                  >
                    {bloques.map((p, i) => (
                      <Fragment key={p.id}>
                        {i > 0 && p.setup_min > 0 && zoom !== 'mes' && (
                          <SetupBar min={p.setup_min} label={p.setupLabel} />
                        )}
                        <OrderCard p={p} puedeEditar={puedeEditar} compact={zoom === 'mes'}
                          onInfo={e => setInfo({ id: p.id, x: e.clientX, y: e.clientY })}
                          onQuitar={() => quitar(p)}
                          onMoveStart={() => { setDragBlock(p.id); setDragWo(null) }}
                          onMoveEnd={() => { setDragBlock(null); setDragWo(null) }}
                          onMoveDropHere={() => { if (dragBlock != null && dragBlock !== p.id) moverBloque(dragBlock, p.fecha, p.id); setDragBlock(null); setDragWo(null) }} />
                      </Fragment>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-stone-400 mt-3">
        Arrastrá una WO del panel izquierdo a un día y agregá órdenes hasta llegar al <b>100%</b> (el % de cada día
        es el medidor de capacidad). El gris entre órdenes es el <b>setup</b>. <b>Click</b> en una orden para ver el
        detalle · pasá el mouse y <b>doble-click en la ✕</b> para quitarla. Arrastrá una orden sobre otra para reordenar.
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

// ── Tarjeta de orden (lista apilada) ─────────────────────────────────────────
function OrderCard({ p, puedeEditar, compact, onInfo, onQuitar, onMoveStart, onMoveEnd, onMoveDropHere }: {
  p: Programada
  puedeEditar: boolean
  compact: boolean
  onInfo: (e: MouseEvent) => void
  onQuitar: () => void
  onMoveStart: () => void
  onMoveEnd: () => void
  onMoveDropHere: () => void
}) {
  const adj   = p.cajas_ajustado != null
  const ef    = cajasEf(p)
  const sys   = p.cajas ?? 0
  const arrow = adj ? (ef > sys ? '↑' : ef < sys ? '↓' : '') : ''
  const h = compact ? 18 : alturaBloque(p.duracion_min, false)
  const stripe = p.codEq ? colorDeVino(p.codEq) : '#9ca3af'

  return (
    <div
      className="group relative shrink-0"
      style={{ height: h }}
      draggable={puedeEditar}
      onDragStart={e => { if (!puedeEditar) { e.preventDefault(); return } e.stopPropagation(); onMoveStart() }}
      onDragEnd={onMoveEnd}
      onDragOver={e => { if (puedeEditar) e.preventDefault() }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); onMoveDropHere() }}
    >
      <div
        onClick={onInfo}
        style={{ borderLeftColor: stripe }}
        className={`w-full h-full rounded-md bg-red-800 hover:bg-red-700 text-white overflow-hidden shadow border border-red-950/70 border-l-4 ${puedeEditar ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
      >
        {compact ? (
          <div className="px-1 h-full flex items-center">
            <span className="text-[9px] font-bold font-mono truncate">{p.wo}</span>
          </div>
        ) : (
          <div className="px-1.5 py-1 leading-tight">
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-[12px] font-bold font-mono truncate">{p.wo}</span>
              <span className="text-[10px] font-semibold tabular-nums whitespace-nowrap">
                {arrow}{ef.toLocaleString('es-AR')}<span className="text-white/60"> cj</span>
              </span>
            </div>
            {p.sku && <div className="text-[9px] font-mono text-white/70 truncate">{p.sku}</div>}
            <div className="flex items-center justify-between gap-1 text-[9px] text-white/90 mt-0.5">
              <span className="truncate">{p.esEstiba ? 'est ' : 'vino '}{p.vinoCode ?? '—'}</span>
              <span className="whitespace-nowrap">bot {p.botella ?? '—'}</span>
            </div>
            <div className="text-[9px] text-white/55 tabular-nums">{fmtDur(p.duracion_min)}</div>
          </div>
        )}
      </div>
      {/* ✕ al pasar el mouse · doble-click para quitar (solo si puede editar) */}
      {puedeEditar && !compact && (
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

// Badge de % de uso de un día (objetivo 100%). pct < 0 = sin turno ese día → no se muestra.
function PctBadge({ pct }: { pct: number }) {
  if (pct < 0) return null
  const over = !Number.isFinite(pct) || pct > 105
  const full = Number.isFinite(pct) && pct >= 95
  const cls = over ? 'bg-red-100 text-red-700' : full ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
  return (
    <div className={`mx-auto mt-0.5 w-fit px-1 rounded text-[9px] font-bold tabular-nums ${cls}`}
      title="Uso del día (objetivo 100%)">
      {Number.isFinite(pct) ? `${Math.round(pct)}%` : '+100%'}
    </div>
  )
}

// Setup = rectángulo gris propio que separa dos órdenes (alto mínimo, crece con los minutos).
function SetupBar({ min, label }: { min: number; label?: string }) {
  const h = alturaBloque(min, true)
  return (
    <div
      className="shrink-0 rounded-md border border-stone-300 bg-stone-200 text-stone-600 flex items-center justify-center overflow-hidden"
      style={{ height: h }}
      title={`Setup ${min} min${label ? ` · ${label}` : ''}`}
    >
      <span className="text-[8px] font-semibold leading-none whitespace-nowrap px-1 truncate">
        ⚙ {min}m{label ? ` · ${label.replace('cambio de ', '')}` : ''}
      </span>
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
          <Row k="Setup" v={p.setup_min > 0 ? `${p.setup_min} min${p.setupLabel ? ` · ${p.setupLabel}` : ''}` : '—'} />
          <Row k="SKU" v={p.sku ?? '—'} />
          <Row k={p.esEstiba ? 'Estiba' : 'Vino'} v={p.vinoCode ?? '—'} />
          <Row k="Botella" v={p.botella ?? '—'} />
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

// Input numérico (%) que guarda en onBlur/Enter; se resincroniza si cambia el valor externo.
function NumInput({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => { setV(String(value)) }, [value])
  return (
    <input
      type="number" min={0} max={100} disabled={disabled} value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => onSave(Math.max(0, Math.min(100, Number(v) || 0)))}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-14 border border-stone-200 rounded-md px-1.5 py-1 text-xs tabular-nums focus:outline-none focus:border-red-400 disabled:opacity-60"
    />
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
