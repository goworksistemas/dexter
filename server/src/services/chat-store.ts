/**
 * Persistência de chats/mensagens do AgentCore via Supabase (service role).
 * Tabelas (projeto "agentcore"): agent_chats, agent_messages.
 * Toda leitura/escrita por chat exige ownership (user_id) — service_role
 * bypassa RLS, então a checagem é obrigatória no código.
 */
import { supabase } from "../lib/supabase.js"
import { ForbiddenError } from "./auth.js"

export type ChatRole = "user" | "assistant" | "system"

export interface UpsertChatParams {
  /** agent_chats.id — o mesmo UUID que o front usa como threadId. */
  id: string
  userId: string
  agent: string
  channel: string
  system?: string
  tenantId?: string
  /** Só passe em chats novos (1ª mensagem) — não sobrescreve título existente. */
  title?: string
}

export interface InsertMessageParams {
  chatId: string
  userId: string
  role: ChatRole
  content: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  traceId?: string
}

export interface ChatSummary {
  id: string
  title: string | null
  updated_at: string
}

export interface StoredMessage {
  id: string
  role: ChatRole
  content: string
  created_at: string
}

/** Garante que o chat existe e pertence ao userId. Chat inexistente = ok (novo). */
async function assertChatOwnedOrNew(
  chatId: string,
  userId: string,
): Promise<"new" | "owned"> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, user_id")
    .eq("id", chatId)
    .maybeSingle()

  if (error) {
    throw new Error(`assertChatOwnedOrNew falhou: ${error.message}`)
  }
  if (!data) return "new"
  if (data.user_id !== userId) {
    throw new ForbiddenError("Este chat não pertence ao usuário autenticado.")
  }
  return "owned"
}

/** Upsert do chat por id (threadId gerado pelo front). Bloqueia takeover. */
export async function upsertChat(params: UpsertChatParams): Promise<void> {
  await assertChatOwnedOrNew(params.id, params.userId)

  const row: Record<string, unknown> = {
    id: params.id,
    user_id: params.userId,
    agent: params.agent,
    channel: params.channel,
    updated_at: new Date().toISOString(),
  }
  if (params.system !== undefined) row.system = params.system
  if (params.tenantId !== undefined) row.tenant_id = params.tenantId
  if (params.title !== undefined) row.title = params.title

  const { error } = await supabase
    .from("agent_chats")
    .upsert(row, { onConflict: "id" })
  if (error) {
    throw new Error(`upsertChat falhou: ${error.message}`)
  }
}

/** Persiste uma mensagem (usuário ou assistente) de um chat do próprio user. */
export async function insertMessage(params: InsertMessageParams): Promise<void> {
  const ownership = await assertChatOwnedOrNew(params.chatId, params.userId)
  if (ownership === "new") {
    throw new ForbiddenError("Chat inexistente — faça upsert do chat antes.")
  }

  const row: Record<string, unknown> = {
    chat_id: params.chatId,
    role: params.role,
    content: params.content,
  }
  if (params.model !== undefined) row.model = params.model
  if (params.tokensIn !== undefined) row.tokens_in = params.tokensIn
  if (params.tokensOut !== undefined) row.tokens_out = params.tokensOut
  if (params.traceId !== undefined) row.trace_id = params.traceId

  const { error } = await supabase.from("agent_messages").insert(row)
  if (error) {
    throw new Error(`insertMessage falhou: ${error.message}`)
  }
}

/** Chats do usuário, mais recentes primeiro — para a sidebar. */
export async function listChats(userId: string): Promise<ChatSummary[]> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, title, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })

  if (error) {
    throw new Error(`listChats falhou: ${error.message}`)
  }
  return data ?? []
}

/**
 * Mensagens de um chat em ordem cronológica.
 * - Chat inexistente → [] (conversa nova)
 * - Chat de outro usuário → ForbiddenError (anti-IDOR)
 */
export async function getMessages(
  chatId: string,
  userId: string,
): Promise<StoredMessage[]> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  if (ownership === "new") return []

  const { data, error } = await supabase
    .from("agent_messages")
    .select("id, role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`getMessages falhou: ${error.message}`)
  }
  return (data ?? []) as StoredMessage[]
}

/** Renomeia um chat do próprio usuário. Chat inexistente → null. */
export async function renameChat(
  chatId: string,
  userId: string,
  title: string,
): Promise<ChatSummary | null> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  if (ownership === "new") return null

  const trimmed = title.trim()
  const { data, error } = await supabase
    .from("agent_chats")
    .update({ title: trimmed, updated_at: new Date().toISOString() })
    .eq("id", chatId)
    .eq("user_id", userId)
    .select("id, title, updated_at")
    .maybeSingle()

  if (error) {
    throw new Error(`renameChat falhou: ${error.message}`)
  }
  return data
}

/** Exclui um chat do próprio usuário (cascade em agent_messages). Chat inexistente → false. */
export async function deleteChat(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  if (ownership === "new") return false

  const { error, count } = await supabase
    .from("agent_chats")
    .delete({ count: "exact" })
    .eq("id", chatId)
    .eq("user_id", userId)

  if (error) {
    throw new Error(`deleteChat falhou: ${error.message}`)
  }
  return (count ?? 0) > 0
}

