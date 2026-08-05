/**
 * Tipos do estado de conversas real do Dexter (sem mock) — espelham o que o
 * AgentCore devolve em `GET /api/chats` e `GET /api/chats/:id/messages`.
 */
import type { ChatRole } from "@/lib/agentcore/contract"

export interface ChatSummary {
  id: string
  title: string | null
  project_id: string | null
  updated_at: string
  /** Modelo pinado nesta conversa (id do catálogo) — null segue o default. */
  model: string | null
  /** Conversa arquivada (seção "Arquivadas"); null/ausente = ativa. */
  archived_at?: string | null
  /** Soma do custo das mensagens (USD). */
  cost_usd?: number
}

export interface ChatMessageRecord {
  id: string
  role: ChatRole
  content: string
  created_at: string
  model?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  cost_usd?: number | null
}
