// Barrel export do módulo de modelos de IA: catálogo (`GET /api/models`) e
// escolha ativa, consumidos pelo header (`ModelSelector`) e pelo runtime do
// chat (`useDexterRuntime`).
export { ModelsProvider, useModels } from "./models-context"
export { fetchModels } from "./api"
export type { ModelInfo, ModelProvider, ModelsResponse } from "./types"
