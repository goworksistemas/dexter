import * as React from "react"

import { useAuth } from "@/providers/auth-provider"
import { updateProfilePreferences } from "@/lib/supabase/profile"

const LS_KEY = "dexter.sidebarCollapsed"

type SidebarContextValue = {
  /** Aberta em modo off-canvas (mobile). */
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** Desktop: sidebar compacta (só ícones). */
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
  toggleCollapsed: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function readLocalCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1"
  } catch {
    return false
  }
}

function writeLocalCollapsed(value: boolean) {
  try {
    localStorage.setItem(LS_KEY, value ? "1" : "0")
  } catch {
    /* ignore */
  }
}

/** Provider do estado da sidebar (mobile off-canvas + desktop collapse). */
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const { user, refreshProfile, isAuthenticated } = useAuth()
  const [open, setOpen] = React.useState(false)
  const [collapsed, setCollapsedState] = React.useState(readLocalCollapsed)
  const hydratedRef = React.useRef(false)

  // Preferência do perfil (DB) vence o cache local após login.
  React.useEffect(() => {
    if (!isAuthenticated || !user) return
    const fromDb = user.preferences?.sidebarCollapsed
    if (typeof fromDb === "boolean") {
      setCollapsedState(fromDb)
      writeLocalCollapsed(fromDb)
    }
    hydratedRef.current = true
  }, [isAuthenticated, user])

  const setCollapsed = React.useCallback(
    (next: boolean) => {
      setCollapsedState(next)
      writeLocalCollapsed(next)
      if (!isAuthenticated) return
      void updateProfilePreferences({ sidebarCollapsed: next })
        .then(() => refreshProfile())
        .catch(() => {
          /* cache local já aplicado */
        })
    },
    [isAuthenticated, refreshProfile],
  )

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((prev) => !prev),
      collapsed,
      setCollapsed,
      toggleCollapsed: () => setCollapsed(!collapsed),
    }),
    [open, collapsed, setCollapsed],
  )

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  )
}

/** Hook para abrir/fechar/colapsar a sidebar. */
export function useSidebar() {
  const ctx = React.useContext(SidebarContext)
  if (!ctx) {
    throw new Error("useSidebar deve ser usado dentro de <SidebarProvider>")
  }
  return ctx
}
