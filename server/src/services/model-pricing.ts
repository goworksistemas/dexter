/**
 * Preços por modelo (DB) e cálculo de cost_usd por mensagem.
 */
import { roundCostUsd } from "../lib/money.js"
import { supabase } from "../lib/supabase.js"

export interface ModelPricingRow {
  id: string
  input_usd_per_million: number | null
  output_usd_per_million: number | null
  updated_at: string
}

const CACHE_TTL_MS = 30_000
let cache: { at: number; map: Map<string, ModelPricingRow> } | null = null

export function invalidateModelPricingCache(): void {
  cache = null
}

async function pricingMap(): Promise<Map<string, ModelPricingRow>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map
  const { data, error } = await supabase
    .from("dexter_model_pricing")
    .select("id, input_usd_per_million, output_usd_per_million, updated_at")
  if (error) throw new Error(`model pricing: ${error.message}`)
  const map = new Map<string, ModelPricingRow>()
  for (const row of data ?? []) {
    map.set(String(row.id), {
      id: String(row.id),
      input_usd_per_million:
        row.input_usd_per_million != null
          ? Number(row.input_usd_per_million)
          : null,
      output_usd_per_million:
        row.output_usd_per_million != null
          ? Number(row.output_usd_per_million)
          : null,
      updated_at: String(row.updated_at ?? ""),
    })
  }
  cache = { at: Date.now(), map }
  return map
}

/** Resolve preço por id de catálogo (provider:modelo) ou nome API (claude-sonnet-5). */
export function resolvePricingRow(
  map: Map<string, ModelPricingRow>,
  modelRef: string,
): ModelPricingRow | null {
  const ref = modelRef.trim()
  if (!ref) return null

  let row = map.get(ref)
  if (row) return row

  if (ref.includes(":")) {
    const apiOnly = ref.slice(ref.indexOf(":") + 1)
    const byApi = map.get(apiOnly)
    if (byApi) return byApi
  }

  let best: ModelPricingRow | null = null
  let bestRank = 99
  for (const [k, v] of map) {
    if (!v.input_usd_per_million && !v.output_usd_per_million) continue
    if (k === ref) return v
    if (k.endsWith(`:${ref}`)) {
      if (bestRank > 1) {
        best = v
        bestRank = 1
      }
      continue
    }
    const api = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k
    if (api === ref) {
      if (bestRank > 2) {
        best = v
        bestRank = 2
      }
    }
  }
  return best
}

export async function ensureModelPricingRows(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return
  const now = new Date().toISOString()
  const { error } = await supabase.from("dexter_model_pricing").upsert(
    unique.map((id) => ({
      id,
      pricing_source: "sync",
      updated_at: now,
    })),
    { onConflict: "id", ignoreDuplicates: true },
  )
  if (error) throw new Error(`ensureModelPricingRows: ${error.message}`)
}

/**
 * Multiplicadores do prompt caching sobre o preço de INPUT do modelo, da
 * tabela pública da Anthropic: gravar no cache custa 1,25× (TTL de 5 min) e
 * ler do cache custa 0,10×.
 * https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
const CACHE_WRITE_PRICE_MULTIPLIER = 1.25
const CACHE_READ_PRICE_MULTIPLIER = 0.1

export interface CacheTokens {
  /** cache_creation_input_tokens do usage da Anthropic. */
  cacheWriteTokens?: number
  /** cache_read_input_tokens do usage da Anthropic. */
  cacheReadTokens?: number
}

/**
 * Custo da mensagem em USD. `tokensIn` são só os tokens de entrada NÃO
 * cacheados; os tokens de cache entram ponderados pelos multiplicadores acima
 * (providers sem prompt caching simplesmente não passam esse argumento).
 */
export async function computeMessageCostUsd(
  catalogModelId: string | undefined,
  tokensIn?: number,
  tokensOut?: number,
  cache?: CacheTokens,
): Promise<number | null> {
  if (!catalogModelId) return null
  const tin = tokensIn ?? 0
  const tout = tokensOut ?? 0
  const tWrite = cache?.cacheWriteTokens ?? 0
  const tRead = cache?.cacheReadTokens ?? 0
  if (tin <= 0 && tout <= 0 && tWrite <= 0 && tRead <= 0) return null

  const map = await pricingMap()
  const row = resolvePricingRow(map, catalogModelId)
  if (!row?.input_usd_per_million && !row?.output_usd_per_million) {
    return null
  }

  const inputPrice = row.input_usd_per_million ?? 0
  const inCost = (tin / 1_000_000) * inputPrice
  const writeCost =
    (tWrite / 1_000_000) * inputPrice * CACHE_WRITE_PRICE_MULTIPLIER
  const readCost =
    (tRead / 1_000_000) * inputPrice * CACHE_READ_PRICE_MULTIPLIER
  const outCost =
    (tout / 1_000_000) * (row.output_usd_per_million ?? 0)
  const total = inCost + writeCost + readCost + outCost
  return total > 0 ? roundCostUsd(total) : null
}

export async function enrichModelsWithPricing<T extends { id: string }>(
  models: T[],
): Promise<
  (T & {
    inputUsdPerMillion: number | null
    outputUsdPerMillion: number | null
  })[]
> {
  const map = await pricingMap()
  return models.map((m) => {
    const row = resolvePricingRow(map, m.id)
    return {
      ...m,
      inputUsdPerMillion: row?.input_usd_per_million ?? null,
      outputUsdPerMillion: row?.output_usd_per_million ?? null,
    }
  })
}

export async function listModelPricing(): Promise<ModelPricingRow[]> {
  const map = await pricingMap()
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function upsertModelPricing(
  id: string,
  patch: {
    input_usd_per_million?: number | null
    output_usd_per_million?: number | null
  },
): Promise<ModelPricingRow> {
  const { data, error } = await supabase
    .from("dexter_model_pricing")
    .upsert(
      {
        id,
        input_usd_per_million: patch.input_usd_per_million ?? null,
        output_usd_per_million: patch.output_usd_per_million ?? null,
        pricing_source: "admin",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("id, input_usd_per_million, output_usd_per_million, updated_at")
    .single()
  if (error || !data) {
    throw new Error(`upsertModelPricing: ${error?.message ?? "sem retorno"}`)
  }
  invalidateModelPricingCache()
  return {
    id: String(data.id),
    input_usd_per_million:
      data.input_usd_per_million != null
        ? Number(data.input_usd_per_million)
        : null,
    output_usd_per_million:
      data.output_usd_per_million != null
        ? Number(data.output_usd_per_million)
        : null,
    updated_at: String(data.updated_at),
  }
}

/** Preenche cost_usd retroativo (mensagens com tokens mas sem custo). */
export async function backfillMessageCosts(): Promise<number> {
  const { data, error } = await supabase.rpc("dexter_backfill_message_costs")
  if (error) throw new Error(`backfillMessageCosts: ${error.message}`)
  return Number(data ?? 0)
}
