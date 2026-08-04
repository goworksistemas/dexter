/**
 * Preferências admin sobre modelos descobertos dinamicamente.
 * O catálogo NÃO mora aqui — vem das APIs dos providers.
 */
import { supabase } from "../lib/supabase.js"
import { NotFoundError } from "./errors.js"

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "xai"
  | "ollama"

export type ModelCostTier = "free" | "cheap" | "standard" | "premium"

export interface ModelOverride {
  id: string
  enabled: boolean
  is_default: boolean
  label: string | null
  description: string | null
  sort_order: number | null
  cost_tier: ModelCostTier | null
  created_at: string
  updated_at: string
}

export interface ModelOverridePatch {
  enabled?: boolean
  is_default?: boolean
  label?: string | null
  description?: string | null
  sort_order?: number | null
  cost_tier?: ModelCostTier | null
}

const CACHE_TTL_MS = 10_000
let cache: { at: number; rows: ModelOverride[] } | null = null

export function invalidateOverrideCache(): void {
  cache = null
}

function normalize(raw: Record<string, unknown>): ModelOverride {
  return {
    id: String(raw.id),
    enabled: raw.enabled !== false,
    is_default: Boolean(raw.is_default),
    label: raw.label != null ? String(raw.label) : null,
    description: raw.description != null ? String(raw.description) : null,
    sort_order:
      raw.sort_order != null && raw.sort_order !== ""
        ? Number(raw.sort_order)
        : null,
    cost_tier:
      raw.cost_tier === "free" ||
      raw.cost_tier === "cheap" ||
      raw.cost_tier === "standard" ||
      raw.cost_tier === "premium"
        ? raw.cost_tier
        : null,
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  }
}

export async function listModelOverrides(opts?: {
  force?: boolean
}): Promise<ModelOverride[]> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.rows
  }
  const { data, error } = await supabase
    .from("dexter_model_overrides")
    .select("*")
  if (error) throw new Error(`listModelOverrides: ${error.message}`)
  const rows = (data ?? []).map((r) =>
    normalize(r as Record<string, unknown>),
  )
  cache = { at: Date.now(), rows }
  return rows
}

/** Bulk enable/disable sem apagar outros campos do override. */
export async function bulkUpsertModelOverrides(
  ids: string[],
  patch: Pick<ModelOverridePatch, "enabled">,
): Promise<number> {
  if (ids.length === 0) return 0
  if (patch.enabled === undefined) {
    throw new Error("bulkUpsertModelOverrides exige enabled.")
  }
  const now = new Date().toISOString()
  const existing = await listModelOverrides({ force: true })
  const known = new Set(existing.map((e) => e.id))
  const toUpdate = ids.filter((id) => known.has(id))
  const toInsert = ids.filter((id) => !known.has(id))

  if (toUpdate.length > 0) {
    const { error } = await supabase
      .from("dexter_model_overrides")
      .update({ enabled: patch.enabled, updated_at: now })
      .in("id", toUpdate)
    if (error) throw new Error(`bulk update: ${error.message}`)
  }
  if (toInsert.length > 0) {
    const { error } = await supabase.from("dexter_model_overrides").insert(
      toInsert.map((id) => ({
        id,
        enabled: patch.enabled,
        is_default: false,
        updated_at: now,
      })),
    )
    if (error) throw new Error(`bulk insert: ${error.message}`)
  }
  invalidateOverrideCache()
  return ids.length
}

export async function upsertModelOverride(
  id: string,
  patch: ModelOverridePatch,
): Promise<ModelOverride> {
  if (patch.is_default === true) {
    const { error: clearErr } = await supabase
      .from("dexter_model_overrides")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .neq("id", id)
    if (clearErr) {
      throw new Error(`clear default falhou: ${clearErr.message}`)
    }
  }

  const existing = (await listModelOverrides({ force: true })).find(
    (r) => r.id === id,
  )
  const next = {
    id,
    enabled: patch.enabled ?? existing?.enabled ?? true,
    is_default: patch.is_default ?? existing?.is_default ?? false,
    label:
      patch.label !== undefined ? patch.label : (existing?.label ?? null),
    description:
      patch.description !== undefined
        ? patch.description
        : (existing?.description ?? null),
    sort_order:
      patch.sort_order !== undefined
        ? patch.sort_order
        : (existing?.sort_order ?? null),
    cost_tier:
      patch.cost_tier !== undefined
        ? patch.cost_tier
        : (existing?.cost_tier ?? null),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from("dexter_model_overrides")
    .upsert(next, { onConflict: "id" })
    .select("*")
    .maybeSingle()

  if (error) throw new Error(`upsertModelOverride: ${error.message}`)
  if (!data) throw new NotFoundError("Override não encontrado.")
  invalidateOverrideCache()
  return normalize(data as Record<string, unknown>)
}
