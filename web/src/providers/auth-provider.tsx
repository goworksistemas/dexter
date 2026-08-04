import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

  const loadProfile = useCallback(
    async (next: Session | null) => {
      if (!next?.user) {
        setUser(null)
        return
      }
      if (!isAllowedEmail(next.user.email)) {
        await supabaseSignOut().catch(() => undefined)
        setSession(null)
        setUser(null)
        return
      }
      try {
        const profile = await fetchUserProfile(next.user)
        setUser(profile)
        const theme = profile.preferences?.theme
        if (theme === "light" || theme === "dark" || theme === "system") {
          hydrateTheme(theme as Theme)
        }
      } catch {
        setUser(userToProfile(next.user))
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

    void getSession().then(async (s) => {
      if (!active) return
      setSession(s)
      await loadProfile(s)
      if (active) setIsLoading(false)
    })

    const unsubscribe = onAuthStateChange((_event, next) => {
      if (!active) return
      setSession(next)
      void loadProfile(next).finally(() => {
        if (active) setIsLoading(false)
      })
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [isConfigured, loadProfile])

  const signOut = useCallback(async () => {
    await supabaseSignOut()
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
