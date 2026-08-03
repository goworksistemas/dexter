/**
 * Tipos do catálogo de modelos de IA disponíveis (ver `GET /api/models`).
 */

export type ModelProvider = "anthropic" | "ollama"

export interface ModelInfo {
  id: string
  label: string
  provider: ModelProvider
  available?: boolean
  latencyMs?: number
  error?: string
}

export interface ModelsResponse {
  default: string
  models: ModelInfo[]
}
