import { getAccessToken } from "@/lib/supabase/auth"
import type { DexterRole } from "@/types"

const BASE = "/api/admin"

export interface AdminUserRow {
  id: string
  email: string | null
  full_name: string | null
  avatar_url: string | null
  role: DexterRole
  disabled_at: string | null
  /** Modelos liberados (ids provider:modelo). null = todos os habilitados. */
  allowed_models: string[] | null
  created_at: string
  updated_at: string
  last_sign_in_at: string | null
}

export interface AdminModelStat {
  model: string
  messages: number
  tokens_in: number
  tokens_out: number
  tokens: number
  cost_usd: number
}

export interface AdminDayStat {
  day: string
  messages: number
  user_messages?: number
  assistant_messages?: number
  tokens: number
  active_users?: number
  cost_usd?: number
}

export interface AdminOverview {
  period_days: number
  since: string
  totals: {
    users_total: number
    users_active: number
    users_disabled: number
    chats_total: number
    chats_period: number
    messages_period: number
    user_messages_period: number
    assistant_messages_period: number
    tokens_period: number
    tokens_in_period: number
    tokens_out_period: number
    cost_usd_period: number
  }
  by_model: AdminModelStat[]
  by_day: AdminDayStat[]
  top_users: Array<{
    user_id: string
    email: string | null
    full_name: string | null
    role: DexterRole
    chats: number
    messages: number
    tokens: number
    cost_usd?: number
  }>
}

export interface AdminUserChat {
  id: string
  title: string | null
  project_id: string | null
  created_at: string
  updated_at: string
  message_count: number
  tokens: number
  cost_usd_period?: number
  last_model: string | null
}

export interface AdminUserDetail {
  period_days: number
  since: string
  profile: {
    id: string
    email: string | null
    full_name: string | null
    avatar_url: string | null
    role: DexterRole
    disabled_at: string | null
    usage_budget_usd?: number | null
    created_at: string
    updated_at: string
  }
  totals: {
    chats_total: number
    chats_period: number
    messages_total: number
    messages_period: number
    tokens_total: number
    tokens_period: number
    tokens_in_period: number
    tokens_out_period: number
    cost_usd_period: number
    last_message_at: string | null
    tool_calls_period: number
  }
  by_model: AdminModelStat[]
  by_day: AdminDayStat[]
  chats: AdminUserChat[]
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" }
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string
      // Rotas com `.parse` respondem 400 invalid_request só com o flatten do
      // Zod (sem `message`) — a mensagem útil está aqui.
      details?: {
        formErrors?: string[]
        fieldErrors?: Record<string, string[] | undefined>
      }
    }
    if (body.message) return body.message
    const doZod =
      body.details?.formErrors?.find(Boolean) ??
      Object.values(body.details?.fieldErrors ?? {})
        .flat()
        .find(Boolean)
    if (doZod) return doZod
  } catch {
    /* ignore */
  }
  return fallback
}

export async function fetchAdminMe(): Promise<{
  id: string
  email: string | null
  role: DexterRole
  isStaff: boolean
}> {
  const res = await fetch(`${BASE}/me`, { headers: await authHeaders() })
  if (!res.ok) {
    throw new Error(await parseError(res, `GET /api/admin/me → ${res.status}`))
  }
  return res.json()
}

export async function fetchAdminOverview(days = 30): Promise<{
  overview: AdminOverview
  actorRole: DexterRole
}> {
  const res = await fetch(`${BASE}/overview?days=${days}`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/overview → ${res.status}`),
    )
  }
  return res.json()
}

export async function fetchAdminUsers(): Promise<{
  users: AdminUserRow[]
  actorRole: DexterRole
}> {
  const res = await fetch(`${BASE}/users`, { headers: await authHeaders() })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/users → ${res.status}`),
    )
  }
  return res.json()
}

export async function fetchAdminUserDetail(
  id: string,
  days = 30,
): Promise<{ detail: AdminUserDetail; actorRole: DexterRole }> {
  const res = await fetch(`${BASE}/users/${id}?days=${days}`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/users/${id} → ${res.status}`),
    )
  }
  return res.json()
}

export async function fetchAdminCostCenter(days = 30): Promise<{
  costCenter: AdminCostCenter
  actorRole: DexterRole
}> {
  const res = await fetch(`${BASE}/cost-center?days=${days}`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/cost-center → ${res.status}`),
    )
  }
  return res.json()
}

export interface AdminCostCenter {
  period_days: number
  since: string
  month_start: string
  totals: {
    active_users: number
    chats: number
    messages: number
    tokens: number
    cost_usd: number
  }
  by_user: Array<{
    user_id: string
    email: string | null
    full_name: string | null
    role: DexterRole
    usage_budget_usd: number | null
    cost_usd_month: number
    chats: number
    messages: number
    tokens: number
    cost_usd: number
  }>
  by_chat: Array<{
    chat_id: string
    title: string | null
    user_id: string
    email: string | null
    full_name: string | null
    messages: number
    tokens: number
    cost_usd: number
    last_at: string
  }>
  by_model: AdminModelStat[]
  by_provider: Array<{
    provider: string
    messages: number
    tokens: number
    cost_usd: number
  }>
  by_day: AdminDayStat[]
  pricing: Array<{
    id: string
    input_usd_per_million: number | null
    output_usd_per_million: number | null
    updated_at: string
  }>
  providers: Array<{
    id: string
    label: string
    default_cost_tier: string | null
    credit_status: string
    balance_usd: number | null
    low_threshold_usd: number | null
    balance_updated_at: string | null
  }>
}

export async function patchAdminPricing(
  id: string,
  patch: {
    input_usd_per_million?: number | null
    output_usd_per_million?: number | null
  },
): Promise<void> {
  const res = await fetch(`${BASE}/pricing/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `PATCH /api/admin/pricing/${id} → ${res.status}`),
    )
  }
}

export async function patchAdminUser(
  id: string,
  patch: {
    role?: DexterRole
    disabled?: boolean
    /** null = liberar todos os modelos; array = restringir a estes ids. */
    allowed_models?: string[] | null
    usage_budget_usd?: number | null
  },
): Promise<AdminUserRow> {
  const res = await fetch(`${BASE}/users/${id}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `PATCH /api/admin/users/${id} → ${res.status}`),
    )
  }
  const body = (await res.json()) as { user: AdminUserRow }
  return body.user
}

export type AdminModelProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "xai"
  | "ollama"

export interface AdminCatalogModel {
  id: string
  provider: AdminModelProvider
  api_model: string
  label: string
  description: string
  traits: string[]
  capabilities?: {
    vision: boolean
    files: boolean
    imageGeneration: boolean
  }
  enabled: boolean
  is_default: boolean
  sort_order: number
  /** Null = API não informou (não inventamos). */
  max_output_tokens: number | null
  /** Janela de contexto (entrada), se o provider informar. */
  input_token_limit?: number | null
  /** Lançamento/criação no provider (ISO). */
  released_at?: string | null
  credential_ok: boolean
  latency_ms?: number | null
  input_usd_per_million?: number | null
  output_usd_per_million?: number | null
  provider_label?: string
}

export interface AdminProviderMeta {
  id: string
  label: string
  credit_status?: "available" | "low" | "depleted" | "unknown"
  balance_usd?: number | null
  low_threshold_usd?: number | null
}

export async function fetchAdminModels(opts?: {
  probe?: boolean
}): Promise<{
  models: AdminCatalogModel[]
  providers?: Record<string, { credential: boolean }>
  provider_meta?: AdminProviderMeta[]
  actorRole: DexterRole
}> {
  const probe = opts?.probe === true
  const qs = probe ? "?probe=1" : ""
  const res = await fetch(`${BASE}/models${qs}`, { headers: await authHeaders() })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/models → ${res.status}`),
    )
  }
  return res.json()
}

/**
 * Campos aceitos pelo `modelPatchSchema` do servidor (server/src/routes/admin.ts).
 * O schema é strict: mandar qualquer outra chave volta 400 invalid_request —
 * mantenha os dois lados alinhados.
 */
export async function patchAdminModel(
  id: string,
  patch: {
    enabled?: boolean
    is_default?: boolean
    label?: string | null
    description?: string | null
    sort_order?: number | null
  },
): Promise<AdminCatalogModel> {
  const res = await fetch(`${BASE}/models/${id}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `PATCH /api/admin/models/${id} → ${res.status}`),
    )
  }
  const body = (await res.json()) as { model: AdminCatalogModel }
  return body.model
}

export async function bulkPatchAdminModels(
  ids: string[],
  enabled: boolean,
): Promise<{ updated: number }> {
  const res = await fetch(`${BASE}/models/bulk`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ ids, enabled }),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `POST /api/admin/models/bulk → ${res.status}`),
    )
  }
  return res.json()
}

export async function patchAdminProvider(
  id: string,
  patch: {
    label?: string
    credit_status?: "available" | "low" | "depleted" | "unknown"
    balance_usd?: number | null
    low_threshold_usd?: number | null
  },
): Promise<AdminProviderMeta> {
  const res = await fetch(`${BASE}/providers/${id}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `PATCH /api/admin/providers/${id} → ${res.status}`),
    )
  }
  const body = (await res.json()) as { provider: AdminProviderMeta }
  return body.provider
}

// --- Chaves de API globais dos provedores (banco, cifradas) -----------------

export type ProviderKeyProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "xai"

export interface AdminProviderKey {
  provider: ProviderKeyProvider
  last4: string
  updated_at: string
}

export interface AdminProviderKeysResponse {
  /** false = USER_API_KEYS_SECRET ausente no servidor (gestão desabilitada). */
  enabled: boolean
  keys: AdminProviderKey[]
  /** Presença de fallback por variável de ambiente (legado Infisical). */
  env: Record<ProviderKeyProvider, boolean>
}

export async function fetchAdminProviderKeys(): Promise<AdminProviderKeysResponse> {
  const res = await fetch(`${BASE}/provider-keys`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/provider-keys → ${res.status}`),
    )
  }
  return res.json()
}

export async function putAdminProviderKey(
  provider: ProviderKeyProvider,
  key: string,
): Promise<AdminProviderKey> {
  const res = await fetch(`${BASE}/provider-keys/${provider}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ key }),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `PUT /api/admin/provider-keys/${provider} → ${res.status}`),
    )
  }
  const body = (await res.json()) as { key: AdminProviderKey }
  return body.key
}

export async function deleteAdminProviderKey(
  provider: ProviderKeyProvider,
): Promise<void> {
  const res = await fetch(`${BASE}/provider-keys/${provider}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(
        res,
        `DELETE /api/admin/provider-keys/${provider} → ${res.status}`,
      ),
    )
  }
}

// --- Chaves dedicadas por usuário (atribuídas pelo admin) -------------------
// Mesma tabela do BYOK: a chave dedicada é a que o usuário usaria se
// cadastrasse a própria nas Configurações.

export async function fetchAdminUserKeys(userId: string): Promise<{
  enabled: boolean
  keys: AdminProviderKey[]
}> {
  const res = await fetch(`${BASE}/users/${userId}/keys`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/users/${userId}/keys → ${res.status}`),
    )
  }
  return res.json()
}

export async function putAdminUserKey(
  userId: string,
  provider: ProviderKeyProvider,
  key: string,
): Promise<AdminProviderKey> {
  const res = await fetch(`${BASE}/users/${userId}/keys/${provider}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ key }),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(
        res,
        `PUT /api/admin/users/${userId}/keys/${provider} → ${res.status}`,
      ),
    )
  }
  const body = (await res.json()) as { key: AdminProviderKey }
  return body.key
}

export async function deleteAdminUserKey(
  userId: string,
  provider: ProviderKeyProvider,
): Promise<void> {
  const res = await fetch(`${BASE}/users/${userId}/keys/${provider}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(
        res,
        `DELETE /api/admin/users/${userId}/keys/${provider} → ${res.status}`,
      ),
    )
  }
}

export type KbCategory =
  | "empresa"
  | "sistemas"
  | "projetos"
  | "pessoas"
  | "glossario"
  | "geral"

/** Doc markdown da base de conhecimento da empresa (contexto do Dexter). */
export interface KbDoc {
  id: string
  slug: string
  title: string
  category: KbCategory
  content: string
  /** Doc desativado não entra no contexto nem aparece na tool kb__buscar. */
  enabled: boolean
  /** true = injetado em toda conversa (custa tokens sempre). */
  always_load: boolean
  sort: number
  created_at: string
  updated_at: string
}

export interface KbDocInput {
  slug?: string
  title: string
  category: KbCategory
  content: string
  enabled?: boolean
  always_load?: boolean
  sort?: number
}

export async function fetchAdminKbDocs(): Promise<{
  docs: KbDoc[]
  actorRole: DexterRole
}> {
  const res = await fetch(`${BASE}/kb`, { headers: await authHeaders() })
  if (!res.ok) {
    throw new Error(await parseError(res, `GET /api/admin/kb → ${res.status}`))
  }
  return res.json()
}

export async function createAdminKbDoc(input: KbDocInput): Promise<KbDoc> {
  const res = await fetch(`${BASE}/kb`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await parseError(res, `POST /api/admin/kb → ${res.status}`))
  }
  const body = (await res.json()) as { doc: KbDoc }
  return body.doc
}

/** Patch parcial — mande só os campos que mudaram (ao menos um). */
export async function patchAdminKbDoc(
  id: string,
  patch: Partial<KbDocInput>,
): Promise<KbDoc> {
  const res = await fetch(`${BASE}/kb/${id}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `PATCH /api/admin/kb/${id} → ${res.status}`),
    )
  }
  const body = (await res.json()) as { doc: KbDoc }
  return body.doc
}

export async function deleteAdminKbDoc(id: string): Promise<void> {
  const res = await fetch(`${BASE}/kb/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `DELETE /api/admin/kb/${id} → ${res.status}`),
    )
  }
}
