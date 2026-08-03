import * as React from "react"

export type Theme = "light" | "dark" | "system"

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  /** Hidrata o tema a partir do DB (profiles.preferences) sem regravar. */
  hydrateTheme: (theme: Theme) => void
}

const STORAGE_KEY = "dexter-theme"

const ThemeProviderContext = React.createContext<ThemeProviderState | null>(
  null,
)

/** Lê a preferência de cor do sistema operacional. */
function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

/** Aplica (ou remove) a classe `.dark` no <html> conforme o tema resolvido. */
function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? getSystemTheme() : theme
  document.documentElement.classList.toggle("dark", resolved === "dark")
}

function readStoredTheme(defaultTheme: Theme): Theme {
  if (typeof window === "undefined") return defaultTheme
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored
  }
  return defaultTheme
}

/**
 * Provider de tema do Dexter: controla light/dark/system, persiste em
 * localStorage (cache local) e sincroniza a classe `.dark` do <html>.
 * A fonte de verdade de longo prazo é `profiles.preferences.theme` —
 * settings/auth chamam `setTheme`/`hydrateTheme`.
 */
export function ThemeProvider({
  children,
  defaultTheme = "system",
}: {
  children: React.ReactNode
  defaultTheme?: Theme
}) {
  const [theme, setThemeState] = React.useState<Theme>(() =>
    readStoredTheme(defaultTheme),
  )

  React.useEffect(() => {
    applyTheme(theme)
  }, [theme])

  React.useEffect(() => {
    if (theme !== "system") return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyTheme("system")
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [theme])

  const setTheme = React.useCallback((next: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }, [])

  const hydrateTheme = React.useCallback((next: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }, [])

  const value = React.useMemo(
    () => ({ theme, setTheme, hydrateTheme }),
    [theme, setTheme, hydrateTheme],
  )

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

/** Hook para ler/definir o tema atual do Dexter. */
export function useTheme() {
  const ctx = React.useContext(ThemeProviderContext)
  if (!ctx) {
    throw new Error("useTheme deve ser usado dentro de <ThemeProvider>")
  }
  return ctx
}
