/**
 * Persistência de artefatos via Supabase (RLS em agent_artifacts).
 */
import { supabase } from "@/lib/supabase/client"
import type { AgentArtifact, ArtifactKind } from "./types"

const SELECT_COLS =
  "id, chat_id, message_id, user_id, kind, title, content, version, source_key, is_truncated, created_at, updated_at"
/** Fallback se a migration 0007 ainda não foi aplicada. */
const SELECT_COLS_LEGACY =
  "id, chat_id, message_id, user_id, kind, title, content, version, source_key, created_at, updated_at"

function normalize(row: Partial<AgentArtifact> & AgentArtifact): AgentArtifact {
  return { ...row, is_truncated: Boolean(row.is_truncated) }
}

function isMissingTruncatedColumn(message: string): boolean {
  return /is_truncated/i.test(message) && /column|does not exist|schema/i.test(message)
}

export async function fetchArtifactsForChat(
  chatId: string,
): Promise<AgentArtifact[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from("agent_artifacts")
    .select(SELECT_COLS)
    .eq("chat_id", chatId)
    .order("updated_at", { ascending: false })

  if (error && isMissingTruncatedColumn(error.message)) {
    const legacy = await supabase
      .from("agent_artifacts")
      .select(SELECT_COLS_LEGACY)
      .eq("chat_id", chatId)
      .order("updated_at", { ascending: false })
    if (legacy.error) throw new Error(legacy.error.message)
    return ((legacy.data ?? []) as AgentArtifact[]).map(normalize)
  }
  if (error) throw new Error(error.message)
  return ((data ?? []) as AgentArtifact[]).map(normalize)
}

/** Todos os artefatos do usuário (RLS filtra por dono) — página /artifacts. */
export async function fetchArtifactsForUser(
  signal?: AbortSignal,
): Promise<AgentArtifact[]> {
  if (!supabase) return []
  let query = supabase
    .from("agent_artifacts")
    .select(SELECT_COLS)
    .order("updated_at", { ascending: false })
    .limit(200)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query
  if (error && isMissingTruncatedColumn(error.message)) {
    let legacyQ = supabase
      .from("agent_artifacts")
      .select(SELECT_COLS_LEGACY)
      .order("updated_at", { ascending: false })
      .limit(200)
    if (signal) legacyQ = legacyQ.abortSignal(signal)
    const legacy = await legacyQ
    if (legacy.error) throw new Error(legacy.error.message)
    return ((legacy.data ?? []) as AgentArtifact[]).map(normalize)
  }
  if (error) throw new Error(error.message)
  return ((data ?? []) as AgentArtifact[]).map(normalize)
}

export async function upsertArtifact(params: {
  chatId: string
  sourceKey: string
  kind: ArtifactKind
  title: string
  content: string
  messageId?: string | null
  isTruncated?: boolean
}): Promise<AgentArtifact> {
  if (!supabase) throw new Error("Supabase não configurado.")
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Sessão inválida.")

  const { data: existing, error: readErr } = await supabase
    .from("agent_artifacts")
    .select("id, version")
    .eq("chat_id", params.chatId)
    .eq("source_key", params.sourceKey)
    .maybeSingle()

  if (readErr) throw new Error(readErr.message)

  const isTruncated = Boolean(params.isTruncated)

  const baseUpdate = {
    content: params.content,
    title: params.title,
    kind: params.kind,
    message_id: params.messageId ?? null,
    version: (existing?.version ?? 1) + (existing?.id ? 1 : 0),
  }

  if (existing?.id) {
    const { data, error } = await supabase
      .from("agent_artifacts")
      .update({ ...baseUpdate, is_truncated: isTruncated })
      .eq("id", existing.id)
      .select(SELECT_COLS)
      .single()
    if (error && isMissingTruncatedColumn(error.message)) {
      const legacy = await supabase
        .from("agent_artifacts")
        .update(baseUpdate)
        .eq("id", existing.id)
        .select(SELECT_COLS_LEGACY)
        .single()
      if (legacy.error) throw new Error(legacy.error.message)
      return normalize(legacy.data as AgentArtifact)
    }
    if (error) throw new Error(error.message)
    return normalize(data as AgentArtifact)
  }

  const { data, error } = await supabase
    .from("agent_artifacts")
    .insert({
      chat_id: params.chatId,
      user_id: user.id,
      source_key: params.sourceKey,
      kind: params.kind,
      title: params.title,
      content: params.content,
      message_id: params.messageId ?? null,
      version: 1,
      is_truncated: isTruncated,
    })
    .select(SELECT_COLS)
    .single()

  if (error && isMissingTruncatedColumn(error.message)) {
    const legacy = await supabase
      .from("agent_artifacts")
      .insert({
        chat_id: params.chatId,
        user_id: user.id,
        source_key: params.sourceKey,
        kind: params.kind,
        title: params.title,
        content: params.content,
        message_id: params.messageId ?? null,
        version: 1,
      })
      .select(SELECT_COLS_LEGACY)
      .single()
    if (legacy.error) throw new Error(legacy.error.message)
    return normalize(legacy.data as AgentArtifact)
  }
  if (error) throw new Error(error.message)
  return normalize(data as AgentArtifact)
}

/** Marca artefato existente como truncado (não apaga o dado do usuário). */
export async function markArtifactTruncated(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from("agent_artifacts")
    .update({ is_truncated: true })
    .eq("id", id)
  if (error) console.warn("markArtifactTruncated:", error.message)
}
