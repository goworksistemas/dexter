/** Conectores externos (Notion / Outlook) — OAuth por usuário + preferência. */

export type ConnectorId = "notion" | "outlook"

export interface ConnectorPreferences {
  notion?: boolean
  outlook?: boolean
}

/**
 * Como a app autentica o usuário neste conector.
 * - mcp_oauth: Notion MCP remoto (DCR+PKCE), sem Client ID no vault
 * - oauth_user: app OAuth clássica (Microsoft) cadastrada no Infisical
 */
export type ConnectorAuthMode =
  | "mcp_oauth"
  | "oauth_user"
  | "workspace_token_fallback"
  | "mcp_stdio"
  | "unconfigured"

/** Runtime de tools: mcp = HTTP remoto; mcp_stdio = subprocesso; rest = Graph/API. */
export type ConnectorRuntimeMode = "mcp" | "mcp_stdio" | "rest" | "none"

export interface ConnectorStatus {
  id: ConnectorId
  label: string
  /** Conector pode ser usado neste ambiente (sem “Indisponível”). */
  configured: boolean
  /** Usuário concluiu OAuth e tem token na tabela. */
  connected: boolean
  /** Preferência do usuário (só efetiva se connected). */
  enabled: boolean
  authMode: ConnectorAuthMode
  runtimeMode: ConnectorRuntimeMode
  /** Mensagem curta para a UI (sem secrets). */
  detail: string
  /** Metadados seguros (workspace name, etc.) — sem tokens. */
  meta?: Record<string, unknown>
}

export interface ConnectorRuntime {
  /** ids habilitados: configured && connected && enabled. */
  active: Set<ConnectorId>
  prefs: ConnectorPreferences
  statuses: ConnectorStatus[]
}
