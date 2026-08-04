/**
 * Catálogos públicos para preencher buracos das APIs dos providers.
 * - Contexto (input): só LiteLLM `max_input_tokens` (nunca OpenRouter).
 * - Preço/descrição/data: LiteLLM + OpenRouter.
 * Sem chute: se a fonte não tiver o campo, fica null.
 */
import { supabase } from "../lib/supabase.js"
import { invalidateModelPricingCache } from "./model-pricing.js"
import type { ModelProvider } from "./model-store.js"

const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

const SYNC_CACHE_MS = 6 * 60 * 60 * 1000
/** Bump quando a semântica do merge muda (ex.: contexto sem OpenRouter). */
const SOURCE_SCHEMA_VERSION = 2

interface CatalogRef {
  id: string
  provider: ModelProvider
  model: string
}

interface ResolvedPrice {
  input_usd_per_million: number
  output_usd_per_million: number
}

/** Metadados opcionais vindos dos feeds públicos. */
export interface PublicModelMeta {
  inputTokenLimit: number | null
  maxOutputTokens: number | null
  releasedAt: string | null
  description: string | null
  supportsVision: boolean | null
  supportsImageGeneration: boolean | null
}

interface LiteLLMEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
  litellm_provider?: string
  max_input_tokens?: number
  max_output_tokens?: number
  max_tokens?: number
  supports_vision?: boolean
  supports_pdf_input?: boolean
}

interface OpenRouterModel {
  id: string
  name?: string
  description?: string
  created?: number
  context_length?: number
  pricing?: {
    prompt?: string
    completion?: string
  }
  top_provider?: {
    max_completion_tokens?: number | null
    context_length?: number | null
  }
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

interface SourceEntry {
  price: ResolvedPrice | null
  meta: PublicModelMeta
}

let sourceCache: {
  at: number
  version: number
  byKey: Map<string, SourceEntry>
} | null = null

function perTokenToPerMillion(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v < 0) return null
  return v * 1_000_000
}

function parseOpenRouterPerMillion(s: string | undefined): number | null {
  if (s == null || s === "") return null
  const n = Number.parseFloat(s)
  if (!Number.isFinite(n) || n < 0) return null
  return n * 1_000_000
}

function positiveInt(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

function toIsoFromUnix(sec: unknown): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null
  return new Date(sec * 1000).toISOString()
}

function mergeMeta(a: PublicModelMeta, b: PublicModelMeta): PublicModelMeta {
  return {
    inputTokenLimit: a.inputTokenLimit ?? b.inputTokenLimit,
    maxOutputTokens: a.maxOutputTokens ?? b.maxOutputTokens,
    releasedAt: a.releasedAt ?? b.releasedAt,
    description: a.description ?? b.description,
    supportsVision: a.supportsVision ?? b.supportsVision,
    supportsImageGeneration:
      a.supportsImageGeneration ?? b.supportsImageGeneration,
  }
}

function mergeEntry(
  map: Map<string, SourceEntry>,
  key: string,
  next: SourceEntry,
): void {
  if (!key) return
  const prev = map.get(key)
  if (!prev) {
    map.set(key, next)
    return
  }
  map.set(key, {
    price: prev.price ?? next.price,
    meta: mergeMeta(prev.meta, next.meta),
  })
}

function indexAliases(
  map: Map<string, SourceEntry>,
  primaryKey: string,
  entry: SourceEntry,
  extraKeys: string[] = [],
): void {
  mergeEntry(map, primaryKey, entry)
  for (const k of extraKeys) mergeEntry(map, k, entry)
  const slash = primaryKey.indexOf("/")
  if (slash > 0) {
    mergeEntry(map, primaryKey.slice(slash + 1), entry)
  }
}

async function loadLiteLLM(map: Map<string, SourceEntry>): Promise<void> {
  const res = await fetch(LITELLM_PRICES_URL, {
    signal: AbortSignal.timeout(25_000),
    headers: { Accept: "application/json" },
  })
  if (!res.ok) return
  const raw = (await res.json()) as Record<string, LiteLLMEntry>
  for (const [key, entry] of Object.entries(raw)) {
    if (key.startsWith("sample_spec")) continue
    const input = perTokenToPerMillion(entry.input_cost_per_token)
    const output = perTokenToPerMillion(entry.output_cost_per_token)
    const price =
      input != null || output != null
        ? {
            input_usd_per_million: input ?? 0,
            output_usd_per_million: output ?? 0,
          }
        : null
    // Contexto EXATO: só max_input_tokens. Nunca usar max_tokens (às vezes é output).
    const maxIn = positiveInt(entry.max_input_tokens)
    const maxOutExplicit = positiveInt(entry.max_output_tokens)
    const maxTokens = positiveInt(entry.max_tokens)
    // max_tokens só como max out se for distinto do contexto (evita chutar saída = janela).
    const maxOut =
      maxOutExplicit ??
      (maxTokens != null && maxIn != null && maxTokens !== maxIn
        ? maxTokens
        : maxOutExplicit)
    const meta: PublicModelMeta = {
      inputTokenLimit: maxIn,
      maxOutputTokens: maxOut,
      releasedAt: null,
      description: null,
      supportsVision:
        typeof entry.supports_vision === "boolean"
          ? entry.supports_vision
          : null,
      supportsImageGeneration: null,
    }
    const source: SourceEntry = { price, meta }
    const aliases = entry.litellm_provider
      ? [`${entry.litellm_provider}/${key}`]
      : []
    indexAliases(map, key, source, aliases)
  }
}

async function loadOpenRouter(map: Map<string, SourceEntry>): Promise<void> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(25_000),
    headers: { Accept: "application/json" },
  })
  if (!res.ok) return
  const body = (await res.json()) as { data?: OpenRouterModel[] }
  for (const m of body.data ?? []) {
    if (!m.id) continue
    const input = parseOpenRouterPerMillion(m.pricing?.prompt)
    const output = parseOpenRouterPerMillion(m.pricing?.completion)
    const price =
      input != null || output != null
        ? {
            input_usd_per_million: input ?? 0,
            output_usd_per_million: output ?? 0,
          }
        : null
    const modalitiesIn = m.architecture?.input_modalities ?? []
    const modalitiesOut = m.architecture?.output_modalities ?? []
    const desc = m.description?.trim() || null
    // OpenRouter NÃO define contexto: context_length costuma ser rota/estendido
    // (ex.: Claude 1M), não o limite exato da API direta do provider.
    const meta: PublicModelMeta = {
      inputTokenLimit: null,
      maxOutputTokens: positiveInt(m.top_provider?.max_completion_tokens),
      releasedAt: toIsoFromUnix(m.created),
      description: desc && desc.length > 400 ? `${desc.slice(0, 397)}...` : desc,
      supportsVision: modalitiesIn.includes("image") ? true : null,
      supportsImageGeneration: modalitiesOut.includes("image") ? true : null,
    }
    const source: SourceEntry = { price, meta }
    const aliases: string[] = []
    // OpenRouter usa google/… e x-ai/… — indexa aliases dos nossos providers.
    if (m.id.startsWith("google/")) {
      aliases.push(`gemini/${m.id.slice("google/".length)}`)
    }
    if (m.id.startsWith("x-ai/")) {
      aliases.push(`xai/${m.id.slice("x-ai/".length)}`)
    }
    indexAliases(map, m.id, source, aliases)
  }
}

async function catalogSources(): Promise<Map<string, SourceEntry>> {
  if (
    sourceCache &&
    sourceCache.version === SOURCE_SCHEMA_VERSION &&
    Date.now() - sourceCache.at < SYNC_CACHE_MS
  ) {
    return sourceCache.byKey
  }
  const byKey = new Map<string, SourceEntry>()
  // Sequencial: LiteLLM primeiro (contexto + preço).
  // OpenRouter só preço/descrição/data — nunca contexto.
  await loadLiteLLM(byKey).catch(() => {})
  await loadOpenRouter(byKey).catch(() => {})
  sourceCache = { at: Date.now(), version: SOURCE_SCHEMA_VERSION, byKey }
  return byKey
}

/** Aliases Anthropic datados → IDs curtos do OpenRouter (claude-sonnet-4.5). */
function anthropicAliasKeys(bare: string): string[] {
  const noDate = bare.replace(/-\d{8}$/, "")
  const dotted = noDate.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2")
  const out = new Set<string>([
    `anthropic/${bare}`,
    bare,
    noDate,
    `anthropic/${noDate}`,
  ])
  if (dotted !== noDate) {
    out.add(dotted)
    out.add(`anthropic/${dotted}`)
  }
  return [...out]
}

function candidateKeys(ref: CatalogRef): string[] {
  const { provider, model } = ref
  const bare = model.replace(/^models\//, "")
  const keys = [
    ref.id,
    bare,
    model,
    `${provider}/${bare}`,
    `${provider}:${bare}`,
  ]
  if (provider === "gemini") {
    keys.unshift(`gemini/${bare}`, `google/${bare}`)
  }
  if (provider === "deepseek") {
    keys.unshift(`deepseek/${bare}`)
  }
  if (provider === "xai") {
    keys.unshift(`xai/${bare}`, `x-ai/${bare}`, `grok/${bare}`)
  }
  if (provider === "openai") {
    keys.unshift(`openai/${bare}`)
  }
  if (provider === "anthropic") {
    keys.unshift(...anthropicAliasKeys(bare))
  }
  return keys
}

function lookupEntry(
  ref: CatalogRef,
  byKey: Map<string, SourceEntry>,
): SourceEntry | null {
  // Só chaves candidatas explícitas — sem endsWith frouxo (evita gpt-4 → gpt-4o).
  for (const key of candidateKeys(ref)) {
    const hit = byKey.get(key)
    if (hit) return hit
  }
  return null
}

function lookupPrice(
  ref: CatalogRef,
  byKey: Map<string, SourceEntry>,
): ResolvedPrice | null {
  return lookupEntry(ref, byKey)?.price ?? null
}

/** Sincroniza preços para modelos descobertos (não sobrescreve pricing_source=admin). */
export async function syncCatalogPricing(
  catalog: CatalogRef[],
): Promise<{ synced: number; skipped: number }> {
  if (catalog.length === 0) return { synced: 0, skipped: 0 }

  const byKey = await catalogSources()
  const ids = catalog.map((c) => c.id)

  const { data: existing } = await supabase
    .from("dexter_model_pricing")
    .select("id, pricing_source")
    .in("id", ids)

  const adminIds = new Set(
    (existing ?? [])
      .filter((r) => r.pricing_source === "admin")
      .map((r) => String(r.id)),
  )

  const now = new Date().toISOString()
  const rows: Array<{
    id: string
    input_usd_per_million: number
    output_usd_per_million: number
    pricing_source: string
    updated_at: string
  }> = []

  let skipped = 0
  for (const ref of catalog) {
    if (adminIds.has(ref.id)) {
      skipped += 1
      continue
    }
    const price = lookupPrice(ref, byKey)
    if (!price) {
      skipped += 1
      continue
    }
    rows.push({
      id: ref.id,
      input_usd_per_million: price.input_usd_per_million,
      output_usd_per_million: price.output_usd_per_million,
      pricing_source: "sync",
      updated_at: now,
    })
  }

  if (rows.length === 0) return { synced: 0, skipped }

  const { error } = await supabase.from("dexter_model_pricing").upsert(rows, {
    onConflict: "id",
  })
  if (error) throw new Error(`syncCatalogPricing: ${error.message}`)

  invalidateModelPricingCache()
  return { synced: rows.length, skipped }
}

export interface EnrichableDiscovered {
  provider: ModelProvider
  model: string
  description: string
  maxOutputTokens: number | null
  inputTokenLimit?: number | null
  releasedAt?: string | null
  capabilities: {
    vision: boolean
    files: boolean
    imageGeneration: boolean
  }
  traits: string[]
  ok: boolean
}

/**
 * Preenche buracos de metadata.
 * Contexto (inputTokenLimit): só API do provider ou LiteLLM max_input_tokens.
 * Nunca sobrescreve o que a API do provider já informou. Sem chute: null fica null.
 */
export async function enrichDiscoveredFromPublicCatalog<
  T extends EnrichableDiscovered,
>(discovered: T[]): Promise<T[]> {
  const byKey = await catalogSources()
  return discovered.map((d) => {
    if (!d.ok || d.model === "_error") return d
    const entry = lookupEntry(
      {
        id: `${d.provider}:${d.model}`,
        provider: d.provider,
        model: d.model,
      },
      byKey,
    )
    if (!entry) return d

    const meta = entry.meta
    const inputTokenLimit =
      d.inputTokenLimit != null && d.inputTokenLimit > 0
        ? d.inputTokenLimit
        : meta.inputTokenLimit
    const maxOutputTokens =
      d.maxOutputTokens != null && d.maxOutputTokens > 0
        ? d.maxOutputTokens
        : meta.maxOutputTokens
    const releasedAt = d.releasedAt ?? meta.releasedAt
    const description =
      d.description?.trim() || meta.description?.trim() || ""

    const capabilities = { ...d.capabilities }
    if (!capabilities.vision && meta.supportsVision === true) {
      capabilities.vision = true
    }
    if (
      !capabilities.imageGeneration &&
      meta.supportsImageGeneration === true
    ) {
      capabilities.imageGeneration = true
    }

    return {
      ...d,
      inputTokenLimit,
      maxOutputTokens,
      releasedAt,
      description,
      capabilities,
    }
  })
}

export function invalidatePricingSyncCache(): void {
  sourceCache = null
}
