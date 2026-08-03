import { getAccessToken } from "@/lib/supabase/auth"

export type ConnectionStatus = "connected" | "no_access" | "unavailable"

export interface ConnectionInfo {
  slug: string
  label: string
  status: ConnectionStatus
  role?: string
  fullName?: string
  email?: string
}

export interface ConnectionsResponse {
  email: string | null
  connections: ConnectionInfo[]
  connectedCount: number
}

export async function fetchConnections(
  signal?: AbortSignal,
): Promise<ConnectionsResponse> {
  const token = await getAccessToken()
  const response = await fetch("/api/connections", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  })
  if (!response.ok) {
    throw new Error(`GET /api/connections respondeu ${response.status}`)
  }
  return response.json()
}
