'use client'
import {
  createContext, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import { supabase } from '@/lib/supabase'
import type { User } from '@supabase/supabase-js'

export interface Perfil {
  user_id: string
  nombre: string | null
  email: string | null
}

interface AuthContextValue {
  user: User | null
  perfil: Perfil | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null, perfil: null, loading: true, signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]     = useState<User | null>(null)
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [loading, setLoading] = useState(true)
  const userIdRef = useRef<string | null>(null)

  async function loadPerfil(u: User) {
    // Reusa la tabla `perfiles` de ProgramacionCQ (misma base). Si no hay fila,
    // cae al metadata / email del usuario autenticado.
    const { data: p } = await supabase
      .from('perfiles')
      .select('user_id, nombre, email')
      .eq('user_id', u.id)
      .single()

    setPerfil({
      user_id: u.id,
      nombre: p?.nombre ?? (u.user_metadata?.nombre as string | undefined) ?? null,
      email: p?.email ?? u.email ?? null,
    })
    setLoading(false)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null
      userIdRef.current = u?.id ?? null
      setUser(u)
      if (u) loadPerfil(u)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null
      if (u && u.id === userIdRef.current) return
      userIdRef.current = u?.id ?? null
      setUser(u)
      if (u) { setLoading(true); loadPerfil(u) }
      else { setPerfil(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, perfil, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
