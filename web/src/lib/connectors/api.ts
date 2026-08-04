import { getAccessToken } from "@/lib/supabase/auth"

export type ConnectorId = "notion" | "outlook"

export type ConnectorAuthMode =
  | "mcp_oauth"
  | "oauth_user"
  | "workspace_token_fallback"
  | "mcp_stdio"
  | "unconfigured"

export type ConnectorRuntimeMode = "mcp" | "mcp_stdio" | "rest" | "none"

export interface ConnectorStatus {
  id: ConnectorId
  label: string
  configured: boolean
  connected: boolean
  enabled: boolean
  authMode: ConnectorAuthMode
  runtimeMode: ConnectorRuntimeMode
  detail: string
  meta?: Record<string, unknown>
}

export interface ConnectorsResponse {
  connectors: ConnectorStatus[]
  preferences: { notion?: boolean; outlook?: boolean }
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function fetchConnectors(
  signal?: AbortSignal,
): Promise<ConnectorsResponse> {
  const response = await fetch("/api/connectors", {
    headers: await authHeaders(),
    signal,
  })
  if (!response.ok) {
    throw new Error(`GET /api/connectors respondeu ${response.status}`)
  }
  return response.json()
}

export async function patchConnectors(
  patch: { notion?: boolean; outlook?: boolean },
): Promise<ConnectorsResponse> {
  const response = await fetch("/api/connectors", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string
    } | null
    throw new Error(
      body?.message ?? `PATCH /api/connectors respondeu ${response.status}`,
    )
  }
  return response.json()
}

/** Inicia OAuth — retorna URL do provedor para redirecionar o browser. */
export async function startConnectorConnect(
  provider: ConnectorId,
  returnTo?: string,
): Promise<string> {
  const qs = returnTo
    ? `?return_to=${encodeURIComponent(returnTo)}`
    : ""
  const response = await fetch(`/api/connectors/${provider}/connect${qs}`, {
    headers: await authHeaders(),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string
    } | null
    throw new Error(
      body?.message ??
        `GET /api/connectors/${provider}/connect → ${response.status}`,
    )
  }
  const data = (await response.json()) as { url?: string }
  if (!data.url) throw new Error("URL OAuth ausente na resposta")
  return data.url
}

export async function disconnectConnector(
  provider: ConnectorId,
): Promise<ConnectorsResponse> {
  const response = await fetch(`/api/connectors/${provider}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string
    } | null
    throw new Error(
      body?.message ??
        `DELETE /api/connectors/${provider} → ${response.status}`,
    )
  }
  return response.json()
}
