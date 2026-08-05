/**
 * Tipos do catálogo de modelos de IA disponíveis (ver `GET /api/models`).
 */

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "xai"
  | "ollama"

/** De onde vem a chave de API efetiva para este modelo. */
export type ModelKeySource = "free" | "personal" | "company"

export interface ModelCapabilities {
  vision: boolean
  files: boolean
  imageGeneration: boolean
}

export interface ModelInfo {
  id: string
  label: string
  provider: ModelProvider
  /** Rótulo humano do provider (ex.: "Anthropic"). */
  providerLabel?: string
  description?: string
  traits?: string[]
  capabilities?: ModelCapabilities
  available?: boolean
  latencyMs?: number
  error?: string
  /** USD por 1M tokens de entrada (sync automático). */
  inputUsdPerMillion?: number | null
  /** USD por 1M tokens de saída (sync automático). */
  outputUsdPerMillion?: number | null
  keySource?: ModelKeySource
  /** Últimos 4 dígitos quando keySource === personal. */
  keyLast4?: string
  inputTokenLimit?: number | null
  maxOutputTokens?: number | null
}

export interface ModelsResponse {
  default: string
  models: ModelInfo[]
  /** Cotação USD→BRL do dia (server: `services/exchange-rate.ts`). */
  usdBrlRate?: number
}

export function modelCaps(m?: ModelInfo | null): ModelCapabilities {
  return (
    m?.capabilities ?? {
      vision: false,
      files: false,
      imageGeneration: false,
    }
  )
}
