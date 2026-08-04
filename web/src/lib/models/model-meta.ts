/**
 * Rótulos de UI para metadados de modelos.
 * Preços reais: entrada e saída em USD / 1M tokens (sem média).
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

/** Número exato de tokens (sem arredondar pra "128k"). */
export function formatTokenCount(n?: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null
  return `${Math.floor(n).toLocaleString("pt-BR")} ctx`
}

/** Só contexto real (input). Não usa max out como fallback. */
export function modelContextHint(model: ModelInfo): string | null {
  const ctx = formatTokenCount(model.inputTokenLimit)
  if (!ctx) return null
  if (model.maxOutputTokens != null && model.maxOutputTokens > 0) {
    const out = Math.floor(model.maxOutputTokens).toLocaleString("pt-BR")
    return `${ctx} · saída ${out}`
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

export function pricingParts(model: PricingModel): {
  inp: number | null
  out: number | null
} {
  return {
    inp: model.inputUsdPerMillion ?? model.input_usd_per_million ?? null,
    out: model.outputUsdPerMillion ?? model.output_usd_per_million ?? null,
  }
}

/** Tem preço > 0 em entrada ou saída. */
export function modelHasPaidPrice(model: PricingModel): boolean {
  const { inp, out } = pricingParts(model)
  return (inp != null && inp > 0) || (out != null && out > 0)
}

/**
 * Ordenação "mais barato": entrada primeiro (custo dominante), depois saída.
 * Não é média — compara os valores reais.
 */
export function modelCostScore(model: PricingModel): number {
  const { inp, out } = pricingParts(model)
  const inPart = inp != null && Number.isFinite(inp) ? inp : Number.POSITIVE_INFINITY
  const outPart =
    out != null && Number.isFinite(out) ? out : Number.POSITIVE_INFINITY
  if (!Number.isFinite(inPart) && !Number.isFinite(outPart)) return Number.POSITIVE_INFINITY
  // Empacota entrada (peso alto) + saída para um único número comparável.
  const a = Number.isFinite(inPart) ? inPart : 1e9
  const b = Number.isFinite(outPart) ? outPart : 1e9
  return a * 1_000_000 + b
}

export function modelCostTier(model: PricingModel): ModelCostTier {
  const { inp, out } = pricingParts(model)
  if (!modelHasPaidPrice(model)) return "free"
  // Faixa baseada no preço de ENTRADA real (fallback saída).
  const ref =
    inp != null && Number.isFinite(inp) && inp > 0
      ? inp
      : (out ?? 0)
  if (ref < 1) return "low"
  if (ref < 5) return "mid"
  if (ref < 20) return "high"
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

/** Média aritmética (in+out)/2 — null se nenhum preço. */
export function modelAvgCostUsd(model: PricingModel): number | null {
  const { inp, out } = pricingParts(model)
  const vals = [inp, out].filter(
    (n): n is number => n != null && Number.isFinite(n) && n >= 0,
  )
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

/**
 * Tag compacta: média em destaque + in→out.
 * Ex.: "méd $6.25 · $2.50→$10/1M"
 */
export function modelPricingTag(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const { inp, out } = pricingParts(model)
  const avg = modelAvgCostUsd(model)
  const avgLabel = avg != null ? `méd ${formatUsdPerMillion(avg)}` : null
  if (inp != null && out != null) {
    return `${avgLabel} · ${formatUsdPerMillion(inp)}→${formatUsdPerMillion(out)}/1M`
  }
  if (inp != null) return `${avgLabel} · ${formatUsdPerMillion(inp)} in/1M`
  return `${avgLabel} · ${formatUsdPerMillion(out)} out/1M`
}

/** Só o rótulo da média (USD/1M). */
export function modelAvgCostLabel(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const avg = modelAvgCostUsd(model)
  return avg != null ? `${formatUsdPerMillion(avg)}/1M méd.` : "—"
}

/** Texto explicativo: média + entrada + saída. */
export function modelPricingDetail(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) {
    return "Sem custo por uso (ex.: modelo local)"
  }
  const { inp, out } = pricingParts(model)
  const avg = modelAvgCostUsd(model)
  const tier = COST_TIER_LABEL[modelCostTier(model)]
  const parts: string[] = []
  if (avg != null) parts.push(`média ${formatUsdPerMillion(avg)}/1M`)
  if (inp != null) parts.push(`entrada ${formatUsdPerMillion(inp)}/1M`)
  if (out != null) parts.push(`saída ${formatUsdPerMillion(out)}/1M`)
  return `${parts.join(" · ")} · ${tier}`
}

/** Linha do card no modal: média destacada + in/out. */
export function modelPricingHeadline(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const { inp, out } = pricingParts(model)
  const avg = modelAvgCostUsd(model)
  const parts: string[] = []
  if (avg != null) parts.push(`Méd ${formatUsdPerMillion(avg)}`)
  if (inp != null) parts.push(`In ${formatUsdPerMillion(inp)}`)
  if (out != null) parts.push(`Out ${formatUsdPerMillion(out)}`)
  return `${parts.join(" · ")}/1M`
}

export function modelCostTierLabel(tier: ModelCostTier): string {
  return COST_TIER_LABEL[tier]
}

export function modelKeySource(model: ModelInfo): ModelKeySource {
  return model.keySource ?? "company"
}
