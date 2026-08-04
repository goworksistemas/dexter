// Barrel export do módulo de modelos de IA: catálogo (`GET /api/models`) e
// escolha ativa, consumidos pelo header (`ModelSelector`) e pelo runtime do
// chat (`useDexterRuntime`).
export { ModelsProvider, useModels } from "./models-context"
export { fetchModels } from "./api"
export type {
  ModelCapabilities,
  ModelInfo,
  ModelKeySource,
  ModelProvider,
  ModelsResponse,
} from "./types"
export { modelCaps } from "./types"
export {
  KEY_SOURCE_LABEL,
  formatTokenCount,
  formatUsdPerMillion,
  keySourceClass,
  modelAvgCostLabel,
  modelContextHint,
  modelCostScore,
  modelCostTier,
  modelCostTierClass,
  modelCostTierLabel,
  modelCostTierTextClass,
  modelHasPaidPrice,
  modelKeySource,
  modelPricingDetail,
  modelPricingTag,
  providerShortLabel,
} from "./model-meta"
export type { ModelCostTier } from "./model-meta"
