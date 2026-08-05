// Barrel export do módulo de modelos de IA: catálogo (`GET /api/models`) e
// escolha ativa, consumidos pelo header (`ModelSelector`) e pelo runtime do
// chat (`useDexterRuntime`).
export { ModelsProvider, useModels, useUsdBrlRate } from "./models-context"
export { fetchModels } from "./api"
export {
  FALLBACK_USD_BRL,
  formatBRL,
  formatBRLPerMillion,
  formatBRLTotal,
  formatBRLValue,
  formatBRLWithUsd,
  formatUsdReference,
  normalizeRate,
  rateHint,
  usdToBrl,
} from "./currency"
export {
  estimarCustoMensagem,
  estimarTokens,
  limparTextoParaEstimativa,
} from "./cost-estimate"
export type { EstimativaCusto, MensagemHistorico } from "./cost-estimate"
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
  modelAvgCostUsd,
  modelContextHint,
  modelCostScore,
  modelCostTier,
  modelCostTierClass,
  modelCostTierLabel,
  modelCostTierTextClass,
  modelFriendlyMeta,
  modelHasPaidPrice,
  modelKeySource,
  modelPricingDetailBrl,
  modelPricingHeadlineBrl,
  modelPricingInOutBrl,
  modelPricingTag,
  modelPricingTagBrl,
  modelProfileClass,
  modelProfileLabel,
  modelReleaseHint,
  pricingParts,
  providerShortLabel,
} from "./model-meta"
export type {
  ModelCostTier,
  ModelFriendlyMeta,
  ModelProfile,
} from "./model-meta"
