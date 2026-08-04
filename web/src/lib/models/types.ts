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

export interface ModelCapabilities {
  vision: boolean
  files: boolean
  imageGeneration: boolean
}

export interface ModelInfo {
  id: string
  label: string
  provider: ModelProvider
  description?: string
  traits?: string[]
  capabilities?: ModelCapabilities
  available?: boolean
  latencyMs?: number
  error?: string
}

export interface ModelsResponse {
  default: string
  models: ModelInfo[]
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
