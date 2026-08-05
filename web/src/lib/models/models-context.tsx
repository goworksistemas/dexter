/**
 * Catálogo de modelos com probe real (`GET /api/models?probe=1`).
 * Só modelos `available: true` entram na lista do seletor.
 */
import * as React from "react"

import { useAuth } from "@/providers/auth-provider"
import { fetchModels } from "./api"
import { FALLBACK_USD_BRL, normalizeRate } from "./currency"
import type { ModelInfo } from "./types"

const STORAGE_KEY = "dexter-model"
/** Última cotação conhecida — evita piscar o fallback a cada recarga. */
const RATE_STORAGE_KEY = "dexter-usd-brl"

interface ModelsContextValue {
  /** Modelos online (available === true). */
  models: ModelInfo[]
  /** Todos os retornados pelo probe (inclui offline), para diagnóstico. */
  allModels: ModelInfo[]
  isLoading: boolean
  error: string | null
  selectedModelId: string | null
  /** true se a escolha salva caiu (não está mais online). */
  selectedOffline: boolean
  /** Cotação USD→BRL usada para exibir custos em reais. */
  usdBrlRate: number
  selectModel: (id: string) => void
  refreshModels: () => void
}

const ModelsContext = React.createContext<ModelsContextValue | null>(null)

function readStoredModelId(): string | null {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(STORAGE_KEY)
}

function readStoredRate(): number {
  if (typeof window === "undefined") return FALLBACK_USD_BRL
  const raw = window.localStorage.getItem(RATE_STORAGE_KEY)
  return normalizeRate(raw ? Number.parseFloat(raw) : null)
}

function resolveSelectedId(online: ModelInfo[], defaultId: string): string | null {
  if (online.length === 0) return null
  const stored = readStoredModelId()
  if (stored && online.some((m) => m.id === stored)) return stored
  if (online.some((m) => m.id === defaultId)) return defaultId
  return online[0]!.id
}

export function ModelsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const [allModels, setAllModels] = React.useState<ModelInfo[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedModelId, setSelectedModelId] = React.useState<string | null>(null)
  const [defaultId, setDefaultId] = React.useState<string>("")
  const [usdBrlRate, setUsdBrlRate] = React.useState<number>(readStoredRate)
  const abortRef = React.useRef<AbortController | null>(null)
  /** Probe em voo (lento) — o refresh de foco não pode abortá-lo. */
  const probeControllerRef = React.useRef<AbortController | null>(null)

  const load = React.useCallback((opts?: { probe?: boolean }) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const probe = opts?.probe ?? true

    if (!isAuthenticated) {
      probeControllerRef.current = null
      setAllModels([])
      setSelectedModelId(null)
      setError(null)
      setIsLoading(false)
      return
    }

    // Probe completo só no 1º load / refresh manual — focus não pode travar o chat.
    if (probe) {
      probeControllerRef.current = controller
      setIsLoading(true)
    }
    setError(null)

    fetchModels(controller.signal, { probe })
      .then(({ default: def, models: lista, usdBrlRate: cotacao }) => {
        setDefaultId(def)
        setAllModels(lista)
        if (cotacao != null && Number.isFinite(cotacao) && cotacao > 0) {
          setUsdBrlRate(cotacao)
          window.localStorage.setItem(RATE_STORAGE_KEY, String(cotacao))
        }
        const online = lista.filter((m) => m.available !== false)
        const next = resolveSelectedId(online, def)
        setSelectedModelId(next)
        // Se o id salvo era modelo morto/removido, persiste o realinhamento.
        if (next && readStoredModelId() !== next) {
          window.localStorage.setItem(STORAGE_KEY, next)
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        if (probe) {
          setAllModels([])
          setSelectedModelId(null)
        }
      })
      .finally(() => {
        if (probeControllerRef.current === controller) {
          probeControllerRef.current = null
        }
        // Sem `&& probe`: senão um load(probe:false) que aborta o probe inicial
        // deixa o seletor travado em "carregando" para sempre.
        if (!controller.signal.aborted) setIsLoading(false)
      })
  }, [isAuthenticated])

  React.useEffect(() => {
    if (isAuthLoading) return
    load({ probe: true })
    return () => abortRef.current?.abort()
  }, [isAuthLoading, load])

  // Focus: catálogo em cache do server (probe=0) — não rediscobre providers.
  React.useEffect(() => {
    // Começa "agora": o 1º foco/visibilidade não pode abortar o probe inicial.
    let last = Date.now()
    const onFocus = () => {
      if (document.visibilityState !== "visible" || !isAuthenticated) return
      if (probeControllerRef.current) return
      const now = Date.now()
      if (now - last < 120_000) return
      last = now
      load({ probe: false })
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [isAuthenticated, load])

  const models = React.useMemo(
    () => allModels.filter((m) => m.available !== false),
    [allModels],
  )

  const stored = readStoredModelId()
  const selectedOffline = Boolean(
    stored &&
      selectedModelId !== stored &&
      allModels.some((m) => m.id === stored && m.available === false),
  )

  const selectModel = React.useCallback((id: string) => {
    window.localStorage.setItem(STORAGE_KEY, id)
    setSelectedModelId(id)
  }, [])

  // Se o selecionado sumir da lista online, realinha.
  React.useEffect(() => {
    if (isLoading) return
    if (models.length === 0) {
      setSelectedModelId(null)
      return
    }
    if (!selectedModelId || !models.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(resolveSelectedId(models, defaultId))
    }
  }, [models, selectedModelId, defaultId, isLoading])

  const refreshModels = React.useCallback(
    () => load({ probe: true }),
    [load],
  )

  const value = React.useMemo<ModelsContextValue>(
    () => ({
      models,
      allModels,
      isLoading,
      error,
      selectedModelId,
      selectedOffline,
      usdBrlRate,
      selectModel,
      refreshModels,
    }),
    [
      models,
      allModels,
      isLoading,
      error,
      selectedModelId,
      selectedOffline,
      usdBrlRate,
      selectModel,
      refreshModels,
    ],
  )

  return (
    <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
  )
}

export function useModels(): ModelsContextValue {
  const ctx = React.useContext(ModelsContext)
  if (!ctx) {
    throw new Error("useModels deve ser usado dentro de <ModelsProvider>")
  }
  return ctx
}

/**
 * Cotação para formatar custos. Componentes de custo aparecem em telas fora do
 * fluxo do chat (sidebar, admin), então este hook NÃO exige o provider: sem ele
 * cai na última cotação salva / no fallback.
 */
export function useUsdBrlRate(): number {
  const ctx = React.useContext(ModelsContext)
  return ctx?.usdBrlRate ?? readStoredRate()
}
