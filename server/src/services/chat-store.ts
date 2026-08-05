/**
 * Persistência de chats/mensagens do AgentCore via Supabase (service role).
 * Tabelas (projeto "agentcore"): agent_chats, agent_messages.
 * Toda leitura/escrita por chat exige ownership (user_id) — service_role
 * bypassa RLS, então a checagem é obrigatória no código.
 */
import {
  contentHasDataImage,
  migrateMessageDataImages,
} from "../lib/chat-images.js"
import { supabase } from "../lib/supabase.js"
import { ForbiddenError } from "./auth.js"
import { assertProjectOwnedOrThrow } from "./project-store.js"

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
  /** Só aplica em chat novo; chats existentes mantêm o project_id atual. */
  projectId?: string | null
  /** Modelo (id do catálogo) usado neste run — a conversa fica pinada nele. */
  model?: string
}

export interface InsertMessageParams {
  chatId: string
  userId: string
  role: ChatRole
  content: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  /** Prompt caching da Anthropic: tokens gravados no cache (1,25× o input). */
  tokensCacheWrite?: number
  /** Prompt caching da Anthropic: tokens lidos do cache (0,10× o input). */
  tokensCacheRead?: number
  costUsd?: number | null
  traceId?: string
}

export interface ChatSummary {
  id: string
  title: string | null
  project_id: string | null
  updated_at: string
  model: string | null
  /** Soma de cost_usd das mensagens do chat (USD). Presente em listChats. */
  cost_usd?: number
}

export interface StoredMessage {
  id: string
  role: ChatRole
  content: string
  created_at: string
  model?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  cost_usd?: number | null
}

export interface ChatRow {
  id: string
  user_id: string
  project_id: string | null
  title: string | null
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

/** Retorna o chat com project_id, ou null se inexistente. Anti-IDOR. */
export async function getChat(
  chatId: string,
  userId: string,
): Promise<ChatRow | null> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, user_id, project_id, title")
    .eq("id", chatId)
    .maybeSingle()

  if (error) {
    throw new Error(`getChat falhou: ${error.message}`)
  }
  if (!data) return null
  if (data.user_id !== userId) {
    throw new ForbiddenError("Este chat não pertence ao usuário autenticado.")
  }
  return data as ChatRow
}

/** Upsert do chat por id (threadId gerado pelo front). Bloqueia takeover. */
export async function upsertChat(params: UpsertChatParams): Promise<void> {
  const ownership = await assertChatOwnedOrNew(params.id, params.userId)

  if (
    ownership === "new" &&
    params.projectId !== undefined &&
    params.projectId !== null
  ) {
    await assertProjectOwnedOrThrow(params.projectId, params.userId)
  }

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
  if (params.model !== undefined) row.model = params.model
  // project_id só no insert (chat novo) — evita sobrescrever ao enviar mensagens
  if (ownership === "new" && params.projectId !== undefined) {
    row.project_id = params.projectId
  }

  const { error } = await supabase
    .from("agent_chats")
    .upsert(row, { onConflict: "id" })
  if (error) {
    throw new Error(`upsertChat falhou: ${error.message}`)
  }
}

/** Persiste uma mensagem (usuário ou assistente) de um chat do próprio user.
 * Devolve o id gerado — usado para ligar as tool calls à resposta (auditoria e
 * o histórico de passos exibido na UI). */
export async function insertMessage(params: InsertMessageParams): Promise<string> {
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
  if (params.tokensCacheWrite !== undefined) {
    row.tokens_cache_write = params.tokensCacheWrite
  }
  if (params.tokensCacheRead !== undefined) {
    row.tokens_cache_read = params.tokensCacheRead
  }
  if (params.costUsd !== undefined) row.cost_usd = params.costUsd
  if (params.traceId !== undefined) row.trace_id = params.traceId

  const { data, error } = await supabase
    .from("agent_messages")
    .insert(row)
    .select("id")
    .single()
  if (error) {
    throw new Error(`insertMessage falhou: ${error.message}`)
  }
  return (data as { id: string }).id
}

export interface StoredToolCall {
  id: string
  message_id: string | null
  tool_name: string
  input: unknown
  output: unknown
  status: "ok" | "error"
  duration_ms: number | null
  created_at: string
}

/** Tool calls auditadas de um chat do próprio usuário, em ordem cronológica.
 * É a fonte do histórico de passos ("Ver detalhes") após recarregar a conversa. */
export async function getChatToolCalls(
  chatId: string,
  userId: string,
): Promise<StoredToolCall[]> {
  // user_id na própria tabela — sem assert extra (troca de chat mais leve).
  const { data, error } = await supabase
    .from("agent_tool_calls")
    .select(
      "id, message_id, tool_name, input, output, status, duration_ms, created_at",
    )
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`getChatToolCalls falhou: ${error.message}`)
  }
  return (data ?? []) as StoredToolCall[]
}

async function attachChatCosts(
  userId: string,
  chats: Omit<ChatSummary, "cost_usd">[],
): Promise<ChatSummary[]> {
  if (chats.length === 0) return []
  const { data, error } = await supabase.rpc("dexter_sum_chat_costs", {
    p_user_id: userId,
    p_chat_ids: chats.map((c) => c.id),
  })
  if (error) {
    return chats.map((c) => ({ ...c, cost_usd: 0 }))
  }
  const byId = new Map<string, number>()
  for (const row of data ?? []) {
    byId.set(String(row.chat_id), Number(row.cost_usd ?? 0))
  }
  return chats.map((c) => ({
    ...c,
    cost_usd: byId.get(c.id) ?? 0,
  }))
}

/** Chats do usuário, mais recentes primeiro — para a sidebar. */
export async function listChats(userId: string): Promise<ChatSummary[]> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, title, project_id, updated_at, model")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })

  if (error) {
    throw new Error(`listChats falhou: ${error.message}`)
  }
  return attachChatCosts(
    userId,
    (data ?? []) as Omit<ChatSummary, "cost_usd">[],
  )
}

/** Pina o modelo de UMA conversa (troca feita pelo usuário no seletor). */
export async function setChatModel(
  chatId: string,
  userId: string,
  model: string,
): Promise<ChatSummary | null> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  if (ownership === "new") return null

  const { data, error } = await supabase
    .from("agent_chats")
    .update({ model, updated_at: new Date().toISOString() })
    .eq("id", chatId)
    .eq("user_id", userId)
    .select("id, title, project_id, updated_at, model")
    .single()

  if (error) {
    throw new Error(`setChatModel falhou: ${error.message}`)
  }
  const [withCost] = await attachChatCosts(userId, [
    data as Omit<ChatSummary, "cost_usd">,
  ])
  return withCost ?? null
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
  // 1 round-trip: ownership + mensagens (evita assert + select separados).
  const { data, error } = await supabase
    .from("agent_messages")
    .select(
      "id, role, content, created_at, model, tokens_in, tokens_out, cost_usd, chat:agent_chats!inner(user_id)",
    )
    .eq("chat_id", chatId)
    .eq("chat.user_id", userId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`getMessages falhou: ${error.message}`)
  }

  if (!data || data.length === 0) {
    const ownership = await assertChatOwnedOrNew(chatId, userId)
    if (ownership === "new") return []
    return []
  }

  const rows: StoredMessage[] = data.map((row) => ({
    id: row.id as string,
    role: row.role as ChatRole,
    content: row.content as string,
    created_at: row.created_at as string,
    model: (row.model as string | null) ?? null,
    tokens_in: row.tokens_in != null ? Number(row.tokens_in) : null,
    tokens_out: row.tokens_out != null ? Number(row.tokens_out) : null,
    cost_usd: row.cost_usd != null ? Number(row.cost_usd) : null,
  }))

  for (const row of rows) {
    if (!contentHasDataImage(row.content)) continue
    row.content = await migrateMessageDataImages({
      userId,
      chatId,
      messageId: row.id,
      content: row.content,
    })
  }
  return rows
}


export interface MessagesPage {
  messages: StoredMessage[]
  hasMore: boolean
}

/**
 * Página de mensagens para a UI (mais recentes / mais antigas que `before`).
 * Ordem cronológica no array. `before` = id da mensagem mais antiga já carregada.
 */
export async function getMessagesPage(
  chatId: string,
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<MessagesPage> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100)

  let query = supabase
    .from("agent_messages")
    .select(
      "id, role, content, created_at, model, tokens_in, tokens_out, cost_usd, chat:agent_chats!inner(user_id)",
    )
    .eq("chat_id", chatId)
    .eq("chat.user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1)

  if (opts.before) {
    const { data: cursor, error: cursorError } = await supabase
      .from("agent_messages")
      .select("id, created_at")
      .eq("chat_id", chatId)
      .eq("id", opts.before)
      .maybeSingle()
    if (cursorError) {
      throw new Error(`getMessagesPage (cursor) falhou: ${cursorError.message}`)
    }
    if (!cursor) {
      return { messages: [], hasMore: false }
    }
    query = query.lt("created_at", cursor.created_at as string)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`getMessagesPage falhou: ${error.message}`)
  }

  if (!data || data.length === 0) {
    await assertChatOwnedOrNew(chatId, userId)
    return { messages: [], hasMore: false }
  }

  const hasMore = data.length > limit
  const page = data.slice(0, limit).reverse()
  const rows: StoredMessage[] = page.map((row) => ({
    id: row.id as string,
    role: row.role as ChatRole,
    content: row.content as string,
    created_at: row.created_at as string,
    model: (row.model as string | null) ?? null,
    tokens_in: row.tokens_in != null ? Number(row.tokens_in) : null,
    tokens_out: row.tokens_out != null ? Number(row.tokens_out) : null,
    cost_usd: row.cost_usd != null ? Number(row.cost_usd) : null,
  }))

  for (const row of rows) {
    if (!contentHasDataImage(row.content)) continue
    row.content = await migrateMessageDataImages({
      userId,
      chatId,
      messageId: row.id,
      content: row.content,
    })
  }
  return { messages: rows, hasMore }
}

/** Cauda default — cobre o par user+assistant do último run com folga. */
const TAIL_DEFAULT_LIMIT = 8
/** Acima disso a "cauda" já é histórico — use getMessagesPage. */
export const TAIL_MAX_LIMIT = 40

/**
 * Só o "rabo" da conversa: as últimas `limit` mensagens (ordem cronológica) e
 * `hasMore` = ainda existe histórico antes disso. Serve para ressincronizar
 * ids depois de um run (ou saber se o chat é novo) sem baixar a janela toda.
 * Delega em getMessagesPage sem cursor — mesma query e mesma migração de
 * imagens `data:` que getMessages faz.
 */
export async function getChatTail(
  chatId: string,
  userId: string,
  opts: { limit?: number } = {},
): Promise<MessagesPage> {
  const limit = Math.min(
    Math.max(opts.limit ?? TAIL_DEFAULT_LIMIT, 1),
    TAIL_MAX_LIMIT,
  )
  return getMessagesPage(chatId, userId, { limit })
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
    .select("id, title, project_id, updated_at, model")
    .maybeSingle()

  if (error) {
    throw new Error(`renameChat falhou: ${error.message}`)
  }
  return data as ChatSummary | null
}

/** Move conversa para um projeto (ou remove com null). */
export async function setChatProject(
  chatId: string,
  userId: string,
  projectId: string | null,
): Promise<ChatSummary | null> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  if (ownership === "new") return null

  if (projectId !== null) {
    await assertProjectOwnedOrThrow(projectId, userId)
  }

  const { data, error } = await supabase
    .from("agent_chats")
    .update({
      project_id: projectId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", chatId)
    .eq("user_id", userId)
    .select("id, title, project_id, updated_at, model")
    .maybeSingle()

  if (error) {
    throw new Error(`setChatProject falhou: ${error.message}`)
  }
  return data as ChatSummary | null
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

/**
 * Mantém as primeiras `keepCount` mensagens (ordem cronológica) e apaga o
 * restante. Usado por editar mensagem / regenerar resposta.
 * Chat ainda não persistido ("new") → no-op com sucesso (nada no DB para
 * truncar; o próximo POST /api/chat faz upsert + regenera).
 * keepCount < 0 é tratado como 0.
 */
export async function truncateMessages(
  chatId: string,
  userId: string,
  keepCount: number,
): Promise<boolean> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  // Conversa só existe no client — truncate é no-op; regeneração cria o chat.
  if (ownership === "new") return true

  const messages = await getMessages(chatId, userId)
  const keep = Math.max(0, Math.floor(keepCount))
  if (keep >= messages.length) {
    await supabase
      .from("agent_chats")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", chatId)
      .eq("user_id", userId)
    return true
  }

  const idsToDelete = messages.slice(keep).map((m) => m.id)
  if (idsToDelete.length === 0) return true

  const { error } = await supabase
    .from("agent_messages")
    .delete()
    .eq("chat_id", chatId)
    .in("id", idsToDelete)

  if (error) {
    throw new Error(`truncateMessages falhou: ${error.message}`)
  }

  const { error: touchError } = await supabase
    .from("agent_chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", chatId)
    .eq("user_id", userId)

  if (touchError) {
    throw new Error(`truncateMessages (touch) falhou: ${touchError.message}`)
  }

  return true
}

/**
 * Apaga a mensagem `fromMessageId` e todas as posteriores (ordem cronológica).
 * Usado por editar / retry quando a UI só tem uma janela do histórico.
 */
export async function truncateFromMessageId(
  chatId: string,
  userId: string,
  fromMessageId: string,
): Promise<boolean> {
  const ownership = await assertChatOwnedOrNew(chatId, userId)
  if (ownership === "new") return true

  const { data, error } = await supabase
    .from("agent_messages")
    .select("id, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    throw new Error(`truncateFromMessageId falhou: ${error.message}`)
  }

  const rows = data ?? []
  const idx = rows.findIndex((m) => m.id === fromMessageId)
  if (idx < 0) {
    return false
  }

  const idsToDelete = rows.slice(idx).map((m) => m.id as string)
  if (idsToDelete.length === 0) return true

  const { error: delError } = await supabase
    .from("agent_messages")
    .delete()
    .eq("chat_id", chatId)
    .in("id", idsToDelete)

  if (delError) {
    throw new Error(`truncateFromMessageId (delete) falhou: ${delError.message}`)
  }

  const { error: touchError } = await supabase
    .from("agent_chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", chatId)
    .eq("user_id", userId)

  if (touchError) {
    throw new Error(
      `truncateFromMessageId (touch) falhou: ${touchError.message}`,
    )
  }

  return true
}
