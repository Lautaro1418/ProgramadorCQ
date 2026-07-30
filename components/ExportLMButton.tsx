'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'

// Vuelca el programa oficial de LM a PROG-LM.xlsm (Z:\FraccionamientoCQ).
// La app corre en Vercel y no llega a la red interna, así que deja el pedido en
// `export_log` y un watcher en una máquina de planta (scripts/watch-export.js)
// lo ejecuta. Mismo patrón que el botón Actualizar con `refresh_log`.
type S = 'idle' | 'pendiente' | 'en_proceso' | 'completado' | 'error' | 'timeout'

export default function ExportLMButton({
  perfil,
}: { perfil?: { email?: string | null; nombre?: string | null } | null }) {
  const [state, setState] = useState<S>('idle')
  const [detalle, setDetalle] = useState<string | null>(null)

  async function handleExport() {
    if (state !== 'idle') return
    if (!confirm(
      'Vas a volcar el programa oficial de LM a PROG-LM.xlsm.\n\n' +
      'Cada semana se reescribe completa: lo que no esté en la app se borra del Excel.\n' +
      'Se hace una copia de seguridad antes de escribir.\n\n¿Seguimos?'
    )) return

    setState('pendiente'); setDetalle(null)
    const { data, error } = await supabase.from('export_log').insert({
      status: 'pendiente', linea: 'LM',
      usuario_email: perfil?.email ?? null, usuario_nombre: perfil?.nombre ?? null,
    }).select('id').single()
    if (error || !data?.id) {
      setState('error')
      setDetalle(error?.message ?? 'no se pudo registrar el pedido')
      setTimeout(() => setState('idle'), 6000)
      return
    }

    const id = data.id
    const start = Date.now()
    const poll = setInterval(async () => {
      if (Date.now() - start > 10 * 60 * 1000) {
        clearInterval(poll); setState('timeout')
        setDetalle('El watcher no respondió. ¿Está corriendo en la máquina de planta?')
        setTimeout(() => setState('idle'), 8000); return
      }
      const { data: row } = await supabase.from('export_log')
        .select('status,detalle').eq('id', id).single()
      if (row?.status === 'en_proceso') setState('en_proceso')
      if (row?.status === 'completado' || row?.status === 'error') {
        clearInterval(poll)
        setState(row.status as S)
        setDetalle(row.detalle ?? null)
        setTimeout(() => { setState('idle'); setDetalle(null) }, 12000)
      }
    }, 4000)
  }

  const cfg: Record<S, { label: string; cls: string; spin: boolean }> = {
    idle:       { label: 'Exportar a PROG-LM', cls: 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50 shadow-sm', spin: false },
    pendiente:  { label: 'Enviando…',          cls: 'border-stone-200 bg-stone-50 text-stone-500 cursor-wait',              spin: true  },
    en_proceso: { label: 'Exportando…',        cls: 'border-amber-200 bg-amber-50 text-amber-700 cursor-wait',              spin: true  },
    completado: { label: '✓ Exportado',        cls: 'border-emerald-200 bg-emerald-50 text-emerald-700',                    spin: false },
    error:      { label: '✕ Falló',            cls: 'border-red-200 bg-red-50 text-red-700',                                spin: false },
    timeout:    { label: 'Sin respuesta',      cls: 'border-red-200 bg-red-50 text-red-700',                                spin: false },
  }
  const { label, cls, spin } = cfg[state]

  return (
    <span className="relative inline-flex">
      <button
        onClick={handleExport}
        disabled={state !== 'idle'}
        title="Vuelca el programa de LM a PROG-LM.xlsm (lo corre un equipo de planta)"
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:cursor-not-allowed ${cls}`}
      >
        <span className={spin ? 'inline-block animate-spin' : 'inline-block'}>⤓</span>
        {label}
      </button>
      {detalle && (
        <span className="absolute top-full left-0 mt-1 z-20 w-72 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[11px] text-stone-600 shadow-lg">
          {detalle}
        </span>
      )}
    </span>
  )
}
