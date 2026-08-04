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

export interface ChatMessagesPage {
  messages: ChatMessageRecord[]
  hasMore: boolean
}

export interface FetchChatMessagesOpts {
  signal?: AbortSignal
  /** Default 40 (cap 100 no servidor). */
  limit?: number
  /** Id da mensagem mais antiga já carregada — busca só o que veio antes. */
  before?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retry em boot (web sobe antes do AgentCore) e hiccups de rede. */
export async function fetchChatMessagesWithRetry(
  chatId: string,
  opts: FetchChatMessagesOpts = {},
  attempts = 6,
): Promise<ChatMessagesPage> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError")
    try {
      return await fetchChatMessages(chatId, opts)
    } catch (err) {
      lastError = err
      if (err instanceof DOMException && err.name === "AbortError") throw err
      if (err instanceof Error && /aborted|AbortError/i.test(err.message)) throw err
      if (i === attempts - 1) break
      await sleep(250 * 2 ** i)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Falha ao carregar mensagens.")
}

/** Página de mensagens (`GET /api/chats/:id/messages?limit=&before=`). */
export async function fetchChatMessages(
  chatId: string,
  opts: FetchChatMessagesOpts | AbortSignal = {},
): Promise<ChatMessagesPage> {
  const normalized: FetchChatMessagesOpts =
    opts instanceof AbortSignal ? { signal: opts } : opts
  const params = new URLSearchParams()
  params.set("limit", String(normalized.limit ?? 40))
  if (normalized.before) params.set("before", normalized.before)

  const response = await fetch(
    `${BASE_URL}/chats/${chatId}/messages?${params}`,
    {
      headers: await authHeaders(),
      signal: normalized.signal,
    },
  )
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
 * Apaga a mensagem e tudo depois dela
 * (`POST /api/chats/:id/truncate` com `deleteFromMessageId`).
 */
export async function truncateChatFromMessage(
  chatId: string,
  deleteFromMessageId: string,
): Promise<void> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/truncate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ deleteFromMessageId }),
  })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Conversa ou mensagem não encontrada.")
    }
    if (response.status === 403) throw new Error("Sem permissão para esta conversa.")
    throw new Error(
      `POST /api/chats/${chatId}/truncate respondeu ${response.status}`,
    )
  }
}
