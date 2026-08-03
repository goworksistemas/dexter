/**
 * Chamadas HTTP para os endpoints de conversas do AgentCore.
 * Usa o mesmo caminho relativo `/api` que o `AgentCoreTransport` (proxy do
 * Vite em dev, ver vite.config.ts) e o mesmo esquema de auth (Bearer JWT do
 * Supabase, quando configurado).
 */
import { getAccessToken } from "@/lib/supabase/auth"
import type { AgentStepWire } from "@/lib/agentcore/contract"
import type { ChatMessageRecord, ChatSummary } from "./types"

const BASE_URL = "/api"

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Lista as conversas do usuário (`GET /api/chats`). Lança em caso de erro
 * de rede/HTTP — quem chama decide como tratar. */
export async function fetchChats(signal?: AbortSignal): Promise<ChatSummary[]> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/chats`, {
      headers: await authHeaders(),
      signal,
    })
  } catch {
    throw new Error(
      "AgentCore inacessível. Confirme que o backend está rodando (porta 8787).",
    )
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Sessão inválida. Faça login novamente.")
    }
    throw new Error(`GET /api/chats respondeu ${response.status}`)
  }
  return response.json()
}

/** Histórico de mensagens de uma conversa
 * (`GET /api/chats/:id/messages`). */
export async function fetchChatMessages(
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatMessageRecord[]> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/messages`, {
    headers: await authHeaders(),
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `GET /api/chats/${chatId}/messages respondeu ${response.status} ${response.statusText}`,
    )
  }
  return response.json()
}

export interface ChatStepsRecord {
  /** id da mensagem do assistente que originou os passos. */
  messageId: string
  steps: AgentStepWire[]
}

/**
 * Passos (tool calls) já executados na conversa, agrupados por resposta
 * (`GET /api/chats/:id/steps`). Alimenta o "Ver detalhes" do histórico.
 */
export async function fetchChatSteps(
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatStepsRecord[]> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/steps`, {
    headers: await authHeaders(),
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `GET /api/chats/${chatId}/steps respondeu ${response.status} ${response.statusText}`,
    )
  }
  return response.json()
}

/** Renomeia uma conversa (`PATCH /api/chats/:id`). */
export async function renameChat(
  chatId: string,
  title: string,
): Promise<ChatSummary> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error("Conversa não encontrada.")
    if (response.status === 403) throw new Error("Sem permissão para esta conversa.")
    throw new Error(`PATCH /api/chats/${chatId} respondeu ${response.status}`)
  }
  return response.json()
}

/** Move conversa para um projeto (`projectId` null = sem projeto). */
export async function moveChatToProject(
  chatId: string,
  projectId: string | null,
): Promise<ChatSummary> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ projectId }),
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error("Conversa não encontrada.")
    if (response.status === 403) throw new Error("Sem permissão para esta conversa.")
    throw new Error(`PATCH /api/chats/${chatId} respondeu ${response.status}`)
  }
  return response.json()
}

/** Exclui uma conversa (`DELETE /api/chats/:id`). */
export async function deleteChat(chatId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error("Conversa não encontrada.")
    if (response.status === 403) throw new Error("Sem permissão para esta conversa.")
    throw new Error(`DELETE /api/chats/${chatId} respondeu ${response.status}`)
  }
}

/**
 * Mantém as primeiras `keepCount` mensagens da conversa e apaga o restante
 * (`POST /api/chats/:id/truncate`). Usado por editar / tentar novamente.
 */
export async function truncateChatMessages(
  chatId: string,
  keepCount: number,
): Promise<void> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/truncate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ keepCount }),
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error("Conversa não encontrada.")
    if (response.status === 403) throw new Error("Sem permissão para esta conversa.")
    throw new Error(
      `POST /api/chats/${chatId}/truncate respondeu ${response.status}`,
    )
  }
}
