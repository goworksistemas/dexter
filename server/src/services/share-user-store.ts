/**
 * Compartilhamento de conversa com outro usuário Dexter (invite → fork).
 */
import { randomUUID } from "node:crypto"

import { normalizeEmail } from "../lib/email-domain.js"
import { supabase } from "../lib/supabase.js"
import { ForbiddenError, NotFoundError } from "./auth.js"

const FORK_MESSAGE_LIMIT = 500

function badRequest(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { statusCode: number }).statusCode = 400
  return err
}

export interface ChatUserShare {
  id: string
  chatId: string
  chatTitle: string | null
  fromUserId: string
  fromName: string | null
  fromEmail: string | null
  toUserId: string
  toName: string | null
  toEmail: string | null
  status: "pending" | "forked" | "revoked"
  forkedChatId: string | null
  createdAt: string
}

async function assertChatOwned(
  chatId: string,
  userId: string,
): Promise<{ id: string; title: string | null; agent: string; channel: string; model: string | null }> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, user_id, title, agent, channel, model")
    .eq("id", chatId)
    .maybeSingle()

  if (error) throw new Error(`assertChatOwned falhou: ${error.message}`)
  if (!data) throw new NotFoundError("Conversa não encontrada.")
  if (data.user_id !== userId) throw new ForbiddenError("Acesso negado.")
  return {
    id: data.id as string,
    title: (data.title as string | null) ?? null,
    agent: String(data.agent ?? "dexter"),
    channel: String(data.channel ?? "web"),
    model: (data.model as string | null) ?? null,
  }
}

async function findActiveProfileByEmail(email: string): Promise<{
  id: string
  email: string | null
  full_name: string | null
} | null> {
  const normalized = normalizeEmail(email)
  if (!normalized.includes("@")) return null

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, disabled_at")
    .ilike("email", normalized)
    .maybeSingle()

  if (error) throw new Error(`findActiveProfileByEmail: ${error.message}`)
  if (!data || data.disabled_at) return null
  return {
    id: String(data.id),
    email: (data.email as string | null) ?? null,
    full_name: (data.full_name as string | null) ?? null,
  }
}

function mapShareRow(
  row: Record<string, unknown>,
  extras?: {
    chatTitle?: string | null
    fromName?: string | null
    fromEmail?: string | null
    toName?: string | null
    toEmail?: string | null
  },
): ChatUserShare {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    chatTitle: extras?.chatTitle ?? null,
    fromUserId: String(row.from_user_id),
    fromName: extras?.fromName ?? null,
    fromEmail: extras?.fromEmail ?? null,
    toUserId: String(row.to_user_id),
    toName: extras?.toName ?? null,
    toEmail: extras?.toEmail ?? null,
    status: row.status as ChatUserShare["status"],
    forkedChatId: (row.forked_chat_id as string | null) ?? null,
    createdAt: String(row.created_at),
  }
}

async function profileMap(
  ids: string[],
): Promise<Map<string, { email: string | null; full_name: string | null }>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, { email: string | null; full_name: string | null }>()
  if (unique.length === 0) return map
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .in("id", unique)
  if (error) throw new Error(`profileMap: ${error.message}`)
  for (const row of data ?? []) {
    map.set(String(row.id), {
      email: (row.email as string | null) ?? null,
      full_name: (row.full_name as string | null) ?? null,
    })
  }
  return map
}

async function chatTitleMap(
  ids: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, string | null>()
  if (unique.length === 0) return map
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, title")
    .in("id", unique)
  if (error) throw new Error(`chatTitleMap: ${error.message}`)
  for (const row of data ?? []) {
    map.set(String(row.id), (row.title as string | null) ?? null)
  }
  return map
}

export interface ShareableColleague {
  id: string
  email: string | null
  fullName: string | null
  avatarUrl: string | null
}

/** Usuários Dexter ativos com quem dá pra compartilhar (exceto o próprio). */
export async function listShareableColleagues(
  actorUserId: string,
): Promise<ShareableColleague[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, disabled_at")
    .is("disabled_at", null)

  if (error) throw new Error(`listShareableColleagues: ${error.message}`)

  return (data ?? [])
    .filter((row) => String(row.id) !== actorUserId)
    .map((row) => ({
      id: String(row.id),
      email: (row.email as string | null) ?? null,
      fullName: (row.full_name as string | null) ?? null,
      avatarUrl: (row.avatar_url as string | null) ?? null,
    }))
    .sort((a, b) => {
      const an = (a.fullName || a.email || "").toLocaleLowerCase("pt-BR")
      const bn = (b.fullName || b.email || "").toLocaleLowerCase("pt-BR")
      return an.localeCompare(bn, "pt-BR")
    })
}

async function findActiveProfileById(userId: string): Promise<{
  id: string
  email: string | null
  full_name: string | null
} | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, disabled_at")
    .eq("id", userId)
    .maybeSingle()
  if (error) throw new Error(`findActiveProfileById: ${error.message}`)
  if (!data || data.disabled_at) return null
  return {
    id: String(data.id),
    email: (data.email as string | null) ?? null,
    full_name: (data.full_name as string | null) ?? null,
  }
}

/** Dono convida colega por userId ou e-mail. */
export async function inviteChatShare(
  chatId: string,
  fromUserId: string,
  target: { userId?: string; email?: string },
): Promise<ChatUserShare> {
  await assertChatOwned(chatId, fromUserId)

  let to: { id: string; email: string | null; full_name: string | null } | null =
    null
  if (target.userId) {
    to = await findActiveProfileById(target.userId)
  } else if (target.email) {
    to = await findActiveProfileByEmail(target.email)
  }
  if (!to) {
    throw badRequest(
      "Não encontramos um usuário Dexter ativo com este e-mail.",
    )
  }
  if (to.id === fromUserId) {
    throw badRequest("Você não pode compartilhar a conversa consigo mesmo.")
  }

  const { data: existing } = await supabase
    .from("agent_chat_user_shares")
    .select("id, status")
    .eq("chat_id", chatId)
    .eq("to_user_id", to.id)
    .eq("status", "pending")
    .maybeSingle()

  if (existing) {
    throw badRequest("Este usuário já tem um convite pendente para esta conversa.")
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("agent_chat_user_shares")
    .insert({
      chat_id: chatId,
      from_user_id: fromUserId,
      to_user_id: to.id,
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    .select("id, chat_id, from_user_id, to_user_id, status, forked_chat_id, created_at")
    .single()

  if (error || !data) {
    throw new Error(`inviteChatShare: ${error?.message ?? "sem retorno"}`)
  }

  const fromProfiles = await profileMap([fromUserId])
  const from = fromProfiles.get(fromUserId)
  const titles = await chatTitleMap([chatId])

  return mapShareRow(data as Record<string, unknown>, {
    chatTitle: titles.get(chatId) ?? null,
    fromName: from?.full_name ?? null,
    fromEmail: from?.email ?? null,
    toName: to.full_name,
    toEmail: to.email,
  })
}

/** Convites enviados pelo dono nesta conversa. */
export async function listChatSharesForOwner(
  chatId: string,
  userId: string,
): Promise<ChatUserShare[]> {
  await assertChatOwned(chatId, userId)

  const { data, error } = await supabase
    .from("agent_chat_user_shares")
    .select("id, chat_id, from_user_id, to_user_id, status, forked_chat_id, created_at")
    .eq("chat_id", chatId)
    .eq("from_user_id", userId)
    .neq("status", "revoked")
    .order("created_at", { ascending: false })

  if (error) throw new Error(`listChatSharesForOwner: ${error.message}`)
  const rows = data ?? []
  const profiles = await profileMap(rows.map((r) => String(r.to_user_id)))
  const titles = await chatTitleMap([chatId])
  const title = titles.get(chatId) ?? null

  return rows.map((row) => {
    const to = profiles.get(String(row.to_user_id))
    return mapShareRow(row as Record<string, unknown>, {
      chatTitle: title,
      toName: to?.full_name ?? null,
      toEmail: to?.email ?? null,
    })
  })
}

/** Convites pendentes recebidos pelo usuário. */
export async function listPendingSharesForUser(
  userId: string,
): Promise<ChatUserShare[]> {
  const { data, error } = await supabase
    .from("agent_chat_user_shares")
    .select("id, chat_id, from_user_id, to_user_id, status, forked_chat_id, created_at")
    .eq("to_user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })

  if (error) throw new Error(`listPendingSharesForUser: ${error.message}`)
  const rows = data ?? []
  if (rows.length === 0) return []

  const profiles = await profileMap(rows.map((r) => String(r.from_user_id)))
  const titles = await chatTitleMap(rows.map((r) => String(r.chat_id)))

  return rows.map((row) => {
    const from = profiles.get(String(row.from_user_id))
    return mapShareRow(row as Record<string, unknown>, {
      chatTitle: titles.get(String(row.chat_id)) ?? null,
      fromName: from?.full_name ?? null,
      fromEmail: from?.email ?? null,
    })
  })
}

/** Dono ou destinatário revoga/recusa convite pendente. */
export async function revokeUserShare(
  shareId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("agent_chat_user_shares")
    .select("id, from_user_id, to_user_id, status")
    .eq("id", shareId)
    .maybeSingle()

  if (error) throw new Error(`revokeUserShare read: ${error.message}`)
  if (!data) throw new NotFoundError("Convite não encontrado.")
  if (data.from_user_id !== userId && data.to_user_id !== userId) {
    throw new ForbiddenError("Acesso negado.")
  }
  if (data.status !== "pending") {
    throw badRequest("Só é possível revogar convites pendentes.")
  }

  const { error: updErr } = await supabase
    .from("agent_chat_user_shares")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", shareId)

  if (updErr) throw new Error(`revokeUserShare update: ${updErr.message}`)
}

/**
 * Destinatário cria uma cópia própria (fork) da conversa compartilhada.
 * Copia mensagens user/assistant; a conversa original permanece do dono.
 */
export async function forkSharedChat(
  shareId: string,
  userId: string,
): Promise<{ chatId: string; share: ChatUserShare }> {
  const { data: share, error } = await supabase
    .from("agent_chat_user_shares")
    .select("id, chat_id, from_user_id, to_user_id, status, forked_chat_id, created_at")
    .eq("id", shareId)
    .maybeSingle()

  if (error) throw new Error(`forkSharedChat read: ${error.message}`)
  if (!share) throw new NotFoundError("Convite não encontrado.")
  if (share.to_user_id !== userId) throw new ForbiddenError("Acesso negado.")
  if (share.status === "forked" && share.forked_chat_id) {
    return {
      chatId: String(share.forked_chat_id),
      share: mapShareRow(share as Record<string, unknown>),
    }
  }
  if (share.status !== "pending") {
    throw badRequest("Este convite não está mais disponível para fork.")
  }

  const sourceId = String(share.chat_id)
  const { data: source, error: srcErr } = await supabase
    .from("agent_chats")
    .select("id, title, agent, channel, model, user_id")
    .eq("id", sourceId)
    .maybeSingle()

  if (srcErr) throw new Error(`forkSharedChat source: ${srcErr.message}`)
  if (!source || source.user_id !== share.from_user_id) {
    throw new NotFoundError("A conversa original não está mais disponível.")
  }

  const { data: messages, error: msgErr } = await supabase
    .from("agent_messages")
    .select("role, content, model, created_at")
    .eq("chat_id", sourceId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true })
    .limit(FORK_MESSAGE_LIMIT)

  if (msgErr) throw new Error(`forkSharedChat messages: ${msgErr.message}`)

  const newChatId = randomUUID()
  const baseTitle = (source.title as string | null)?.trim() || "Conversa sem título"
  const title = `Cópia: ${baseTitle}`.slice(0, 120)
  const now = new Date().toISOString()

  const { error: chatErr } = await supabase.from("agent_chats").insert({
    id: newChatId,
    user_id: userId,
    agent: source.agent ?? "dexter",
    channel: source.channel ?? "web",
    title,
    model: source.model ?? null,
    created_at: now,
    updated_at: now,
    metadata: {
      forked_from_chat_id: sourceId,
      forked_from_share_id: shareId,
    },
  })

  if (chatErr) throw new Error(`forkSharedChat insert chat: ${chatErr.message}`)

  const rows = (messages ?? []).map((m) => ({
    chat_id: newChatId,
    role: m.role,
    content: m.content ?? "",
    model: m.model ?? null,
    created_at: m.created_at,
  }))

  if (rows.length > 0) {
    const { error: insMsgErr } = await supabase.from("agent_messages").insert(rows)
    if (insMsgErr) {
      await supabase.from("agent_chats").delete().eq("id", newChatId)
      throw new Error(`forkSharedChat insert messages: ${insMsgErr.message}`)
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from("agent_chat_user_shares")
    .update({
      status: "forked",
      forked_chat_id: newChatId,
      updated_at: now,
    })
    .eq("id", shareId)
    .eq("status", "pending")
    .select("id, chat_id, from_user_id, to_user_id, status, forked_chat_id, created_at")
    .maybeSingle()

  if (updErr || !updated) {
    // Race: outro fork ganhou — limpa a cópia órfã se necessário
    await supabase.from("agent_chats").delete().eq("id", newChatId)
    throw badRequest("Não foi possível concluir o fork. Tente novamente.")
  }

  const profiles = await profileMap([
    String(updated.from_user_id),
    String(updated.to_user_id),
  ])
  const from = profiles.get(String(updated.from_user_id))
  const to = profiles.get(String(updated.to_user_id))

  return {
    chatId: newChatId,
    share: mapShareRow(updated as Record<string, unknown>, {
      chatTitle: baseTitle,
      fromName: from?.full_name ?? null,
      fromEmail: from?.email ?? null,
      toName: to?.full_name ?? null,
      toEmail: to?.email ?? null,
    }),
  }
}
