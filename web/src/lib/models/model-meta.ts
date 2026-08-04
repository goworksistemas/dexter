/**
 * Rótulos de UI para metadados de modelos.
 * Custo mostrado de forma geral (faixa), não entrada vs saída.
 */
import type { ModelInfo, ModelKeySource } from "./types"

export const KEY_SOURCE_LABEL: Record<Exclude<ModelKeySource, "free">, string> = {
  personal: "Sua API",
  company: "GoWork",
}

export type ModelCostTier = "free" | "low" | "mid" | "high" | "premium"

export function providerShortLabel(
  model: Pick<ModelInfo, "provider" | "providerLabel">,
): string {
  return model.providerLabel?.trim() || model.provider
}

export function keySourceClass(source: ModelKeySource): string {
  if (source === "personal") {
    return "bg-violet-500/15 text-violet-800 dark:text-violet-300"
  }
  if (source === "company") {
    return "bg-slate-500/10 text-slate-700 dark:text-slate-300"
  }
  return ""
}

export function formatTokenCount(n?: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M ctx`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k ctx`
  return `${n} ctx`
}

export function modelContextHint(model: ModelInfo): string | null {
  const ctx = formatTokenCount(model.inputTokenLimit ?? model.maxOutputTokens)
  if (!ctx) return null
  if (model.inputTokenLimit && model.maxOutputTokens) {
    const out = formatTokenCount(model.maxOutputTokens)
    return out ? `${ctx} · saída ${out.replace(" ctx", "")}` : ctx
  }
  return ctx
}

export function formatUsdPerMillion(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(2)}`
}

type PricingModel = {
  inputUsdPerMillion?: number | null
  outputUsdPerMillion?: number | null
  input_usd_per_million?: number | null
  output_usd_per_million?: number | null
}

function pricingParts(model: PricingModel): {
  inp: number | null
  out: number | null
} {
  return {
    inp: model.inputUsdPerMillion ?? model.input_usd_per_million ?? null,
    out: model.outputUsdPerMillion ?? model.output_usd_per_million ?? null,
  }
}

/**
 * Custo geral da IA (USD / 1M tokens), média entrada+saída.
 * Usado para ordenar e classificar faixa — o usuário não escolhe por in/out.
 */
export function modelCostScore(model: PricingModel): number {
  const { inp, out } = pricingParts(model)
  const values = [inp, out].filter(
    (n): n is number => n != null && Number.isFinite(n) && n >= 0,
  )
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function modelCostTier(model: PricingModel): ModelCostTier {
  const score = modelCostScore(model)
  const { inp, out } = pricingParts(model)
  const hasPrice =
    (inp != null && inp > 0) || (out != null && out > 0)
  if (!hasPrice) return "free"
  if (score < 1) return "low"
  if (score < 5) return "mid"
  if (score < 20) return "high"
  return "premium"
}

const COST_TIER_LABEL: Record<ModelCostTier, string> = {
  free: "Grátis",
  low: "Econômico",
  mid: "Moderado",
  high: "Caro",
  premium: "Premium",
}

export function modelCostTierClass(tier: ModelCostTier): string {
  if (tier === "free") {
    return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
  }
  if (tier === "low") {
    return "bg-sky-500/12 text-sky-900 dark:text-sky-200"
  }
  if (tier === "mid") {
    return "bg-amber-500/12 text-amber-900 dark:text-amber-200"
  }
  if (tier === "high") {
    return "bg-orange-500/15 text-orange-900 dark:text-orange-200"
  }
  return "bg-rose-500/15 text-rose-900 dark:text-rose-200"
}

/** Só a cor do texto (preço em destaque no modal). */
export function modelCostTierTextClass(tier: ModelCostTier): string {
  if (tier === "free") return "text-emerald-700 dark:text-emerald-300"
  if (tier === "low") return "text-sky-800 dark:text-sky-300"
  if (tier === "mid") return "text-amber-800 dark:text-amber-300"
  if (tier === "high") return "text-orange-800 dark:text-orange-300"
  return "text-rose-800 dark:text-rose-300"
}

/** Tem preço > 0 em entrada ou saída. */
export function modelHasPaidPrice(model: PricingModel): boolean {
  const { inp, out } = pricingParts(model)
  return (inp != null && inp > 0) || (out != null && out > 0)
}

/**
 * Custo médio (entrada+saída)/2 — o que o usuário vê.
 * Ex.: "$2.50/1M" ou "Grátis".
 */
export function modelAvgCostLabel(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  return `${formatUsdPerMillion(modelCostScore(model))}/1M`
}

/** Tag curta no seletor: valor médio por 1M tokens. */
export function modelPricingTag(model: PricingModel): string {
  return modelAvgCostLabel(model)
}

/** Texto explicativo: média + faixa. */
export function modelPricingDetail(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) {
    return "Sem custo por uso (ex.: modelo local)"
  }
  const score = modelCostScore(model)
  const tier = COST_TIER_LABEL[modelCostTier(model)]
  return `Média ${formatUsdPerMillion(score)} por 1M tokens · ${tier}`
}

export function modelCostTierLabel(tier: ModelCostTier): string {
  return COST_TIER_LABEL[tier]
}

export function modelKeySource(model: ModelInfo): ModelKeySource {
  return model.keySource ?? "company"
}
