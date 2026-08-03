/**
 * Chamada HTTP para o catálogo de modelos de IA do AgentCore
 * (`GET /api/models`). Mesmo padrão de `@/lib/chats/api.ts`.
 */
import { getAccessToken } from "@/lib/supabase/auth"
import type { ModelsResponse } from "./types"

const BASE_URL = "/api"

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Lista os modelos (`GET /api/models?probe=1` por padrão). */
export async function fetchModels(
  signal?: AbortSignal,
  opts?: { probe?: boolean },
): Promise<ModelsResponse> {
  const probe = opts?.probe !== false
  const qs = probe ? "?probe=1" : ""
  const response = await fetch(`${BASE_URL}/models${qs}`, {
    headers: await authHeaders(),
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `GET /api/models respondeu ${response.status} ${response.statusText}`,
    )
  }
  return response.json()
}
