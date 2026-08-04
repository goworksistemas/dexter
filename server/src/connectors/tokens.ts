/**
 * Resolve access_token do usuário autenticado
 * (refresh Microsoft / Notion MCP se necessário).
 */
import { config } from "../config.js"
import { refreshNotionMcpToken } from "./notion-mcp-oauth.js"
import { refreshMicrosoftToken } from "./oauth.js"
import {
  getConnectorRow,
  logConnectorEvent,
  updateConnectorTokens,
} from "./store.js"
import type { ConnectorId } from "./types.js"

const REFRESH_SKEW_MS = 90_000

export class ConnectorNotConnectedError extends Error {
  constructor(provider: ConnectorId) {
    super(
      `Conector ${provider} não conectado. Abra Conexões e autorize sua conta.`,
    )
    this.name = "ConnectorNotConnectedError"
  }
}

function notionWorkspaceFallback(): string | null {
  if (config.NOTION_ALLOW_WORKSPACE_TOKEN !== true) return null
  const t = config.NOTION_TOKEN?.trim()
  return t || null
}

export async function resolveUserConnectorToken(
  userId: string,
  provider: ConnectorId,
): Promise<string> {
  const row = await getConnectorRow(userId, provider)
  if (row && row.status === "connected" && row.access_token) {
    if (provider === "outlook") {
      return refreshOutlookIfNeeded(userId, row)
    }
    if (provider === "notion") {
      return refreshNotionIfNeeded(userId, row)
    }
    return row.access_token
  }

  if (provider === "notion") {
    const fallback = notionWorkspaceFallback()
    if (fallback) return fallback
  }

  throw new ConnectorNotConnectedError(provider)
}

async function refreshOutlookIfNeeded(
  userId: string,
  row: {
    access_token: string
    refresh_token: string | null
    expires_at: string | null
  },
): Promise<string> {
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null
  const needsRefresh =
    expiresAt !== null && Date.now() >= expiresAt - REFRESH_SKEW_MS

  if (!needsRefresh) return row.access_token
  if (!row.refresh_token) {
    throw new ConnectorNotConnectedError("outlook")
  }

  try {
    const tok = await refreshMicrosoftToken({
      userId,
      refreshToken: row.refresh_token,
    })
    await updateConnectorTokens({
      userId,
      provider: "outlook",
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: tok.expires_at,
    })
    await logConnectorEvent({
      userId,
      provider: "outlook",
      event: "token_refresh",
    })
    return tok.access_token
  } catch (err) {
    await logConnectorEvent({
      userId,
      provider: "outlook",
      event: "error",
      meta: {
        phase: "refresh",
        message: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
    })
    throw new ConnectorNotConnectedError("outlook")
  }
}

async function refreshNotionIfNeeded(
  userId: string,
  row: {
    access_token: string
    refresh_token: string | null
    expires_at: string | null
    meta: Record<string, unknown>
  },
): Promise<string> {
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null
  const needsRefresh =
    expiresAt !== null && Date.now() >= expiresAt - REFRESH_SKEW_MS

  if (!needsRefresh) return row.access_token
  if (!row.refresh_token) {
    // Tokens Notion MCP sem expiry explícito — usa o access atual.
    if (expiresAt === null) return row.access_token
    throw new ConnectorNotConnectedError("notion")
  }

  const clientId =
    typeof row.meta.mcp_client_id === "string" ? row.meta.mcp_client_id : null
  if (!clientId) {
    // Legado REST / sem client — devolve access se ainda “válido”.
    if (expiresAt === null || Date.now() < expiresAt) return row.access_token
    throw new ConnectorNotConnectedError("notion")
  }

  try {
    const tok = await refreshNotionMcpToken({
      refreshToken: row.refresh_token,
      clientId,
    })
    const expires_at =
      typeof tok.expires_in === "number"
        ? new Date(Date.now() + tok.expires_in * 1000)
        : null
    await updateConnectorTokens({
      userId,
      provider: "notion",
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? row.refresh_token,
      expiresAt: expires_at,
    })
    await logConnectorEvent({
      userId,
      provider: "notion",
      event: "token_refresh",
      meta: { flow: "mcp_oauth" },
    })
    return tok.access_token
  } catch (err) {
    await logConnectorEvent({
      userId,
      provider: "notion",
      event: "error",
      meta: {
        phase: "refresh",
        message: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
    })
    throw new ConnectorNotConnectedError("notion")
  }
}
