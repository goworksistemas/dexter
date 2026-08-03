// Tipos de app compartilhados pelo Dexter. NÃO duplica o contrato de
// transporte, que vive em `@/lib/agentcore/contract` (ChatMessage,
// ChatRequest, ChatStreamChunk, etc.) — importe de lá quando precisar.

/** Uma conversa/thread do Dexter (metadados; as mensagens em si usam
 * `ChatMessage` do contrato do AgentCore). */
export interface Thread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** slug do sistema associado à thread, ex.: "networkgo", "pipego". */
  system?: string
}

export type ThemePreference = "light" | "dark" | "system"

export interface UserPreferences {
  theme?: ThemePreference
  /** Sidebar desktop em modo compacto (só ícones). */
  sidebarCollapsed?: boolean
}

/** Perfil do usuário autenticado, derivado da sessão Supabase + profiles. */
export interface UserProfile {
  id: string
  email: string | null
  name?: string
  avatarUrl?: string
  preferences?: UserPreferences
}
