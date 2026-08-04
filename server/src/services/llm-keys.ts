/**
 * Chaves de API dos provedores LLM — fonte de verdade no banco, env como
 * fallback de compatibilidade.
 *
 * Resolução efetiva por request (getEffectiveKey):
 *   1. Chave PESSOAL do usuário (BYOK, agent_user_api_keys)
 *   2. Chave GLOBAL do admin (dexter_provider_keys)
 *   3. Variável de ambiente (ANTHROPIC_API_KEY etc. — legado Infisical)
 *
 * Tudo cifrado com AES-256-GCM usando USER_API_KEYS_SECRET (único segredo que
 * permanece no ambiente). Sem o segredo, a gestão de chaves via UI fica
 * desabilitada e só o env funciona. O claro nunca sai do processo: a UI só
 * recebe last4.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

import { config } from "../config.js"
import { supabase } from "../lib/supabase.js"

export const KEY_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "xai",
] as const
export type KeyProvider = (typeof KEY_PROVIDERS)[number]

export function isKeyProvider(v: string): v is KeyProvider {
  return (KEY_PROVIDERS as readonly string[]).includes(v)
}

/** Gestão de chaves via UI disponível? (segredo de criptografia presente) */
export function keyManagementEnabled(): boolean {
  return Boolean(config.USER_API_KEYS_SECRET)
}

// --- Criptografia -----------------------------------------------------------

const IV_BYTES = 12
const TAG_BYTES = 16

function cipherKey(): Buffer {
  const secret = config.USER_API_KEYS_SECRET
  if (!secret) {
    throw new Error(
      "USER_API_KEYS_SECRET ausente — gestão de chaves de API desabilitada.",
    )
  }
  return createHash("sha256").update(secret).digest()
}

/** base64(iv || authTag || ciphertext) */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")
}

export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, "base64")
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const data = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

function last4Of(key: string): string {
  return key.slice(-4)
}

// --- Chaves globais (admin) -------------------------------------------------

export interface ProviderKeyMeta {
  provider: KeyProvider
  last4: string
  updated_at: string
}

interface GlobalKeysCache {
  at: number
  /** provider → claro (decifrado) */
  keys: Map<KeyProvider, string>
  meta: ProviderKeyMeta[]
}

const GLOBAL_CACHE_TTL_MS = 30_000
let globalCache: GlobalKeysCache | null = null

export function invalidateLlmKeyCache(): void {
  globalCache = null
  userKeyCache.clear()
}

async function loadGlobalKeys(): Promise<GlobalKeysCache> {
  if (globalCache && Date.now() - globalCache.at < GLOBAL_CACHE_TTL_MS) {
    return globalCache
  }
  const keys = new Map<KeyProvider, string>()
  const meta: ProviderKeyMeta[] = []
  if (keyManagementEnabled()) {
    const { data, error } = await supabase
      .from("dexter_provider_keys")
      .select("provider, ciphertext, last4, updated_at")
    if (error) {
      throw new Error(`Falha ao carregar chaves de provedores: ${error.message}`)
    }
    for (const row of data ?? []) {
      const provider = String(row.provider)
      if (!isKeyProvider(provider)) continue
      try {
        keys.set(provider, decryptSecret(String(row.ciphertext)))
        meta.push({
          provider,
          last4: String(row.last4),
          updated_at: String(row.updated_at),
        })
      } catch {
        // Segredo trocado → ciphertext antigo indecifrável. Ignora a linha:
        // o admin recadastra a chave pela UI.
      }
    }
  }
  globalCache = { at: Date.now(), keys, meta }
  return globalCache
}

function envKey(provider: KeyProvider): string | undefined {
  if (provider === "anthropic") return config.ANTHROPIC_API_KEY
  if (provider === "openai") return config.OPENAI_API_KEY
  if (provider === "gemini") return config.GEMINI_API_KEY
  if (provider === "deepseek") return config.DEEPSEEK_API_KEY
  return config.XAI_API_KEY
}

/** Chave global efetiva: banco (admin) → env (legado). */
export async function getGlobalKey(
  provider: KeyProvider,
): Promise<string | undefined> {
  const cache = await loadGlobalKeys().catch(() => null)
  return cache?.keys.get(provider) ?? envKey(provider)
}

/** Presença de chave global por provedor (banco ou env) — para o catálogo. */
export async function globalKeyPresence(): Promise<Record<KeyProvider, boolean>> {
  const out = {} as Record<KeyProvider, boolean>
  for (const p of KEY_PROVIDERS) {
    out[p] = Boolean(await getGlobalKey(p))
  }
  return out
}

/** Metadados para o painel admin (nunca o claro). */
export async function listProviderKeysAdmin(): Promise<{
  enabled: boolean
  keys: ProviderKeyMeta[]
  env: Record<KeyProvider, boolean>
}> {
  const env = {} as Record<KeyProvider, boolean>
  for (const p of KEY_PROVIDERS) env[p] = Boolean(envKey(p))
  if (!keyManagementEnabled()) return { enabled: false, keys: [], env }
  const cache = await loadGlobalKeys()
  return { enabled: true, keys: cache.meta, env }
}

export async function saveProviderKey(
  provider: KeyProvider,
  key: string,
  updatedBy: string | null,
): Promise<ProviderKeyMeta> {
  const { data, error } = await supabase
    .from("dexter_provider_keys")
    .upsert(
      {
        provider,
        ciphertext: encryptSecret(key),
        last4: last4Of(key),
        updated_by: updatedBy,
      },
      { onConflict: "provider" },
    )
    .select("provider, last4, updated_at")
    .single()
  if (error || !data) {
    throw new Error(`Falha ao salvar chave: ${error?.message ?? "sem retorno"}`)
  }
  invalidateLlmKeyCache()
  return {
    provider,
    last4: String(data.last4),
    updated_at: String(data.updated_at),
  }
}

export async function deleteProviderKey(provider: KeyProvider): Promise<void> {
  const { error } = await supabase
    .from("dexter_provider_keys")
    .delete()
    .eq("provider", provider)
  if (error) throw new Error(`Falha ao remover chave: ${error.message}`)
  invalidateLlmKeyCache()
}

// --- Chaves pessoais (BYOK) -------------------------------------------------

export interface UserKeyMeta {
  provider: KeyProvider
  last4: string
  updated_at: string
}

const USER_CACHE_TTL_MS = 30_000
const userKeyCache = new Map<
  string,
  { at: number; key: string | null }
>()

/** Chave pessoal do usuário para o provedor, ou null. */
export async function getUserKey(
  userId: string,
  provider: KeyProvider,
): Promise<string | null> {
  if (!keyManagementEnabled()) return null
  const cacheId = `${userId}:${provider}`
  const hit = userKeyCache.get(cacheId)
  if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.key

  const { data, error } = await supabase
    .from("agent_user_api_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle()
  let key: string | null = null
  if (!error && data?.ciphertext) {
    try {
      key = decryptSecret(String(data.ciphertext))
    } catch {
      key = null
    }
  }
  userKeyCache.set(cacheId, { at: Date.now(), key })
  if (userKeyCache.size > 1000) {
    const oldest = userKeyCache.keys().next().value
    if (oldest) userKeyCache.delete(oldest)
  }
  return key
}

export async function listUserKeys(userId: string): Promise<UserKeyMeta[]> {
  const { data, error } = await supabase
    .from("agent_user_api_keys")
    .select("provider, last4, updated_at")
    .eq("user_id", userId)
  if (error) throw new Error(`Falha ao listar suas chaves: ${error.message}`)
  return (data ?? [])
    .filter((r) => isKeyProvider(String(r.provider)))
    .map((r) => ({
      provider: String(r.provider) as KeyProvider,
      last4: String(r.last4),
      updated_at: String(r.updated_at),
    }))
}

export async function saveUserKey(
  userId: string,
  provider: KeyProvider,
  key: string,
): Promise<UserKeyMeta> {
  const { data, error } = await supabase
    .from("agent_user_api_keys")
    .upsert(
      {
        user_id: userId,
        provider,
        ciphertext: encryptSecret(key),
        last4: last4Of(key),
      },
      { onConflict: "user_id,provider" },
    )
    .select("provider, last4, updated_at")
    .single()
  if (error || !data) {
    throw new Error(`Falha ao salvar sua chave: ${error?.message ?? "sem retorno"}`)
  }
  userKeyCache.delete(`${userId}:${provider}`)
  return {
    provider,
    last4: String(data.last4),
    updated_at: String(data.updated_at),
  }
}

export async function deleteUserKey(
  userId: string,
  provider: KeyProvider,
): Promise<void> {
  const { error } = await supabase
    .from("agent_user_api_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
  if (error) throw new Error(`Falha ao remover sua chave: ${error.message}`)
  userKeyCache.delete(`${userId}:${provider}`)
}

// --- Resolução efetiva ------------------------------------------------------

/**
 * Chave a usar num request: pessoal do usuário → global (banco → env).
 * `undefined` = provedor indisponível (só Ollama funciona sem chave).
 */
export async function getEffectiveKey(
  provider: KeyProvider,
  userId?: string,
): Promise<string | undefined> {
  if (userId) {
    const own = await getUserKey(userId, provider).catch(() => null)
    if (own) return own
  }
  return getGlobalKey(provider)
}
