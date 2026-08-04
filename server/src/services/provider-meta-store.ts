/**
 * Metadados de providers (rótulo, custo padrão) — sincronizados na discovery.
 */
import { supabase } from "../lib/supabase.js"
import type { ModelCostTier } from "./model-store.js"

export type ProviderCreditStatus =
  | "available"
  | "low"
  | "depleted"
  | "unknown"

export interface ProviderMeta {
  id: string
  label: string
  default_cost_tier: ModelCostTier | null
  credit_status: ProviderCreditStatus
  balance_usd: number | null
  low_threshold_usd: number | null
  balance_updated_at: string | null
  updated_at: string
}

export interface ProviderMetaPatch {
  label?: string
  default_cost_tier?: ModelCostTier | null
  credit_status?: ProviderCreditStatus
  balance_usd?: number | null
  low_threshold_usd?: number | null
}

const CACHE_TTL_MS = 10_000
let cache: { at: number; rows: ProviderMeta[] } | null = null

export function invalidateProviderMetaCache(): void {
  cache = null
}

function normalizeCreditStatus(raw: unknown): ProviderCreditStatus {
  if (
    raw === "available" ||
    raw === "low" ||
    raw === "depleted" ||
    raw === "unknown"
  ) {
    return raw
  }
  return "unknown"
}

function normalize(raw: Record<string, unknown>): ProviderMeta {
  const tier = raw.default_cost_tier
  return {
    id: String(raw.id),
    label: String(raw.label ?? raw.id),
    default_cost_tier:
      tier === "free" ||
      tier === "cheap" ||
      tier === "standard" ||
      tier === "premium"
        ? tier
        : null,
    credit_status: normalizeCreditStatus(raw.credit_status),
    balance_usd:
      raw.balance_usd != null ? Number(raw.balance_usd) : null,
    low_threshold_usd:
      raw.low_threshold_usd != null
        ? Number(raw.low_threshold_usd)
        : null,
    balance_updated_at:
      raw.balance_updated_at != null
        ? String(raw.balance_updated_at)
        : null,
    updated_at: String(raw.updated_at ?? ""),
  }
}

export async function listProviderMeta(opts?: {
  force?: boolean
}): Promise<ProviderMeta[]> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.rows
  }
  const { data, error } = await supabase.from("dexter_providers").select("*")
  if (error) throw new Error(`listProviderMeta: ${error.message}`)
  const rows = (data ?? []).map((r) =>
    normalize(r as Record<string, unknown>),
  )
  cache = { at: Date.now(), rows }
  return rows
}

export async function providerMetaMap(): Promise<Map<string, ProviderMeta>> {
  const rows = await listProviderMeta()
  return new Map(rows.map((r) => [r.id, r]))
}

/** Garante linha para cada provider visto na discovery (label = id até admin renomear). */
export async function ensureProvidersDiscovered(ids: Iterable<string>): Promise<void> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return

  const existing = await providerMetaMap()
  const toInsert = unique.filter((id) => !existing.has(id))
  if (toInsert.length === 0) return

  const now = new Date().toISOString()
  const { error } = await supabase.from("dexter_providers").insert(
    toInsert.map((id) => ({
      id,
      label: id,
      default_cost_tier: null,
      updated_at: now,
    })),
  )
  if (error) throw new Error(`ensureProvidersDiscovered: ${error.message}`)
  invalidateProviderMetaCache()
}

export async function patchProviderMeta(
  id: string,
  patch: ProviderMetaPatch,
): Promise<ProviderMeta> {
  const existing = (await listProviderMeta({ force: true })).find(
    (r) => r.id === id,
  )
  const now = new Date().toISOString()
  const next: Record<string, unknown> = {
    id,
    label: patch.label?.trim() || existing?.label || id,
    default_cost_tier:
      patch.default_cost_tier !== undefined
        ? patch.default_cost_tier
        : (existing?.default_cost_tier ?? null),
    updated_at: now,
  }
  if (patch.credit_status !== undefined) {
    next.credit_status = patch.credit_status
    next.balance_updated_at = now
  }
  if (patch.balance_usd !== undefined) {
    next.balance_usd = patch.balance_usd
    next.balance_updated_at = now
  }
  if (patch.low_threshold_usd !== undefined) {
    next.low_threshold_usd = patch.low_threshold_usd
  }

  const { data, error } = await supabase
    .from("dexter_providers")
    .upsert(next, { onConflict: "id" })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`patchProviderMeta: ${error?.message ?? "sem retorno"}`)
  }
  invalidateProviderMetaCache()
  return normalize(data as Record<string, unknown>)
}
