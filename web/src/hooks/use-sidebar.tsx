import * as React from "react"

type SidebarContextValue = {
  /** Aberta em modo off-canvas (mobile). No desktop a sidebar é sempre visível. */
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

/** Provider do estado de abertura da sidebar (usado só no layout mobile). */
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((prev) => !prev),
    }),
    [open]
  )

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  )
}

/** Hook para abrir/fechar a sidebar off-canvas (mobile). */
export function useSidebar() {
  const ctx = React.useContext(SidebarContext)
  if (!ctx) {
    throw new Error("useSidebar deve ser usado dentro de <SidebarProvider>")
  }
  return ctx
}
