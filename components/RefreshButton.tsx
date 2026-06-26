'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'

// Dispara el MISMO sync que ProgramacionCQ: inserta una solicitud en `refresh_log`
// (status='pendiente') que el watcher (sync-supabase.ps1) levanta por polling.
type S = 'idle' | 'pendiente' | 'en_proceso' | 'completado' | 'timeout'

export default function RefreshButton({ onComplete }: { onComplete?: () => void }) {
  const [state, setState] = useState<S>('idle')

  async function handleRefresh() {
    if (state !== 'idle') return
    setState('pendiente')
    const { data } = await supabase.from('refresh_log').insert({ status: 'pendiente' }).select('id').single()
    if (!data?.id) { setState('idle'); return }
    const id = data.id
    const start = Date.now()
    const poll = setInterval(async () => {
      if (Date.now() - start > 10 * 60 * 1000) {
        clearInterval(poll); setState('timeout'); setTimeout(() => setState('idle'), 5000); return
      }
      const { data: row } = await supabase.from('refresh_log').select('status').eq('id', id).single()
      if (row?.status === 'en_proceso') setState('en_proceso')
      if (row?.status === 'completado') {
        clearInterval(poll); setState('completado'); onComplete?.(); setTimeout(() => setState('idle'), 4000)
      }
    }, 8000)
  }

  const cfg: Record<S, { label: string; cls: string; spin: boolean }> = {
    idle:       { label: 'Actualizar',     cls: 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50 shadow-sm', spin: false },
    pendiente:  { label: 'Esperando…',     cls: 'border-stone-200 bg-stone-50 text-stone-500 cursor-wait',              spin: true  },
    en_proceso: { label: 'Actualizando…',  cls: 'border-amber-200 bg-amber-50 text-amber-700 cursor-wait',              spin: true  },
    completado: { label: '✓ Listo',        cls: 'border-emerald-200 bg-emerald-50 text-emerald-700',                    spin: false },
    timeout:    { label: 'Sin respuesta',  cls: 'border-red-200 bg-red-50 text-red-700',                                spin: false },
  }
  const { label, cls, spin } = cfg[state]

  return (
    <button
      onClick={handleRefresh}
      disabled={state !== 'idle'}
      title="Trae datos frescos de JDE (corre el sync)"
      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:cursor-not-allowed ${cls}`}
    >
      <span className={spin ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
      {label}
    </button>
  )
}
