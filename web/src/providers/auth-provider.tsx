import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { Session } from "@supabase/supabase-js"

import { isAllowedEmail } from "@/lib/auth/email-domain"
import type { UserProfile } from "@/types"
import {
  getSession,
  hasSupabase,
  onAuthStateChange,
  signOut as supabaseSignOut,
  userToProfile,
} from "@/lib/supabase"
import { fetchUserProfile } from "@/lib/supabase/profile"
import { useTheme, type Theme } from "@/providers/theme-provider"

interface AuthContextValue {
  session: Session | null
  user: UserProfile | null
  isLoading: boolean
  isConfigured: boolean
  isAuthenticated: boolean
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const isConfigured = hasSupabase()
  const { hydrateTheme } = useTheme()
  /** Último usuário cujo perfil já foi carregado (evita reler a cada evento). */
  const lastProfileUserIdRef = useRef<string | null>(null)
  /** Tema do banco só na 1ª hidratação — depois a escolha da sessão manda. */
  const hydratedThemeRef = useRef(false)

  const loadProfile = useCallback(
    async (next: Session | null, isActive: () => boolean = () => true) => {
      if (!next?.user) {
        lastProfileUserIdRef.current = null
        hydratedThemeRef.current = false
        if (isActive()) setUser(null)
        return
      }
      if (!isAllowedEmail(next.user.email)) {
        await supabaseSignOut().catch(() => undefined)
        lastProfileUserIdRef.current = null
        hydratedThemeRef.current = false
        if (isActive()) {
          setSession(null)
          setUser(null)
        }
        return
      }
      lastProfileUserIdRef.current = next.user.id
      try {
        const profile = await fetchUserProfile(next.user)
        if (!isActive()) return
        setUser(profile)
        const theme = profile.preferences?.theme
        if (
          !hydratedThemeRef.current &&
          (theme === "light" || theme === "dark" || theme === "system")
        ) {
          hydratedThemeRef.current = true
          hydrateTheme(theme as Theme)
        }
      } catch {
        if (isActive()) setUser(userToProfile(next.user))
      }
    },
    [hydrateTheme],
  )

  useEffect(() => {
    let active = true

    if (!isConfigured) {
      setSession(null)
      setUser(null)
      setIsLoading(false)
      return
    }

    const isActive = () => active
    // Rede pendurada não pode deixar a UI presa em "Carregando sessão...".
    const bootstrapTimeout = window.setTimeout(() => {
      if (active) setIsLoading(false)
    }, 8_000)

    void getSession()
      .then(async (s) => {
        if (!active) return
        setSession(s)
        await loadProfile(s, isActive)
      })
      .catch(() => {
        if (!active) return
        setSession(null)
        setUser(null)
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    const unsubscribe = onAuthStateChange((event, next) => {
      if (!active) return
      setSession(next)
      // TOKEN_REFRESHED (a cada ~1h) e afins não precisam reler o perfil nem
      // re-hidratar o tema — só a sessão mudou.
      const mesmoUsuario =
        Boolean(next?.user?.id) && next?.user?.id === lastProfileUserIdRef.current
      const recarregarPerfil =
        !mesmoUsuario ||
        event === "SIGNED_IN" ||
        event === "INITIAL_SESSION" ||
        event === "USER_UPDATED"
      if (!recarregarPerfil) {
        setIsLoading(false)
        return
      }
      void loadProfile(next, isActive).finally(() => {
        if (active) setIsLoading(false)
      })
    })

    return () => {
      active = false
      window.clearTimeout(bootstrapTimeout)
      unsubscribe()
    }
  }, [isConfigured, loadProfile])

  const signOut = useCallback(async () => {
    await supabaseSignOut()
    lastProfileUserIdRef.current = null
    hydratedThemeRef.current = false
    setSession(null)
    setUser(null)
  }, [])

  const refreshProfile = useCallback(async () => {
    await loadProfile(session)
  }, [loadProfile, session])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      isLoading,
      isConfigured,
      isAuthenticated: Boolean(session?.user),
      signOut,
      refreshProfile,
    }),
    [session, user, isLoading, isConfigured, signOut, refreshProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth deve ser usado dentro de AuthProvider")
  }
  return ctx
}
