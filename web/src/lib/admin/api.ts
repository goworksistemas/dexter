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
    const body = (await res.json()) as { message?: string }
    if (body.message) return body.message
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

export async function patchAdminUser(
  id: string,
  patch: { role?: DexterRole; disabled?: boolean },
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
}

export async function fetchAdminModels(): Promise<{
  models: AdminCatalogModel[]
  providers?: Record<string, { credential: boolean }>
  actorRole: DexterRole
}> {
  const res = await fetch(`${BASE}/models`, { headers: await authHeaders() })
  if (!res.ok) {
    throw new Error(
      await parseError(res, `GET /api/admin/models → ${res.status}`),
    )
  }
  return res.json()
}

export async function patchAdminModel(
  id: string,
  patch: {
    enabled?: boolean
    is_default?: boolean
    label?: string
    description?: string
    traits?: string[]
    sort_order?: number
    api_model?: string
    max_output_tokens?: number
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
