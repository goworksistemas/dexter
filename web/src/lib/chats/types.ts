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
}

export interface ChatMessageRecord {
  id: string
  role: ChatRole
  content: string
  created_at: string
}
