'use client'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'

// Rutas accesibles sin sesión
const OPEN_PATHS = new Set(['login', 'reset-password'])

function Shell({ children }: { children: React.ReactNode }) {
  const { user, perfil, loading, signOut } = useAuth()
  const router = useRouter()
  const path = usePathname()
  const pagina = path.split('/').filter(Boolean)[0] ?? ''

  useEffect(() => {
    if (loading) return
    if (!user && !OPEN_PATHS.has(pagina)) router.replace('/login')
  }, [user, loading, pagina, router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-stone-400 text-sm">Cargando…</p>
      </div>
    )
  }

  // Páginas abiertas (login): sin chrome
  if (OPEN_PATHS.has(pagina)) return <>{children}</>

  if (!user) return null

  async function handleSignOut() {
    await signOut()
    router.replace('/login')
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-stone-200 bg-white">
        <div className="px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-2 h-8 bg-red-900 rounded-full" />
            <div className="leading-tight">
              <div className="font-bold text-stone-900 text-sm">Programador de Producción</div>
              <div className="text-stone-500 text-[11px] uppercase tracking-wider">Peñaflor CQ · Fraccionamiento</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-stone-500">{perfil?.nombre ?? perfil?.email ?? ''}</span>
            <button
              onClick={handleSignOut}
              className="text-[11px] text-stone-500 hover:text-red-700 font-medium transition-colors"
            >
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  )
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  )
}
