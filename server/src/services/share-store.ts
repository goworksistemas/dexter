/**
 * Publicação e revogação de links públicos (chats + artefatos).
 * Leitura anônima só pelas rotas /api/public/* — service role, sem RLS anon.
 */
import { randomUUID } from "node:crypto"

import { supabase } from "../lib/supabase.js"
import { ForbiddenError, NotFoundError } from "./auth.js"

const PUBLIC_CHAT_MESSAGE_LIMIT = 200
const PUBLIC_ARTIFACT_MAX_CHARS = 512_000

export interface ShareLinkStatus {
  shared: boolean
  shareToken: string | null
  sharedAt: string | null
}

export interface PublicChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
}

export interface PublicChatPayload {
  title: string | null
  sharedAt: string
  messages: PublicChatMessage[]
}

export interface PublicArtifactPayload {
  title: string
  kind: "html" | "markdown"
  content: string
  version: number
  sharedAt: string
}

async function assertChatOwned(chatId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("id, user_id")
    .eq("id", chatId)
    .maybeSingle()

  if (error) {
    throw new Error(`assertChatOwned falhou: ${error.message}`)
  }
  if (!data) throw new NotFoundError("Conversa não encontrada.")
  if (data.user_id !== userId) throw new ForbiddenError("Acesso negado.")
}

async function assertArtifactOwned(
  artifactId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("agent_artifacts")
    .select("id, user_id")
    .eq("id", artifactId)
    .maybeSingle()

  if (error) {
    throw new Error(`assertArtifactOwned falhou: ${error.message}`)
  }
  if (!data) throw new NotFoundError("Artefato não encontrado.")
  if (data.user_id !== userId) throw new ForbiddenError("Acesso negado.")
}

function toShareStatus(row: {
  share_token: string | null
  shared_at: string | null
}): ShareLinkStatus {
  return {
    shared: Boolean(row.share_token),
    shareToken: row.share_token,
    sharedAt: row.shared_at,
  }
}

export async function getChatShareStatus(
  chatId: string,
  userId: string,
): Promise<ShareLinkStatus> {
  await assertChatOwned(chatId, userId)
  const { data, error } = await supabase
    .from("agent_chats")
    .select("share_token, shared_at")
    .eq("id", chatId)
    .single()

  if (error) {
    throw new Error(`getChatShareStatus falhou: ${error.message}`)
  }
  return toShareStatus(data)
}

export async function publishChat(
  chatId: string,
  userId: string,
): Promise<ShareLinkStatus> {
  await assertChatOwned(chatId, userId)

  const { data: existing, error: readErr } = await supabase
    .from("agent_chats")
    .select("share_token, shared_at")
    .eq("id", chatId)
    .single()

  if (readErr) {
    throw new Error(`publishChat read falhou: ${readErr.message}`)
  }

  if (existing.share_token) {
    return toShareStatus(existing)
  }

  const token = randomUUID()
  const sharedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from("agent_chats")
    .update({ share_token: token, shared_at: sharedAt })
    .eq("id", chatId)
    .select("share_token, shared_at")
    .single()

  if (error) {
    throw new Error(`publishChat update falhou: ${error.message}`)
  }
  return toShareStatus(data)
}

export async function revokeChatShare(
  chatId: string,
  userId: string,
): Promise<ShareLinkStatus> {
  await assertChatOwned(chatId, userId)

  const { error } = await supabase
    .from("agent_chats")
    .update({ share_token: null, shared_at: null })
    .eq("id", chatId)

  if (error) {
    throw new Error(`revokeChatShare falhou: ${error.message}`)
  }
  return { shared: false, shareToken: null, sharedAt: null }
}

export async function getArtifactShareStatus(
  artifactId: string,
  userId: string,
): Promise<ShareLinkStatus> {
  await assertArtifactOwned(artifactId, userId)
  const { data, error } = await supabase
    .from("agent_artifacts")
    .select("share_token, shared_at")
    .eq("id", artifactId)
    .single()

  if (error) {
    throw new Error(`getArtifactShareStatus falhou: ${error.message}`)
  }
  return toShareStatus(data)
}

export async function publishArtifact(
  artifactId: string,
  userId: string,
): Promise<ShareLinkStatus> {
  await assertArtifactOwned(artifactId, userId)

  const { data: existing, error: readErr } = await supabase
    .from("agent_artifacts")
    .select("share_token, shared_at")
    .eq("id", artifactId)
    .single()

  if (readErr) {
    throw new Error(`publishArtifact read falhou: ${readErr.message}`)
  }

  if (existing.share_token) {
    return toShareStatus(existing)
  }

  const token = randomUUID()
  const sharedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from("agent_artifacts")
    .update({ share_token: token, shared_at: sharedAt })
    .eq("id", artifactId)
    .select("share_token, shared_at")
    .single()

  if (error) {
    throw new Error(`publishArtifact update falhou: ${error.message}`)
  }
  return toShareStatus(data)
}

export async function revokeArtifactShare(
  artifactId: string,
  userId: string,
): Promise<ShareLinkStatus> {
  await assertArtifactOwned(artifactId, userId)

  const { error } = await supabase
    .from("agent_artifacts")
    .update({ share_token: null, shared_at: null })
    .eq("id", artifactId)

  if (error) {
    throw new Error(`revokeArtifactShare falhou: ${error.message}`)
  }
  return { shared: false, shareToken: null, sharedAt: null }
}

export async function getPublicChat(
  token: string,
): Promise<PublicChatPayload | null> {
  const { data: chat, error: chatErr } = await supabase
    .from("agent_chats")
    .select("id, title, shared_at")
    .eq("share_token", token)
    .maybeSingle()

  if (chatErr) {
    throw new Error(`getPublicChat chat falhou: ${chatErr.message}`)
  }
  if (!chat?.shared_at) return null

  const { data: rows, error: msgErr } = await supabase
    .from("agent_messages")
    .select("id, role, content, created_at")
    .eq("chat_id", chat.id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true })
    .limit(PUBLIC_CHAT_MESSAGE_LIMIT)

  if (msgErr) {
    throw new Error(`getPublicChat messages falhou: ${msgErr.message}`)
  }

  const messages: PublicChatMessage[] = (rows ?? [])
    .filter(
      (r): r is typeof r & { role: "user" | "assistant" } =>
        r.role === "user" || r.role === "assistant",
    )
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }))

  return {
    title: chat.title,
    sharedAt: chat.shared_at,
    messages,
  }
}

export async function getPublicArtifact(
  token: string,
): Promise<PublicArtifactPayload | null> {
  const { data, error } = await supabase
    .from("agent_artifacts")
    .select("title, kind, content, version, shared_at")
    .eq("share_token", token)
    .maybeSingle()

  if (error) {
    throw new Error(`getPublicArtifact falhou: ${error.message}`)
  }
  if (!data?.shared_at) return null

  const content =
    data.content.length > PUBLIC_ARTIFACT_MAX_CHARS
      ? `${data.content.slice(0, PUBLIC_ARTIFACT_MAX_CHARS)}\n\n… (conteúdo truncado na visualização pública)`
      : data.content

  const kind = data.kind === "html" ? "html" : "markdown"

  return {
    title: data.title,
    kind,
    content,
    version: data.version ?? 1,
    sharedAt: data.shared_at,
  }
}
