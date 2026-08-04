/**
 * OAuth dos conectores:
 *  - Notion: MCP OAuth (DCR+PKCE em mcp.notion.com) — sem Client ID no Infisical
 *  - Outlook: OAuth clássico Microsoft Graph — Client ID/Secret no Infisical (1×)
 */
import { config } from "../config.js"
import { fetchNotionWorkspaceLabel } from "../mcp/http-client.js"
import {
  buildNotionMcpAuthorizeUrl,
  ensureNotionMcpClientId,
  exchangeNotionMcpCode,
  generatePkce,
  notionMcpAvailable,
} from "./notion-mcp-oauth.js"
import {
  agentcorePublicUrl,
  dexterAppUrl,
  microsoftRedirectUri,
} from "./oauth-urls.js"
import { saveConnectorPreferences } from "./prefs.js"
import {
  consumeOAuthState,
  createOAuthState,
  logConnectorEvent,
  upsertConnectorTokens,
} from "./store.js"
import type { ConnectorId } from "./types.js"

export { agentcorePublicUrl, dexterAppUrl, microsoftRedirectUri }

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0
}

export function microsoftOAuthConfigured(): boolean {
  return (
    nonEmpty(config.MICROSOFT_CLIENT_ID) &&
    nonEmpty(config.MICROSOFT_CLIENT_SECRET) &&
    nonEmpty(config.MICROSOFT_TENANT_ID)
  )
}

/** @deprecated use connectorConfigured — Notion não depende mais de CLIENT_ID. */
export function notionOAuthConfigured(): boolean {
  return (
    nonEmpty(config.NOTION_CLIENT_ID) && nonEmpty(config.NOTION_CLIENT_SECRET)
  )
}

export function oauthAppConfigured(id: ConnectorId): boolean {
  if (id === "outlook") return microsoftOAuthConfigured()
  // Notion: MCP remoto; Client ID clássico é opcional/legado.
  return true
}

const OUTLOOK_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.Read",
  "Calendars.ReadWrite",
].join(" ")

function safeReturnTo(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null
  const t = raw.trim()
  if (!t.startsWith("/") || t.startsWith("//")) return null
  if (t.includes("://")) return null
  return t.slice(0, 512)
}

export async function buildConnectUrl(opts: {
  userId: string
  provider: ConnectorId
  returnTo?: string | null
}): Promise<string> {
  if (opts.provider === "notion") {
    const ok = await notionMcpAvailable()
    if (!ok) {
      throw new Error(
        "Notion MCP indisponível (mcp.notion.com não respondeu).",
      )
    }
    const pkce = generatePkce()
    const clientId = await ensureNotionMcpClientId()
    const state = await createOAuthState({
      userId: opts.userId,
      provider: "notion",
      returnTo: safeReturnTo(opts.returnTo),
      payload: {
        flow: "mcp_oauth",
        code_verifier: pkce.verifier,
        client_id: clientId,
      },
    })
    const { url } = await buildNotionMcpAuthorizeUrl({
      state,
      codeChallenge: pkce.challenge,
      clientId,
    })
    return url
  }

  if (!microsoftOAuthConfigured()) {
    throw new Error(
      "Outlook indisponível: cadastre MICROSOFT_CLIENT_ID/SECRET/TENANT_ID no Infisical e rode `pnpm dev`.",
    )
  }
  const state = await createOAuthState({
    userId: opts.userId,
    provider: "outlook",
    returnTo: safeReturnTo(opts.returnTo),
    payload: { flow: "oauth_user" },
  })
  const tenant = config.MICROSOFT_TENANT_ID!.trim()
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID!.trim(),
    response_type: "code",
    redirect_uri: microsoftRedirectUri(),
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    state,
  })
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}`
}

function appRedirect(opts: {
  provider: ConnectorId
  ok: boolean
  returnTo?: string | null
  error?: string
}): string {
  const base = dexterAppUrl()
  const path = safeReturnTo(opts.returnTo) ?? "/"
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`)
  url.searchParams.set("connector", opts.provider)
  url.searchParams.set("status", opts.ok ? "connected" : "error")
  if (opts.error) url.searchParams.set("reason", opts.error.slice(0, 120))
  return url.toString()
}

async function exchangeMicrosoftCode(code: string): Promise<{
  access_token: string
  refresh_token: string | null
  expires_at: Date | null
  meta: Record<string, unknown>
}> {
  const tenant = config.MICROSOFT_TENANT_ID!.trim()
  const body = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID!.trim(),
    client_secret: config.MICROSOFT_CLIENT_SECRET!.trim(),
    grant_type: "authorization_code",
    code,
    redirect_uri: microsoftRedirectUri(),
    scope: OUTLOOK_SCOPES,
  })
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  )
  const json = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
    error?: string
    scope?: string
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description ?? json.error ?? `Microsoft token ${res.status}`,
    )
  }
  const expires_at =
    typeof json.expires_in === "number"
      ? new Date(Date.now() + json.expires_in * 1000)
      : null
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    expires_at,
    meta: { scope: json.scope ?? OUTLOOK_SCOPES, flow: "oauth_user" },
  }
}

export async function handleOAuthCallback(opts: {
  provider: ConnectorId
  code: string | undefined
  state: string | undefined
  oauthError?: string
}): Promise<string> {
  if (opts.oauthError) {
    return appRedirect({
      provider: opts.provider,
      ok: false,
      error: opts.oauthError,
    })
  }
  if (!opts.code || !opts.state) {
    return appRedirect({
      provider: opts.provider,
      ok: false,
      error: "missing_code_or_state",
    })
  }

  const consumed = await consumeOAuthState(opts.state, opts.provider)
  if (!consumed) {
    return appRedirect({
      provider: opts.provider,
      ok: false,
      error: "invalid_state",
    })
  }

  try {
    if (opts.provider === "notion") {
      const verifier =
        typeof consumed.payload.code_verifier === "string"
          ? consumed.payload.code_verifier
          : null
      const clientId =
        typeof consumed.payload.client_id === "string"
          ? consumed.payload.client_id
          : null
      if (!verifier || !clientId) {
        throw new Error("state OAuth Notion sem PKCE/client_id")
      }
      const tok = await exchangeNotionMcpCode({
        code: opts.code,
        codeVerifier: verifier,
        clientId,
      })
      const expires_at =
        typeof tok.expires_in === "number"
          ? new Date(Date.now() + tok.expires_in * 1000)
          : null
      let workspace_name: string | null = null
      let workspace_id: string | null =
        typeof tok.workspace_id === "string" ? tok.workspace_id : null
      const label = await fetchNotionWorkspaceLabel(tok.access_token)
      if (label?.workspace_name) workspace_name = label.workspace_name
      if (label?.workspace_id) workspace_id = label.workspace_id

      await upsertConnectorTokens({
        userId: consumed.userId,
        provider: "notion",
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        expiresAt: expires_at,
        meta: {
          flow: "mcp_oauth",
          mcp_client_id: clientId,
          workspace_id,
          workspace_name,
          user_id: tok.user_id ?? null,
          email_domain: tok.email_domain ?? null,
        },
      })
    } else {
      const tok = await exchangeMicrosoftCode(opts.code)
      await upsertConnectorTokens({
        userId: consumed.userId,
        provider: "outlook",
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: tok.expires_at,
        meta: tok.meta,
      })
    }
    await saveConnectorPreferences(consumed.userId, {
      [opts.provider]: true,
    })
    await logConnectorEvent({
      userId: consumed.userId,
      provider: opts.provider,
      event: "connect",
      meta: { flow: opts.provider === "notion" ? "mcp_oauth" : "oauth_user" },
    })
    return appRedirect({
      provider: opts.provider,
      ok: true,
      returnTo: consumed.returnTo,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logConnectorEvent({
      userId: consumed.userId,
      provider: opts.provider,
      event: "error",
      meta: { phase: "callback", message: message.slice(0, 300) },
    })
    return appRedirect({
      provider: opts.provider,
      ok: false,
      returnTo: consumed.returnTo,
      error: "token_exchange_failed",
    })
  }
}

export async function refreshMicrosoftToken(opts: {
  userId: string
  refreshToken: string
}): Promise<{
  access_token: string
  refresh_token: string | null
  expires_at: Date | null
}> {
  const tenant = config.MICROSOFT_TENANT_ID!.trim()
  const body = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID!.trim(),
    client_secret: config.MICROSOFT_CLIENT_SECRET!.trim(),
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    scope: OUTLOOK_SCOPES,
  })
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  )
  const json = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description ?? `Microsoft refresh falhou (${res.status})`,
    )
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? opts.refreshToken,
    expires_at:
      typeof json.expires_in === "number"
        ? new Date(Date.now() + json.expires_in * 1000)
        : null,
  }
}
