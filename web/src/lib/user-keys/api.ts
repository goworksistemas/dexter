/**
 * Chamadas HTTP para /api/user-keys — chaves de API pessoais (BYOK). A chave
 * nunca volta do servidor: só os 4 últimos caracteres e a data de atualização.
 */
import { getAccessToken } from "@/lib/supabase/auth"

const BASE_URL = "/api"

export type UserKeyProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "xai"

export interface UserKey {
  provider: UserKeyProvider
  last4: string
  updated_at: string
}

export interface UserKeysResponse {
  /** false quando o servidor não tem o segredo de criptografia configurado. */
  enabled: boolean
  keys: UserKey[]
}

async function authHeaders(json = false): Promise<Record<string, string>> {
  const token = await getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json) headers["Content-Type"] = "application/json"
  return headers
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }
    if (body.message) return body.message
  } catch {
    /* ignore */
  }
  return fallback
}

export async function fetchUserKeys(signal?: AbortSignal): Promise<UserKeysResponse> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/user-keys`, {
      headers: await authHeaders(),
      signal,
    })
  } catch (err) {
    // Abort é fluxo normal (troca de página): quem chamou checa o signal.
    if (signal?.aborted) throw err
    throw new Error(
      "AgentCore inacessível. Confirme que o backend está rodando (porta 8787).",
    )
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sessão inválida. Faça login novamente.")
    if (response.status === 404) {
      throw new Error(
        "GET /api/user-keys não encontrado (404). Reinicie o AgentCore com o código atual (porta 8787).",
      )
    }
    throw new Error(await parseError(response, `GET /api/user-keys respondeu ${response.status}`))
  }
  return (await response.json()) as UserKeysResponse
}

export async function saveUserKey(
  provider: UserKeyProvider,
  key: string,
): Promise<UserKey> {
  const response = await fetch(`${BASE_URL}/user-keys/${provider}`, {
    method: "PUT",
    headers: await authHeaders(true),
    body: JSON.stringify({ key }),
  })
  if (!response.ok) {
    throw new Error(
      await parseError(response, `PUT /api/user-keys/${provider} falhou (${response.status})`),
    )
  }
  const body = (await response.json()) as { key: UserKey }
  return body.key
}

export async function deleteUserKey(provider: UserKeyProvider): Promise<void> {
  const response = await fetch(`${BASE_URL}/user-keys/${provider}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok) {
    throw new Error(
      await parseError(response, `DELETE /api/user-keys/${provider} falhou`),
    )
  }
}
