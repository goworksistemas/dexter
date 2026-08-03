/**
 * Registry de modelos do AgentCore — o que alimenta o seletor da interface
 * (GET /api/models) e o roteamento por requisição.
 *
 * Sem probe: "disponível" = credencial do provider presente.
 * Com probe (?probe=1): ping real no provider (cache ~30s).
 */
import { config } from "../config.js"

export type Provider = "anthropic" | "ollama"

export interface ModelInfo {
  /** id estável usado no seletor e em context.model. */
  id: string
  label: string
  provider: Provider
  /** id real passado ao provider (pode diferir do id do seletor). */
  model: string
  /**
   * Teto de saída do modelo na API síncrona (Messages API). Em Opus/Sonnet 5 o
   * `max_tokens` cobre thinking + texto, então pedir pouco corta a resposta no
   * meio (era o bug do artefato truncado).
   */
  maxOutputTokens: number
}

export interface ProbedModel extends ModelInfo {
  available: boolean
  latencyMs?: number
  error?: string
}

const REGISTRY: ModelInfo[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", model: "claude-sonnet-5", maxOutputTokens: 128_000 },
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic", model: "claude-opus-5", maxOutputTokens: 128_000 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", model: "claude-haiku-4-5-20251001", maxOutputTokens: 64_000 },
  { id: config.OLLAMA_MODEL, label: `${config.OLLAMA_MODEL} (self-hosted)`, provider: "ollama", model: config.OLLAMA_MODEL, maxOutputTokens: config.OLLAMA_NUM_CTX },
]

/**
 * Teto pedido por requisição. Bem acima do que uma resposta de chat precisa
 * (uma landing page HTML completa fica na casa dos 10–15k tokens) e longe do
 * limite do modelo, para não deixar uma única geração correr por minutos.
 * Se ainda assim o modelo bater no teto, o agent-loop emenda a continuação.
 */
const DEFAULT_RESPONSE_MAX_TOKENS = 32_000

/** Fallback quando o id não está no registry (ex.: modelo vindo do ambiente). */
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192

/** `max_tokens` a pedir para este modelo, já limitado pelo teto do provider. */
export function responseMaxTokens(model: string): number {
  const info = REGISTRY.find((m) => m.model === model || m.id === model)
  const cap = info?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS
  return Math.min(cap, DEFAULT_RESPONSE_MAX_TOKENS)
}

const PROBE_TIMEOUT_MS = 2500
const PROBE_CACHE_TTL_MS = 30_000

interface ProbeCacheEntry {
  at: number
  models: ProbedModel[]
}

let probeCache: ProbeCacheEntry | null = null

function providerCredentialPresent(p: Provider): boolean {
  if (p === "anthropic") return Boolean(config.ANTHROPIC_API_KEY)
  return Boolean(config.OLLAMA_BASE_URL)
}

/** Modelos que o seletor pode oferecer (filtrados por credencial presente). */
export function availableModels(): ModelInfo[] {
  return REGISTRY.filter((m) => providerCredentialPresent(m.provider))
}

/** Id do modelo default — deriva do LLM_PROVIDER/ANTHROPIC_MODEL configurados. */
export function defaultModelId(): string {
  const avail = availableModels()
  const preferred =
    config.LLM_PROVIDER === "ollama" ? config.OLLAMA_MODEL : config.ANTHROPIC_MODEL
  const found = avail.find((m) => m.id === preferred || m.model === preferred)
  return found?.id ?? avail[0]?.id ?? config.ANTHROPIC_MODEL
}

/** Resolve o modelo a usar numa requisição a partir do id vindo da UI. */
export function resolveModel(id?: string): ModelInfo {
  const avail = availableModels()
  if (id) {
    const found = avail.find((m) => m.id === id)
    if (found) return found
  }
  const def = avail.find((m) => m.id === defaultModelId())
  return (
    def ??
    avail[0] ?? {
      id: config.ANTHROPIC_MODEL,
      label: config.ANTHROPIC_MODEL,
      provider: "anthropic",
      model: config.ANTHROPIC_MODEL,
      maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
    }
  )
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    // Preferir abort se a promise aceitar signal via wrapper abaixo.
    void controller
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Timeout ao probe ${label} (${ms}ms)`))
        })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function probeAnthropic(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  if (!config.ANTHROPIC_API_KEY) {
    return { ok: false, latencyMs: 0, error: "ANTHROPIC_API_KEY ausente" }
  }
  try {
    const res = await withTimeout(
      fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: {
          "x-api-key": config.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "")
          throw new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 120)}` : ""}`)
        }
        return r
      }),
      PROBE_TIMEOUT_MS,
      "anthropic",
    )
    void res
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function probeOllamaTags(): Promise<{
  ok: boolean
  latencyMs: number
  names: Set<string>
  error?: string
}> {
  const started = Date.now()
  if (!config.OLLAMA_BASE_URL) {
    return { ok: false, latencyMs: 0, names: new Set(), error: "OLLAMA_BASE_URL ausente" }
  }
  try {
    const base = config.OLLAMA_BASE_URL.replace(/\/$/, "")
    const res = await withTimeout(
      fetch(`${base}/api/tags`).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{ models?: Array<{ name?: string; model?: string }> }>
      }),
      PROBE_TIMEOUT_MS,
      "ollama",
    )
    const names = new Set<string>()
    for (const m of res.models ?? []) {
      if (m.name) names.add(m.name)
      if (m.model) names.add(m.model)
      // tags às vezes vêm sem :latest — aceitar ambos
      if (m.name?.includes(":")) names.add(m.name.split(":")[0]!)
      if (m.model?.includes(":")) names.add(m.model.split(":")[0]!)
    }
    return { ok: true, latencyMs: Date.now() - started, names }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      names: new Set(),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function ollamaModelPresent(names: Set<string>, model: string): boolean {
  if (names.has(model)) return true
  const base = model.includes(":") ? model.split(":")[0]! : model
  if (names.has(base) || names.has(`${base}:latest`)) return true
  return false
}

/** Lista modelos com probe real (cache em memória ~30s). */
export async function probeModels(force = false): Promise<ProbedModel[]> {
  if (
    !force &&
    probeCache &&
    Date.now() - probeCache.at < PROBE_CACHE_TTL_MS
  ) {
    return probeCache.models
  }

  const candidates = availableModels()
  const needsAnthropic = candidates.some((m) => m.provider === "anthropic")
  const needsOllama = candidates.some((m) => m.provider === "ollama")

  const [anthropic, ollama] = await Promise.all([
    needsAnthropic ? probeAnthropic() : Promise.resolve({ ok: false, latencyMs: 0, error: "skip" as string | undefined }),
    needsOllama
      ? probeOllamaTags()
      : Promise.resolve({
          ok: false,
          latencyMs: 0,
          names: new Set<string>(),
          error: "skip" as string | undefined,
        }),
  ])

  const models: ProbedModel[] = candidates.map((m) => {
    if (m.provider === "anthropic") {
      return {
        ...m,
        available: anthropic.ok,
        latencyMs: anthropic.latencyMs,
        error: anthropic.ok ? undefined : anthropic.error,
      }
    }
    if (!ollama.ok) {
      return {
        ...m,
        available: false,
        latencyMs: ollama.latencyMs,
        error: ollama.error,
      }
    }
    const present = ollamaModelPresent(ollama.names, m.model)
    return {
      ...m,
      available: present,
      latencyMs: ollama.latencyMs,
      error: present ? undefined : `Modelo "${m.model}" não encontrado em /api/tags`,
    }
  })

  probeCache = { at: Date.now(), models }
  return models
}

/** Modelos sem probe — available baseado só em credencial. */
export function listModelsWithCredentialFlag(): ProbedModel[] {
  return REGISTRY.map((m) => ({
    ...m,
    available: providerCredentialPresent(m.provider),
  }))
}
