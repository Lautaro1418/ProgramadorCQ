// Setups reales entre órdenes (F3) — portado del Optimizador de ProgramacionCQ.
// El setup de una transición es el MÁXIMO de sus componentes (no la suma):
// formato, etiqueta, velcorin, azúcar, caja y cambio de vino. Se devuelve además
// la etiqueta del componente que manda (el del máximo), para mostrarla en la grilla.
import { supabase } from '@/lib/supabase'

const norm = (v: unknown) => String(v ?? '').trim().toUpperCase()

// En setup_formato, un valor >= 900 (centinela) marca un formato que la línea NO
// produce. En esta herramienta manual no se aplica como restricción dura (las
// restricciones de formato por línea se ven después): se ignora para no romper el layout.
const SETUP_INFACTIBLE = 900

export interface SetupAttrs {
  nFormato: string
  color:    string
  velcorin: string
  azucar:   string
  caja:     string
  wineKey:  string   // código de vino equivalente (para detectar cambio de vino)
}

export interface SetupMaps {
  formato:  Map<string, number>   // 'linea|nIni|nFin' → min
  velcorin: Map<string, number>   // 'velIni|velFin' → min
  azucar:   Map<string, number>   // 'azIni|azFin' → min
  caja:     Map<string, number>   // 'linea|cajaIni|cajaFin' → min
  etiqueta: Map<string, number>   // 'linea' → min
  vino:     Map<string, number>   // 'linea|colorIni|colorFin' → min
  attrs:    Map<string, SetupAttrs>   // por orden (WO)
}

export function emptySetupMaps(): SetupMaps {
  return {
    formato: new Map(), velcorin: new Map(), azucar: new Map(),
    caja: new Map(), etiqueta: new Map(), vino: new Map(), attrs: new Map(),
  }
}

const DEFAULT_ATTRS: SetupAttrs = {
  nFormato: '1', color: 'TINTO', velcorin: 'SIN VELCORIN', azucar: 'SIN AZUCAR', caja: '6', wineKey: '',
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Carga las tablas de setup (globales) + deriva los atributos por orden de `ordenes`.
export async function buildSetupMaps(ordenes: string[]): Promise<SetupMaps> {
  const m = emptySetupMaps()

  const [
    { data: attrs }, { data: ifmt }, { data: equiv },
    { data: sFmt }, { data: sVel }, { data: sAz }, { data: sCaja }, { data: sEtiq }, { data: sVino },
  ] = await Promise.all([
    supabase.from('producto_atributos').select('codigo,color,n_formato,velcorin,azucar,caja'),
    supabase.from('insumo_formato').select('producto,n_formato'),
    supabase.from('vino_equivalencias').select('codigo_vino,codigo_equiv'),
    supabase.from('setup_formato').select('linea,n_fmt_ini,n_fmt_fin,minutos'),
    supabase.from('setup_velcorin').select('vel_ini,vel_fin,minutos'),
    supabase.from('setup_azucar').select('az_ini,az_fin,minutos'),
    supabase.from('setup_caja').select('linea,caja_ini,caja_fin,minutos'),
    supabase.from('setup_etiqueta').select('linea,minutos'),
    supabase.from('setup_vino').select('linea,color_ini,color_fin,minutos'),
  ])

  ;(sFmt  ?? []).forEach((r: any) => m.formato.set(`${r.linea}|${r.n_fmt_ini}|${r.n_fmt_fin}`, Number(r.minutos)))
  ;(sVel  ?? []).forEach((r: any) => m.velcorin.set(`${norm(r.vel_ini)}|${norm(r.vel_fin)}`, Number(r.minutos)))
  ;(sAz   ?? []).forEach((r: any) => m.azucar.set(`${norm(r.az_ini)}|${norm(r.az_fin)}`, Number(r.minutos)))
  ;(sCaja ?? []).forEach((r: any) => m.caja.set(`${r.linea}|${r.caja_ini}|${r.caja_fin}`, Number(r.minutos)))
  ;(sEtiq ?? []).forEach((r: any) => m.etiqueta.set(String(r.linea), Number(r.minutos)))
  ;(sVino ?? []).forEach((r: any) => m.vino.set(`${r.linea}|${norm(r.color_ini)}|${norm(r.color_fin)}`, Number(r.minutos)))

  const attrMap  = new Map((attrs ?? []).map((r: any) => [norm(r.codigo), r]))
  const ifmtMap  = new Map((ifmt  ?? []).map((r: any) => [r.producto, r.n_formato as string]))
  const equivMap = new Map((equiv ?? []).map((r: any) => [norm(r.codigo_vino), r.codigo_equiv as string]))

  const uniq = [...new Set(ordenes)]
  for (let i = 0; i < uniq.length; i += 300) {
    const chunk = uniq.slice(i, i + 300)
    const [{ data: prod }, { data: bot }] = await Promise.all([
      supabase.from('producciones').select('orden,insumo,producto,producto_descripcion').in('orden', chunk),
      supabase.from('producciones_insumos').select('orden,insumo,familia').in('orden', chunk).eq('familia', 'BOTELLA'),
    ])
    const botMap = new Map((bot ?? []).map((r: any) => [r.orden, r.insumo as string]))
    ;((prod ?? []) as any[]).forEach(p => {
      const ifr = botMap.get(p.orden) ?? null
      const insumo: string = p.insumo ?? ''
      const isISVTP  = /^ISVTP/i.test(insumo)
      const isEstiba = /^ISE/i.test(insumo) || /-SE$/i.test(insumo)

      let wineKey: string, codVino = ''
      if (isISVTP) { codVino = insumo.replace(/^ISVTP/i, '').replace(/-.*$/, '').trim(); wineKey = equivMap.get(norm(codVino)) ?? codVino }
      else if (isEstiba) wineKey = insumo
      else wineKey = insumo || String(p.orden)

      const a: any =
        attrMap.get(norm(insumo)) ?? attrMap.get(norm(codVino)) ??
        attrMap.get(norm(wineKey)) ?? attrMap.get(norm(p.producto)) ?? {}

      const nFormato = (ifr && ifmtMap.get(ifr)) ?? a.n_formato ?? '1'
      const desc = p.producto_descripcion ?? ''
      const cajaParse = desc.match(/(\d+)\s*[xX]\s*\d+/)
      const caja = String(a.caja ?? (cajaParse ? cajaParse[1] : '6'))

      m.attrs.set(String(p.orden), {
        nFormato: String(nFormato),
        color:    a.color    ?? 'TINTO',
        velcorin: a.velcorin ?? 'SIN VELCORIN',
        azucar:   a.azucar   ?? 'SIN AZUCAR',
        caja, wineKey,
      })
    })
  }
  return m
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Setup entre dos órdenes consecutivas: el MÁXIMO de los componentes + la etiqueta
// del componente que manda. prevOrden null = primera del día (sin setup).
export function setupEntre(prevOrden: string | null, orden: string, linea: string, m: SetupMaps): { min: number; label: string } {
  if (!prevOrden) return { min: 0, label: '' }
  const a = m.attrs.get(prevOrden) ?? DEFAULT_ATTRS
  const b = m.attrs.get(orden)     ?? DEFAULT_ATTRS

  const formatoRaw = m.formato.get(`${linea}|${a.nFormato}|${b.nFormato}`) ?? 0
  const comps: { min: number; label: string }[] = [
    { min: formatoRaw >= SETUP_INFACTIBLE ? 0 : formatoRaw,                 label: 'cambio de formato' },
    { min: m.etiqueta.get(linea) ?? 0,                                      label: 'cambio de etiqueta' },
    { min: m.velcorin.get(`${norm(a.velcorin)}|${norm(b.velcorin)}`) ?? 0,  label: 'cambio de velcorin' },
    { min: m.azucar.get(`${norm(a.azucar)}|${norm(b.azucar)}`) ?? 0,        label: 'cambio de azúcar' },
    { min: m.caja.get(`${linea}|${a.caja}|${b.caja}`) ?? 0,                 label: 'cambio de caja' },
  ]
  if (a.wineKey !== b.wineKey) {
    const vk = `${linea}|${norm(a.color)}|${norm(b.color)}`
    const vinoVal = m.vino.has(vk) ? m.vino.get(vk)! : (norm(a.color) === norm(b.color) ? 0 : 60)
    comps.push({ min: vinoVal, label: 'cambio de vino' })
  }

  let best = comps[0]
  for (const c of comps) if (c.min > best.min) best = c
  return { min: best.min, label: best.min > 0 ? best.label : '' }
}
