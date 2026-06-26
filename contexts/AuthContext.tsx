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
  categoria_id: number | null
}

type PermisosMap = Record<string, { puede_ver: boolean; puede_editar: boolean }>

interface AuthContextValue {
  user: User | null
  perfil: Perfil | null
  permisos: PermisosMap
  isAdmin: boolean
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null, perfil: null, permisos: {}, isAdmin: false, loading: true, signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]     = useState<User | null>(null)
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [permisos, setPermisos] = useState<PermisosMap>({})
  const [loading, setLoading] = useState(true)
  const userIdRef = useRef<string | null>(null)

  async function loadPerfil(u: User) {
    // Reusa `perfiles` + `categoria_permisos` de ProgramacionCQ (misma base).
    const { data: p } = await supabase
      .from('perfiles')
      .select('user_id, nombre, email, categoria_id')
      .eq('user_id', u.id)
      .single()

    setPerfil({
      user_id: u.id,
      nombre: p?.nombre ?? (u.user_metadata?.nombre as string | undefined) ?? null,
      email: p?.email ?? u.email ?? null,
      categoria_id: p?.categoria_id ?? null,
    })

    if (p?.categoria_id) {
      const { data: cp } = await supabase
        .from('categoria_permisos')
        .select('pagina, puede_ver, puede_editar')
        .eq('categoria_id', p.categoria_id)
      const map: PermisosMap = {}
      cp?.forEach(r => { map[r.pagina] = { puede_ver: r.puede_ver, puede_editar: r.puede_editar } })
      setPermisos(map)
    } else {
      setPermisos({})
    }
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
      else { setPerfil(null); setPermisos({}); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // PROGRAMADOR = Admin de ProgramacionCQ (puede ver Configuracion). El resto = VISITA.
  const isAdmin = permisos['configuracion']?.puede_ver === true

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, perfil, permisos, isAdmin, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
