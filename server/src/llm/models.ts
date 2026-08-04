/**
 * Catálogo DINÂMICO de modelos — descoberto nas APIs dos providers.
 * Chaves vêm do banco (painel admin) com env como fallback (services/llm-keys).
 * Admin só guarda overrides (hide/default/rótulo).
 * Descrição, tokens e capabilities: API do provider primeiro; buracos
 * preenchidos com LiteLLM/OpenRouter (sem hardcode por modelo).
 */
import { config } from "../config.js"
import { getGlobalKey, type KeyProvider } from "../services/llm-keys.js"
import {
  listModelOverrides,
  type ModelCostTier,
  type ModelOverride,
  type ModelProvider,
} from "../services/model-store.js"
import {
  ensureProvidersDiscovered,
  providerMetaMap,
} from "../services/provider-meta-store.js"
import { ensureModelPricingRows, enrichModelsWithPricing } from "../services/model-pricing.js"
import {
  enrichDiscoveredFromPublicCatalog,
  syncCatalogPricing,
} from "../services/pricing-sync.js"
import {
  capabilityTraits,
  emptyCapabilities,
  isGeminiImageModel,
  isOpenAiCatalogModel,
  isOpenAiImageModel,
  type ModelCapabilities,
} from "./capabilities.js"

export type Provider = ModelProvider

export interface ModelInfo {
  id: string
  label: string
  provider: Provider
  /** id real passado ao provider. */
  model: string
  description: string
  traits: string[]
  capabilities: ModelCapabilities
  /** Max output do provider; null se a API não informar (runtime usa fallback). */
  maxOutputTokens: number | null
  /** Janela de contexto (entrada); null se a API não informar. */
  inputTokenLimit?: number | null
  /** Data de lançamento/criação no provider (ISO), se conhecida. */
  releasedAt?: string | null
  enabled: boolean
  isDefault: boolean
  sortOrder: number
  /** Rótulo do provider (dexter_providers.label). */
  providerLabel: string
  /** USD por 1M tokens (sync automático). */
  inputUsdPerMillion?: number | null
  outputUsdPerMillion?: number | null
}

export interface ProbedModel extends ModelInfo {
  available: boolean
  latencyMs?: number
  error?: string
  credentialOk: boolean
}

/** Só para chamadas LLM quando o provider não publica max_out. Não vai pro admin. */
const DEFAULT_RESPONSE_MAX_TOKENS = 32_000
const FALLBACK_MAX_OUTPUT_TOKENS = 32_000
const DISCOVER_TIMEOUT_MS = 8_000
const CATALOG_CACHE_TTL_MS = 60_000
/** Lotes do /api/show do Ollama — não dispara dezenas de requisições juntas. */
const OLLAMA_SHOW_CONCURRENCY = 5

interface Discovered {
  provider: Provider
  model: string
  label: string
  description: string
  traits: string[]
  capabilities: ModelCapabilities
  maxOutputTokens: number | null
  inputTokenLimit?: number | null
  releasedAt?: string | null
  latencyMs: number
  error?: string
  ok: boolean
}

/** Só aceita limite vindo da API (> 0). Zero/ausente → null (sem chute). */
function tokensFromApi(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

function toIsoFromUnix(sec: unknown): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null
  return new Date(sec * 1000).toISOString()
}

function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Descrição só da API (ou vazia). Sem texto de marketing inventado. */
function apiDescriptionOnly(apiDesc?: string | null): string {
  const api = apiDesc?.trim()
  if (!api) return ""
  return api.length > 400 ? `${api.slice(0, 397)}...` : api
}

function providerErrorRow(
  provider: Provider,
  label: string,
  err: unknown,
  started: number,
): Discovered {
  const message = err instanceof Error ? err.message : String(err)
  return {
    provider,
    model: "_error",
    label,
    description: message,
    traits: [],
    capabilities: emptyCapabilities(),
    maxOutputTokens: null,
    latencyMs: Date.now() - started,
    ok: false,
    error: message,
  }
}

interface CatalogCache {
  at: number
  models: ProbedModel[]
}

let catalogCache: CatalogCache | null = null

/** Chave global efetiva (banco → env); ollama depende só da base URL. */
export async function providerCredentialPresent(p: Provider): Promise<boolean> {
  if (p === "ollama") return Boolean(config.OLLAMA_BASE_URL)
  return Boolean(await getGlobalKey(p as KeyProvider))
}

export function invalidateModelProbeCache(): void {
  catalogCache = null
}

function modelId(provider: Provider, apiModel: string): string {
  return `${provider}:${apiModel}`
}

function humanizeModelId(id: string): string {
  return id
    .replace(/^models\//, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bClaude\b/g, "Claude")
    .replace(/\bGemini\b/g, "Gemini")
}

/** Roda `run` com deadline. O signal VAI para o fetch — sem isso a requisição
 * continuava rodando em background depois do timeout. */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Timeout ${label} (${ms}ms)`))
        })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function capsFromAnthropicApi(
  apiCaps:
    | {
        image_input?: { supported?: boolean }
        pdf_input?: { supported?: boolean }
      }
    | null
    | undefined,
): ModelCapabilities {
  if (!apiCaps) return emptyCapabilities()
  return {
    vision: Boolean(apiCaps.image_input?.supported),
    files: Boolean(apiCaps.pdf_input?.supported),
    imageGeneration: false,
  }
}

/** OpenAI /v1/models não manda caps — só marca geração de imagem pelo id (roteamento). */
function capsFromOpenAiId(id: string): ModelCapabilities {
  if (!isOpenAiImageModel(id)) return emptyCapabilities()
  const lower = id.toLowerCase()
  return {
    vision: /gpt-image|dall-e-2/.test(lower),
    files: false,
    imageGeneration: true,
  }
}

/** Gemini: descrição/métodos da API + id de modelos de imagem. */
function capsFromGeminiApi(
  name: string,
  description: string | undefined,
  methods: string[],
): ModelCapabilities {
  const desc = (description ?? "").toLowerCase()
  const imageGeneration =
    isGeminiImageModel(name) ||
    /image generation|generate images|imagen/.test(desc)
  const vision =
    imageGeneration ||
    /image|vision|multimodal|visual/.test(desc) ||
    methods.some((m) => /image/i.test(m))
  const files =
    !imageGeneration &&
    (/pdf|document|file|file data|document understanding/.test(desc) ||
      vision)
  return { vision, files, imageGeneration }
}

function numFromModelInfo(info: Record<string, unknown> | undefined): number | null {
  if (!info) return null
  for (const [k, v] of Object.entries(info)) {
    if (/context_length$/i.test(k) && typeof v === "number" && v > 0) {
      return Math.floor(v)
    }
  }
  return null
}

function capsFromOllamaShow(capabilities: unknown): ModelCapabilities {
  const list = Array.isArray(capabilities)
    ? capabilities.map((c) => String(c).toLowerCase())
    : []
  return {
    vision: list.includes("vision"),
    files: false,
    imageGeneration: false,
  }
}

/**
 * Listagem ainda devolve ids que o generateContent rejeita.
 * Usa texto da API; fallback: família 2.0 Flash (shutdown Google — id fantasma).
 */
function isGeminiCatalogGhost(name: string, description?: string): boolean {
  const id = name.toLowerCase().replace(/^models\//, "")
  const desc = (description ?? "").toLowerCase()
  if (
    /no longer available|has been shut down|shut down on|deprecated and has been|is deprecated and/.test(
      desc,
    )
  ) {
    return true
  }
  return /^gemini-2\.0-flash/.test(id)
}

async function discoverAnthropic(apiKey: string): Promise<Discovered[]> {
  const started = Date.now()
  try {
    const res = await withTimeout(
      (signal) =>
        fetch("https://api.anthropic.com/v1/models?limit=100", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal,
        }).then(async (r) => {
          if (!r.ok) {
            const body = await r.text().catch(() => "")
            throw new Error(
              `HTTP ${r.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
            )
          }
          return r.json() as Promise<{
            data?: Array<{
              id?: string
              display_name?: string
              created_at?: string
              max_input_tokens?: number | null
              max_tokens?: number | null
              capabilities?: {
                image_input?: { supported?: boolean }
                pdf_input?: { supported?: boolean }
              } | null
            }>
          }>
        }),
      DISCOVER_TIMEOUT_MS,
      "anthropic",
    )
    const latencyMs = Date.now() - started
    const out: Discovered[] = []
    for (const m of res.data ?? []) {
      if (!m.id) continue
      const capabilities = capsFromAnthropicApi(m.capabilities)
      out.push({
        provider: "anthropic",
        model: m.id,
        label: m.display_name?.trim() || humanizeModelId(m.id),
        description: apiDescriptionOnly(null),
        traits: capabilityTraits(capabilities),
        capabilities,
        maxOutputTokens: tokensFromApi(m.max_tokens),
        inputTokenLimit: tokensFromApi(m.max_input_tokens),
        releasedAt: toIsoDate(m.created_at),
        latencyMs,
        ok: true,
      })
    }
    return out
  } catch (err) {
    return [providerErrorRow("anthropic", "Anthropic", err, started)]
  }
}

async function discoverOpenAI(apiKey: string): Promise<Discovered[]> {
  const started = Date.now()
  try {
    const res = await withTimeout(
      (signal) =>
        fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        }).then(async (r) => {
          if (!r.ok) {
            const body = await r.text().catch(() => "")
            throw new Error(
              `HTTP ${r.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
            )
          }
          return r.json() as Promise<{
            data?: Array<{ id?: string; created?: number }>
          }>
        }),
      DISCOVER_TIMEOUT_MS,
      "openai",
    )
    const latencyMs = Date.now() - started
    const rows = (res.data ?? [])
      .filter(
        (m): m is { id: string; created?: number } =>
          typeof m.id === "string" && isOpenAiCatalogModel(m.id),
      )
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))

    return rows.map((row) => {
      const id = row.id
      const capabilities = capsFromOpenAiId(id)
      return {
        provider: "openai" as const,
        model: id,
        label: humanizeModelId(id),
        description: apiDescriptionOnly(null),
        traits: capabilityTraits(capabilities),
        capabilities,
        maxOutputTokens: null,
        inputTokenLimit: null,
        releasedAt: toIsoFromUnix(row.created),
        latencyMs,
        ok: true,
      }
    })
  } catch (err) {
    return [providerErrorRow("openai", "OpenAI", err, started)]
  }
}

async function discoverGemini(apiKey: string): Promise<Discovered[]> {
  const started = Date.now()
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`
    const res = await withTimeout(
      (signal) =>
        fetch(url, { signal }).then(async (r) => {
          if (!r.ok) {
            const body = await r.text().catch(() => "")
            throw new Error(
              `HTTP ${r.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
            )
          }
          return r.json() as Promise<{
            models?: Array<{
              name?: string
              displayName?: string
              description?: string
              supportedGenerationMethods?: string[]
              inputTokenLimit?: number
              outputTokenLimit?: number
            }>
          }>
        }),
      DISCOVER_TIMEOUT_MS,
      "gemini",
    )
    const latencyMs = Date.now() - started
    const out: Discovered[] = []
    for (const m of res.models ?? []) {
      const methods = m.supportedGenerationMethods ?? []
      if (!methods.includes("generateContent")) continue
      const name = (m.name ?? "").replace(/^models\//, "")
      if (!name || !/gemini/i.test(name)) continue
      if (/embedding|tts|aqa/i.test(name)) continue
      if (/image/i.test(name) && !/imagen|gemini/i.test(name)) continue
      if (isGeminiCatalogGhost(name, m.description)) continue
      const capabilities = capsFromGeminiApi(name, m.description, methods)
      out.push({
        provider: "gemini",
        model: name,
        label: m.displayName?.trim() || humanizeModelId(name),
        description: apiDescriptionOnly(m.description),
        traits: capabilityTraits(capabilities),
        capabilities,
        maxOutputTokens: tokensFromApi(m.outputTokenLimit),
        inputTokenLimit: tokensFromApi(m.inputTokenLimit),
        releasedAt: null,
        latencyMs,
        ok: true,
      })
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  } catch (err) {
    return [providerErrorRow("gemini", "Gemini", err, started)]
  }
}

/** DeepSeek e xAI: GET /models no formato OpenAI (id + created). */
async function discoverOpenAiStyle(
  provider: "deepseek" | "xai",
  label: string,
  url: string,
  apiKey: string,
): Promise<Discovered[]> {
  const started = Date.now()
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        }).then(async (r) => {
          if (!r.ok) {
            const body = await r.text().catch(() => "")
            throw new Error(
              `HTTP ${r.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
            )
          }
          return r.json() as Promise<{
            data?: Array<{ id?: string; created?: number }>
          }>
        }),
      DISCOVER_TIMEOUT_MS,
      provider,
    )
    const latencyMs = Date.now() - started
    return (res.data ?? [])
      .filter((m): m is { id: string; created?: number } =>
        typeof m.id === "string" && m.id.length > 0,
      )
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((row) => {
        // Grok: modelos *-vision e grok-4+ analisam imagem (a API não informa
        // caps — marcação mínima pelo id, sem inventar o resto).
        const vision =
          provider === "xai" && /vision|grok-[4-9]/i.test(row.id)
        const capabilities = { vision, files: false, imageGeneration: false }
        return {
          provider: provider as Provider,
          model: row.id,
          label: humanizeModelId(row.id),
          description: apiDescriptionOnly(null),
          traits: capabilityTraits(capabilities),
          capabilities,
          maxOutputTokens: null,
          inputTokenLimit: null,
          releasedAt: toIsoFromUnix(row.created),
          latencyMs,
          ok: true,
        }
      })
  } catch (err) {
    return [providerErrorRow(provider, label, err, started)]
  }
}

async function ollamaShow(
  base: string,
  headers: Record<string, string>,
  name: string,
): Promise<{
  context: number | null
  capabilities: ModelCapabilities
  detailsText: string
}> {
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(`${base}/api/show`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
          signal,
        }).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json() as Promise<{
            model_info?: Record<string, unknown>
            details?: { parameter_size?: string; family?: string }
            capabilities?: string[]
          }>
        }),
      5_000,
      `ollama-show:${name}`,
    )
    const detailsText = [
      res.details?.parameter_size,
      res.details?.family,
    ]
      .filter(Boolean)
      .join(" · ")
    return {
      context: numFromModelInfo(res.model_info),
      capabilities: capsFromOllamaShow(res.capabilities),
      detailsText,
    }
  } catch {
    return {
      context: null,
      capabilities: emptyCapabilities(),
      detailsText: "",
    }
  }
}

async function discoverOllama(): Promise<Discovered[]> {
  const started = Date.now()
  if (!config.OLLAMA_BASE_URL) return []
  try {
    const base = config.OLLAMA_BASE_URL.replace(/\/$/, "")
    const headers: Record<string, string> = {}
    if (process.env.OLLAMA_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`
    }
    const res = await withTimeout(
      (signal) =>
        fetch(`${base}/api/tags`, { headers, signal }).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json() as Promise<{
            models?: Array<{
              name?: string
              model?: string
              modified_at?: string
              details?: { parameter_size?: string; family?: string }
            }>
          }>
        }),
      DISCOVER_TIMEOUT_MS,
      "ollama",
    )
    const latencyMs = Date.now() - started
    const names = new Map<
      string,
      { modified_at?: string; parameter_size?: string; family?: string }
    >()
    for (const m of res.models ?? []) {
      const n = m.name || m.model
      if (!n) continue
      names.set(n, {
        modified_at: m.modified_at,
        parameter_size: m.details?.parameter_size,
        family: m.details?.family,
      })
    }

    const entries = [...names.entries()].sort((a, b) => {
      const ta = Date.parse(a[1].modified_at ?? "") || 0
      const tb = Date.parse(b[1].modified_at ?? "") || 0
      return tb - ta
    })

    // /api/show em lotes: com dezenas de modelos, um Promise.all sem limite
    // satura o servidor de inferência.
    const shown: Discovered[] = []
    for (let i = 0; i < entries.length; i += OLLAMA_SHOW_CONCURRENCY) {
      const lote = entries.slice(i, i + OLLAMA_SHOW_CONCURRENCY)
      const parte = await Promise.all(
        lote.map(async ([name, meta]) => {
          const show = await ollamaShow(base, headers, name)
          const detailsText =
            show.detailsText ||
            [meta.parameter_size, meta.family].filter(Boolean).join(" · ")
          const ctx = show.context
          return {
            provider: "ollama" as const,
            model: name,
            label: name,
            description: apiDescriptionOnly(detailsText || null),
            traits: capabilityTraits(show.capabilities),
            capabilities: show.capabilities,
            maxOutputTokens: ctx,
            inputTokenLimit: ctx,
            releasedAt: toIsoDate(meta.modified_at),
            latencyMs,
            ok: true as const,
          }
        }),
      )
      shown.push(...parte)
    }
    return shown
  } catch (err) {
    return [providerErrorRow("ollama", "Ollama", err, started)]
  }
}

function applyOverrides(
  discovered: Discovered[],
  overrides: ModelOverride[],
  providers: Map<string, { label: string; default_cost_tier: ModelCostTier | null }>,
): ProbedModel[] {
  const byId = new Map(overrides.map((o) => [o.id, o]))
  const models: ProbedModel[] = []
  for (const d of discovered) {
    if (!d.ok || d.model === "_error") continue
    const id = modelId(d.provider, d.model)
    const ov = byId.get(id)
    const ovLegacy = byId.get(d.model)
    const override = ov ?? ovLegacy
    const enabled = override?.enabled ?? true
    const prov = providers.get(d.provider)
    models.push({
      id,
      label: override?.label?.trim() || d.label,
      provider: d.provider,
      model: d.model,
      description: override?.description?.trim() || d.description,
      traits: d.traits,
      capabilities: d.capabilities,
      maxOutputTokens: d.maxOutputTokens,
      inputTokenLimit: d.inputTokenLimit ?? null,
      releasedAt: d.releasedAt ?? null,
      enabled,
      isDefault: Boolean(override?.is_default),
      sortOrder: override?.sort_order ?? 1000,
      providerLabel: prov?.label ?? d.provider,
      available: enabled,
      latencyMs: d.latencyMs,
      credentialOk: true,
    })
  }

  models.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.label.localeCompare(b.label)
  })
  return models
}

/** Discovery em voo — N requisições com cache frio compartilham a MESMA
 * descoberta em vez de multiplicar as chamadas às APIs dos providers. */
let inflightCatalog: Promise<ProbedModel[]> | null = null

async function buildCatalog(force = false): Promise<ProbedModel[]> {
  if (
    !force &&
    catalogCache &&
    Date.now() - catalogCache.at < CATALOG_CACHE_TTL_MS
  ) {
    return catalogCache.models
  }
  if (!force && inflightCatalog) return inflightCatalog

  const run = discoverCatalog().finally(() => {
    if (inflightCatalog === run) inflightCatalog = null
  })
  inflightCatalog = run
  return run
}

async function discoverCatalog(): Promise<ProbedModel[]> {
  const [anthropicKey, openaiKey, geminiKey, deepseekKey, xaiKey] =
    await Promise.all([
      getGlobalKey("anthropic"),
      getGlobalKey("openai"),
      getGlobalKey("gemini"),
      getGlobalKey("deepseek"),
      getGlobalKey("xai"),
    ])
  const nada = Promise.resolve([] as Discovered[])
  const [anthropic, openai, gemini, deepseek, xai, ollama] =
    await Promise.all([
      anthropicKey ? discoverAnthropic(anthropicKey) : nada,
      openaiKey ? discoverOpenAI(openaiKey) : nada,
      geminiKey ? discoverGemini(geminiKey) : nada,
      deepseekKey
        ? discoverOpenAiStyle(
            "deepseek",
            "DeepSeek",
            "https://api.deepseek.com/models",
            deepseekKey,
          )
        : nada,
      xaiKey
        ? discoverOpenAiStyle(
            "xai",
            "Grok (xAI)",
            "https://api.x.ai/v1/models",
            xaiKey,
          )
        : nada,
      config.OLLAMA_BASE_URL ? discoverOllama() : nada,
    ])

  const discovered = [
    ...anthropic,
    ...openai,
    ...gemini,
    ...deepseek,
    ...xai,
    ...ollama,
  ]
  await ensureProvidersDiscovered(
    discovered.filter((d) => d.ok && d.model !== "_error").map((d) => d.provider),
  )
  const catalogRefs = discovered
    .filter((d) => d.ok && d.model !== "_error")
    .map((d) => ({
      id: `${d.provider}:${d.model}`,
      provider: d.provider,
      model: d.model,
    }))
  await ensureModelPricingRows(catalogRefs.map((c) => c.id)).catch(() => {})
  // LiteLLM/OpenRouter: contexto, max out, data e descrição onde a API falha.
  const enriched = (
    await enrichDiscoveredFromPublicCatalog(discovered).catch(() => discovered)
  ).map((d) =>
    d.ok && d.model !== "_error"
      ? { ...d, traits: capabilityTraits(d.capabilities) }
      : d,
  )
  // Preços em background — não bloqueia o catálogo se o feed estiver lento.
  void syncCatalogPricing(catalogRefs).catch(() => {})
  const [overrides, providers] = await Promise.all([
    listModelOverrides().catch(() => [] as ModelOverride[]),
    providerMetaMap(),
  ])
  const providerDefaults = new Map(
    [...providers.entries()].map(([id, p]) => [
      id,
      { label: p.label, default_cost_tier: p.default_cost_tier },
    ]),
  )
  const models = applyOverrides(enriched, overrides, providerDefaults)
  const priced = await enrichModelsWithPricing(models).catch(() =>
    models.map((m) => ({
      ...m,
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
    })),
  )
  catalogCache = { at: Date.now(), models: priced }
  return priced
}

export async function loadCatalog(force = false): Promise<ModelInfo[]> {
  return buildCatalog(force)
}

export async function enabledModels(force = false): Promise<ModelInfo[]> {
  const all = await buildCatalog(force)
  return all.filter((m) => m.enabled)
}

export function responseMaxTokens(model: string): number {
  const fromCache = catalogCache?.models.find(
    (m) => m.model === model || m.id === model,
  )
  const cap = fromCache?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS
  return Math.min(cap, DEFAULT_RESPONSE_MAX_TOKENS)
}

export async function responseMaxTokensFor(
  modelIdOrApi: string,
): Promise<number> {
  const all = await buildCatalog()
  const info = all.find(
    (m) => m.id === modelIdOrApi || m.model === modelIdOrApi,
  )
  const cap = info?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS
  return Math.min(cap, DEFAULT_RESPONSE_MAX_TOKENS)
}

export async function defaultModelId(): Promise<string> {
  const enabled = await enabledModels()
  const def = enabled.find((m) => m.isDefault)
  if (def) return def.id
  return enabled[0]?.id ?? ""
}

export async function resolveModel(id?: string): Promise<ModelInfo> {
  const enabled = await enabledModels()
  if (id) {
    const found =
      enabled.find((m) => m.id === id) ??
      enabled.find((m) => m.model === id) ??
      enabled.find((m) => m.id.endsWith(`:${id}`))
    if (found) return found
  }
  const defId = await defaultModelId()
  const def = enabled.find((m) => m.id === defId)
  if (def) return def
  if (enabled[0]) return enabled[0]
  throw new Error(
    "Nenhum modelo disponível. Cadastre as chaves dos provedores no painel admin (aba Modelos) ou verifique o servidor Ollama.",
  )
}

export async function probeModels(force = false): Promise<ProbedModel[]> {
  const all = await buildCatalog(force)
  return all.filter((m) => m.enabled).map((m) => ({ ...m, available: true }))
}

export async function listModelsWithCredentialFlag(): Promise<ProbedModel[]> {
  return probeModels(false)
}

export async function listAllDiscoveredModels(
  force = false,
): Promise<ProbedModel[]> {
  return buildCatalog(force)
}

export async function providerStatus(): Promise<
  Record<Provider, { credential: boolean }>
> {
  const [anthropic, openai, gemini, deepseek, xai] = await Promise.all([
    providerCredentialPresent("anthropic"),
    providerCredentialPresent("openai"),
    providerCredentialPresent("gemini"),
    providerCredentialPresent("deepseek"),
    providerCredentialPresent("xai"),
  ])
  return {
    anthropic: { credential: anthropic },
    openai: { credential: openai },
    gemini: { credential: gemini },
    deepseek: { credential: deepseek },
    xai: { credential: xai },
    ollama: { credential: Boolean(config.OLLAMA_BASE_URL) },
  }
}
