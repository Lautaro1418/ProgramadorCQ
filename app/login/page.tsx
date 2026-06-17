'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) router.replace('/')
    })
  }, [router])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) setError('Email o contraseña incorrectos.')
    else router.replace('/')
  }

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-2 h-10 bg-red-900 rounded-full" />
          <div>
            <div className="font-bold text-stone-900 text-lg leading-tight">Peñaflor</div>
            <div className="text-stone-500 text-xs uppercase tracking-wider">Programador de Producción</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-sm">
          <h1 className="font-semibold text-stone-900 text-lg mb-5">Iniciar sesión</h1>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1.5">Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                required autoFocus placeholder="usuario@grupopenaflor.com.ar"
                className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm focus:border-red-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1.5">Contraseña</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required
                className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm focus:border-red-400 focus:outline-none"
              />
            </div>

            {error && <p className="text-sm rounded-lg px-3 py-2 text-red-600 bg-red-50">{error}</p>}

            <button
              type="submit" disabled={loading}
              className="w-full bg-red-900 text-onbrand rounded-lg py-2.5 text-sm font-medium hover:bg-red-800 transition-colors disabled:opacity-60"
            >
              {loading ? 'Procesando…' : 'Ingresar'}
            </button>
          </form>
          <p className="text-xs text-stone-400 mt-4 leading-relaxed">
            Usá la misma cuenta de Programación CQ.
          </p>
        </div>

        <p className="text-center text-xs text-stone-400 mt-5">Grupo Peñaflor S.A.</p>
      </div>
    </div>
  )
}
