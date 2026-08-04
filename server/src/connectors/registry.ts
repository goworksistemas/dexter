/**
 * Catálogo de conectores — produto:
 *  - Notion: MCP remoto (mcp.notion.com) + OAuth MCP (DCR/PKCE). Sem Client ID.
 *  - Outlook: OAuth clássico Microsoft Graph. Client ID/Secret 1× no Infisical.
 *
 * Tokens do usuário: dexter_user_connectors (nunca no Infisical).
 * MCP stdio: só debug opcional (MCP_*_COMMAND).
 */
import { config } from "../config.js"
import { microsoftOAuthConfigured } from "./oauth.js"
import type {
  ConnectorAuthMode,
  ConnectorId,
  ConnectorRuntimeMode,
} from "./types.js"

export interface ConnectorDef {
  id: ConnectorId
  label: string
}

export const CONNECTORS: ConnectorDef[] = [
  { id: "notion", label: "Notion" },
  { id: "outlook", label: "Outlook" },
]

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0
}

function parseCsvArgs(raw: string | undefined): string[] {
  if (!nonEmpty(raw)) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Notion: sempre disponível (MCP hospedado).
 * Outlook: precisa MICROSOFT_* no Infisical.
 * Fallback workspace Notion: só se flag explícita.
 */
export function connectorConfigured(id: ConnectorId): boolean {
  if (id === "notion") {
    if (nonEmpty(config.MCP_NOTION_COMMAND)) return true
    if (
      config.NOTION_ALLOW_WORKSPACE_TOKEN === true &&
      nonEmpty(config.NOTION_TOKEN)
    ) {
      return true
    }
    // Caminho produto: Notion MCP remoto — sem CLIENT_ID.
    return true
  }
  if (microsoftOAuthConfigured()) return true
  if (nonEmpty(config.MCP_OUTLOOK_COMMAND)) return true
  return false
}

export function notionRuntimeMode(): ConnectorRuntimeMode {
  // Preferência: MCP remoto (HTTP) com token OAuth do user.
  if (nonEmpty(config.MCP_NOTION_COMMAND)) return "mcp_stdio"
  return "mcp"
}

export function outlookRuntimeMode(): ConnectorRuntimeMode {
  if (nonEmpty(config.MCP_OUTLOOK_COMMAND)) return "mcp_stdio"
  if (microsoftOAuthConfigured()) return "rest"
  return "none"
}

export function notionAuthMode(): ConnectorAuthMode {
  if (
    config.NOTION_ALLOW_WORKSPACE_TOKEN === true &&
    nonEmpty(config.NOTION_TOKEN)
  ) {
    return "workspace_token_fallback"
  }
  if (nonEmpty(config.MCP_NOTION_COMMAND)) return "mcp_stdio"
  return "mcp_oauth"
}

export function outlookAuthMode(): ConnectorAuthMode {
  if (microsoftOAuthConfigured()) return "oauth_user"
  if (nonEmpty(config.MCP_OUTLOOK_COMMAND)) return "mcp_stdio"
  return "unconfigured"
}

export function notionMcpSpawn(): {
  command: string
  args: string[]
  env: Record<string, string>
} | null {
  const command = config.MCP_NOTION_COMMAND?.trim()
  if (!command) return null
  const args = parseCsvArgs(config.MCP_NOTION_ARGS)
  const env: Record<string, string> = {}
  if (
    config.NOTION_ALLOW_WORKSPACE_TOKEN === true &&
    nonEmpty(config.NOTION_TOKEN)
  ) {
    env.NOTION_TOKEN = config.NOTION_TOKEN
  }
  return { command, args, env }
}

export function outlookMcpSpawn(): {
  command: string
  args: string[]
  env: Record<string, string>
} | null {
  const command = config.MCP_OUTLOOK_COMMAND?.trim()
  if (!command) return null
  const args = parseCsvArgs(config.MCP_OUTLOOK_ARGS)
  const env: Record<string, string> = {}
  if (nonEmpty(config.MICROSOFT_CLIENT_ID)) {
    env.MICROSOFT_CLIENT_ID = config.MICROSOFT_CLIENT_ID
    env.MS365_MCP_CLIENT_ID = config.MICROSOFT_CLIENT_ID
  }
  if (nonEmpty(config.MICROSOFT_CLIENT_SECRET)) {
    env.MICROSOFT_CLIENT_SECRET = config.MICROSOFT_CLIENT_SECRET
    env.MS365_MCP_CLIENT_SECRET = config.MICROSOFT_CLIENT_SECRET
  }
  if (nonEmpty(config.MICROSOFT_TENANT_ID)) {
    env.MICROSOFT_TENANT_ID = config.MICROSOFT_TENANT_ID
    env.MS365_MCP_TENANT_ID = config.MICROSOFT_TENANT_ID
  }
  return { command, args, env }
}

export function connectorDetail(opts: {
  id: ConnectorId
  configured: boolean
  connected: boolean
  enabled: boolean
  workspaceName?: string
}): string {
  const { id, configured, connected, enabled, workspaceName } = opts
  if (!configured) {
    return id === "outlook"
      ? "Indisponível — falta MICROSOFT_* no Infisical"
      : "Indisponível"
  }
  if (!connected) {
    return id === "notion"
      ? "Conecte sua conta Notion."
      : "Conecte sua conta Microsoft / Outlook."
  }
  const where =
    id === "notion" && workspaceName ? `${workspaceName} · ` : ""
  if (enabled) return `${where}Conectado`
  return `${where}Conectado · desligado`
}

/** Log de boot — o que o usuário precisa saber sem abrir .env. */
export function connectorsBootSummary(): string[] {
  const lines: string[] = []
  lines.push(
    "Notion: disponível (MCP OAuth → mcp.notion.com; 1 clique Conectar; sem CLIENT_ID)",
  )
  if (microsoftOAuthConfigured()) {
    lines.push(
      "Outlook: disponível (OAuth Microsoft Graph; Client ID no Infisical)",
    )
  } else {
    lines.push(
      "Outlook: INDISPONÍVEL — cadastre MICROSOFT_CLIENT_ID/SECRET/TENANT_ID no Infisical e use `pnpm dev`",
    )
  }
  if (nonEmpty(config.MCP_NOTION_COMMAND)) {
    lines.push(`Notion stdio debug: ${config.MCP_NOTION_COMMAND}`)
  }
  if (nonEmpty(config.MCP_OUTLOOK_COMMAND)) {
    lines.push(`Outlook stdio debug: ${config.MCP_OUTLOOK_COMMAND}`)
  }
  return lines
}
