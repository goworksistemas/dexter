/**
 * Persistência de artefatos via Supabase (RLS em agent_artifacts).
 */
import type { SupabaseClient } from "@supabase/supabase-js"

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

export async function fetchArtifactById(
  id: string,
): Promise<AgentArtifact | null> {
  if (!supabase || !id) return null
  const { data, error } = await supabase
    .from("agent_artifacts")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle()

  if (error && isMissingTruncatedColumn(error.message)) {
    const legacy = await supabase
      .from("agent_artifacts")
      .select(SELECT_COLS_LEGACY)
      .eq("id", id)
      .maybeSingle()
    if (legacy.error) throw new Error(legacy.error.message)
    return legacy.data
      ? normalize(legacy.data as AgentArtifact)
      : null
  }
  if (error) throw new Error(error.message)
  return data ? normalize(data as AgentArtifact) : null
}

export async function fetchArtifactsForChat(
  chatId: string,
  signal?: AbortSignal,
): Promise<AgentArtifact[]> {
  if (!supabase) return []
  let query = supabase
    .from("agent_artifacts")
    .select(SELECT_COLS)
    .eq("chat_id", chatId)
    .order("updated_at", { ascending: false })
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query
  if (error && isMissingTruncatedColumn(error.message)) {
    let legacyQ = supabase
      .from("agent_artifacts")
      .select(SELECT_COLS_LEGACY)
      .eq("chat_id", chatId)
      .order("updated_at", { ascending: false })
    if (signal) legacyQ = legacyQ.abortSignal(signal)
    const legacy = await legacyQ
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

export interface UpsertArtifactInput {
  chatId: string
  sourceKey: string
  kind: ArtifactKind
  title: string
  content: string
  messageId?: string | null
  isTruncated?: boolean
}

/** Violação da unique (chat_id, source_key) — dois inserts concorrentes. */
function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "23505" ||
    /duplicate key|already exists/i.test(error.message ?? "")
  )
}

async function readArtifactRow(
  db: SupabaseClient,
  chatId: string,
  sourceKey: string,
): Promise<{ id: string; version: number } | null> {
  const { data, error } = await db
    .from("agent_artifacts")
    .select("id, version")
    .eq("chat_id", chatId)
    .eq("source_key", sourceKey)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { id: string; version: number } | null) ?? null
}

async function updateArtifactRow(
  db: SupabaseClient,
  existing: { id: string; version: number },
  params: UpsertArtifactInput,
): Promise<AgentArtifact> {
  const baseUpdate = {
    content: params.content,
    title: params.title,
    kind: params.kind,
    message_id: params.messageId ?? null,
    version: (existing.version ?? 1) + 1,
  }

  const { data, error } = await db
    .from("agent_artifacts")
    .update({ ...baseUpdate, is_truncated: Boolean(params.isTruncated) })
    .eq("id", existing.id)
    .select(SELECT_COLS)
    .single()
  if (error && isMissingTruncatedColumn(error.message)) {
    const legacy = await db
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

/** Insert perdeu a corrida: relê a linha do vencedor e segue pelo update. */
async function updateAfterConflict(
  db: SupabaseClient,
  params: UpsertArtifactInput,
): Promise<AgentArtifact> {
  const existing = await readArtifactRow(db, params.chatId, params.sourceKey)
  if (!existing?.id) {
    throw new Error("Não foi possível salvar o artefato (conflito de gravação).")
  }
  return updateArtifactRow(db, existing, params)
}

export async function upsertArtifact(
  params: UpsertArtifactInput,
): Promise<AgentArtifact> {
  if (!supabase) throw new Error("Supabase não configurado.")
  const db = supabase
  // Sessão local (o client já faz auto-refresh) — evita um round-trip ao
  // /auth/v1/user a cada save, que virava falha extra com rede instável.
  const { data: sessionData } = await db.auth.getSession()
  const userId = sessionData.session?.user.id
  if (!userId) throw new Error("Sessão inválida.")

  const existing = await readArtifactRow(db, params.chatId, params.sourceKey)
  if (existing?.id) return updateArtifactRow(db, existing, params)

  const insertRow = {
    chat_id: params.chatId,
    user_id: userId,
    source_key: params.sourceKey,
    kind: params.kind,
    title: params.title,
    content: params.content,
    message_id: params.messageId ?? null,
    version: 1,
  }

  const { data, error } = await db
    .from("agent_artifacts")
    .insert({ ...insertRow, is_truncated: Boolean(params.isTruncated) })
    .select(SELECT_COLS)
    .single()

  if (error && isMissingTruncatedColumn(error.message)) {
    const legacy = await db
      .from("agent_artifacts")
      .insert(insertRow)
      .select(SELECT_COLS_LEGACY)
      .single()
    if (legacy.error) {
      if (isUniqueViolation(legacy.error)) return updateAfterConflict(db, params)
      throw new Error(legacy.error.message)
    }
    return normalize(legacy.data as AgentArtifact)
  }
  if (error) {
    if (isUniqueViolation(error)) return updateAfterConflict(db, params)
    throw new Error(error.message)
  }
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
