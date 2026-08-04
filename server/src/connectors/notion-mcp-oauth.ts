/**
 * Notion MCP OAuth (como Cursor): discovery → DCR → PKCE → browser → tokens.
 * Sem NOTION_CLIENT_ID/SECRET no Infisical.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
 * Docs: https://developers.notion.com/guides/mcp/build-mcp-client
 */
import { createHash, randomBytes } from "node:crypto"

import { agentcorePublicUrl } from "./oauth-urls.js"

const MCP_RESOURCE = "https://mcp.notion.com"
const USER_AGENT = "Dexter-AgentCore-MCP/1.0"

export type NotionOAuthMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
}

export type NotionMcpTokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  user_id?: string
  workspace_id?: string
  email_domain?: string
}

type CachedClient = {
  client_id: string
  client_secret?: string
  redirect_uri: string
}

let cachedMetadata: NotionOAuthMetadata | null = null
let cachedClient: CachedClient | null = null

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export function notionMcpRedirectUri(): string {
  return `${agentcorePublicUrl()}/api/connectors/notion/callback`
}

export async function discoverNotionMcpOAuth(): Promise<NotionOAuthMetadata> {
  if (cachedMetadata) return cachedMetadata

  const prRes = await fetch(
    `${MCP_RESOURCE}/.well-known/oauth-protected-resource`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
  )
  if (!prRes.ok) {
    throw new Error(`Notion MCP PRM: HTTP ${prRes.status}`)
  }
  const pr = (await prRes.json()) as { authorization_servers?: string[] }
  const asBase = pr.authorization_servers?.[0] ?? MCP_RESOURCE

  const metaRes = await fetch(
    new URL("/.well-known/oauth-authorization-server", asBase).toString(),
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
  )
  if (!metaRes.ok) {
    throw new Error(`Notion MCP AS metadata: HTTP ${metaRes.status}`)
  }
  const meta = (await metaRes.json()) as NotionOAuthMetadata
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("Notion MCP AS metadata incompleta")
  }
  cachedMetadata = meta
  return meta
}

/** Notion MCP remoto está online (discovery ok). Sem Client ID no vault. */
export async function notionMcpAvailable(): Promise<boolean> {
  try {
    await discoverNotionMcpOAuth()
    return true
  } catch {
    return false
  }
}

async function registerClient(
  metadata: NotionOAuthMetadata,
  redirectUri: string,
): Promise<CachedClient> {
  if (
    cachedClient &&
    cachedClient.redirect_uri === redirectUri &&
    cachedClient.client_id
  ) {
    return cachedClient
  }
  if (!metadata.registration_endpoint) {
    throw new Error("Notion MCP sem registration_endpoint (DCR)")
  }
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_name: "Dexter (GoWork)",
      client_uri: "https://gowork.com.br",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "default",
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `Notion MCP DCR falhou: ${res.status} — ${body.slice(0, 300)}`,
    )
  }
  const json = (await res.json()) as {
    client_id?: string
    client_secret?: string
  }
  if (!json.client_id) throw new Error("Notion MCP DCR sem client_id")
  cachedClient = {
    client_id: json.client_id,
    client_secret: json.client_secret,
    redirect_uri: redirectUri,
  }
  return cachedClient
}

/** Garante client_id via DCR (cache em memória por processo). */
export async function ensureNotionMcpClientId(): Promise<string> {
  const metadata = await discoverNotionMcpOAuth()
  const client = await registerClient(metadata, notionMcpRedirectUri())
  return client.client_id
}

export async function buildNotionMcpAuthorizeUrl(opts: {
  state: string
  codeChallenge: string
  clientId?: string
}): Promise<{ url: string; clientId: string }> {
  const metadata = await discoverNotionMcpOAuth()
  const redirectUri = notionMcpRedirectUri()
  const clientId =
    opts.clientId ?? (await registerClient(metadata, redirectUri)).client_id
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "default",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    prompt: "consent",
  })
  return {
    url: `${metadata.authorization_endpoint}?${params.toString()}`,
    clientId,
  }
}

async function tokenRequest(
  body: URLSearchParams,
): Promise<NotionMcpTokenResponse> {
  const metadata = await discoverNotionMcpOAuth()
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
  })
  const json = (await res.json()) as NotionMcpTokenResponse & {
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description ??
        json.error ??
        `Notion MCP token HTTP ${res.status}`,
    )
  }
  return json
}

export async function exchangeNotionMcpCode(opts: {
  code: string
  codeVerifier: string
  clientId: string
}): Promise<NotionMcpTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: notionMcpRedirectUri(),
    code_verifier: opts.codeVerifier,
    resource: MCP_RESOURCE,
  })
  return tokenRequest(body)
}

export async function refreshNotionMcpToken(opts: {
  refreshToken: string
  clientId: string
}): Promise<NotionMcpTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    resource: MCP_RESOURCE,
  })
  return tokenRequest(body)
}
