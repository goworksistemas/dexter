/**
 * Modelos permitidos por usuário (profiles.allowed_models).
 *
 * NULL = todos os modelos habilitados; array = só aqueles ids
 * (provider:modelo). Admin/master nunca são restringidos — a regra só vale
 * para role "user". Cache curto: mudança feita pelo admin pega em ~30s.
 */
import type { ModelInfo, ProbedModel } from "../llm/models.js"
import { defaultModelId, enabledModels, probeModels } from "../llm/models.js"
import { supabase } from "../lib/supabase.js"
import { isStaffRole, type DexterRole } from "./admin-store.js"
import { ForbiddenError } from "./errors.js"

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; allowed: string[] | null }>()

export function invalidateModelAccessCache(userId?: string): void {
  if (userId) cache.delete(userId)
  else cache.clear()
}

/** Lista crua do perfil (null = sem restrição). */
export async function getAllowedModelIds(
  userId: string,
): Promise<string[] | null> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.allowed

  const { data, error } = await supabase
    .from("profiles")
    .select("allowed_models")
    .eq("id", userId)
    .maybeSingle()
  // Falha de leitura não pode bloquear o chat inteiro: assume sem restrição.
  const allowed = error
    ? null
    : ((data?.allowed_models as string[] | null) ?? null)
  cache.set(userId, { at: Date.now(), allowed })
  if (cache.size > 1000) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  return allowed
}

interface UserRef {
  userId: string
  role?: DexterRole
}

/** Modelos habilitados que ESTE usuário pode usar. */
export async function enabledModelsForUser(
  user: UserRef,
): Promise<ProbedModel[]> {
  const all = await probeModels(false)
  if (user.role && isStaffRole(user.role)) return all
  const allowed = await getAllowedModelIds(user.userId)
  if (allowed === null) return all
  const set = new Set(allowed)
  return all.filter((m) => set.has(m.id))
}

/** Default para o usuário: o default global se permitido, senão o primeiro. */
export async function defaultModelIdForUser(user: UserRef): Promise<string> {
  const models = await enabledModelsForUser(user)
  const globalDefault = await defaultModelId()
  if (models.some((m) => m.id === globalDefault)) return globalDefault
  return models[0]?.id ?? ""
}

/**
 * Resolve o modelo do request respeitando a permissão do usuário.
 * Modelo pedido fora da lista → 403 com mensagem clara (não troca em
 * silêncio). Sem id → default permitido.
 */
export async function resolveModelForUser(
  id: string | undefined,
  user: UserRef,
): Promise<ModelInfo> {
  const models = await enabledModelsForUser(user)
  if (models.length === 0) {
    throw new ForbiddenError(
      "Nenhum modelo liberado para o seu usuário. Fale com um administrador.",
    )
  }
  if (id) {
    const found =
      models.find((m) => m.id === id) ??
      models.find((m) => m.model === id) ??
      models.find((m) => m.id.endsWith(`:${id}`))
    if (found) return found
    // Existe no catálogo mas não para este usuário?
    const all = await enabledModels()
    const existe = all.some(
      (m) => m.id === id || m.model === id || m.id.endsWith(`:${id}`),
    )
    if (existe) {
      throw new ForbiddenError(
        "Este modelo não está liberado para o seu usuário. Escolha outro no seletor.",
      )
    }
  }
  const defId = await defaultModelIdForUser(user)
  return models.find((m) => m.id === defId) ?? models[0]!
}
