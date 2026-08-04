/**
 * API de compartilhamento (colega com fork + link público).
 */
import { getAccessToken } from "@/lib/supabase/auth"

const BASE_URL = "/api"

export interface ShareLinkStatus {
  shared: boolean
  shareToken: string | null
  sharedAt: string | null
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

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function shareError(response: Response, fallback: string): Promise<Error> {
  if (response.status === 401) {
    return new Error("Sessão inválida. Faça login novamente.")
  }
  if (response.status === 404) {
    return new Error("Recurso não encontrado.")
  }
  try {
    const body = (await response.json()) as { error?: string; message?: string }
    if (typeof body.message === "string" && body.message) {
      return new Error(body.message)
    }
    if (typeof body.error === "string" && body.error && body.error !== "invalid_request") {
      return new Error(body.error)
    }
  } catch {
    /* ignore */
  }
  return new Error(`${fallback} (${response.status})`)
}

export function publicChatUrl(shareToken: string): string {
  return `${window.location.origin}/s/c/${shareToken}`
}

export function publicArtifactUrl(shareToken: string): string {
  return `${window.location.origin}/s/a/${shareToken}`
}

export async function fetchChatShareStatus(
  chatId: string,
): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share`, {
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao consultar compartilhamento")
  return response.json()
}

export async function publishChatShare(chatId: string): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao publicar conversa")
  return response.json()
}

export async function revokeChatShare(chatId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok && response.status !== 204) {
    throw await shareError(response, "Falha ao revogar link")
  }
}

export async function fetchChatUserShares(
  chatId: string,
): Promise<ChatUserShare[]> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share-users`, {
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao listar convites")
  const body = (await response.json()) as { shares: ChatUserShare[] }
  return body.shares ?? []
}

export interface ShareableColleague {
  id: string
  email: string | null
  fullName: string | null
  avatarUrl: string | null
}

export async function fetchShareableColleagues(): Promise<ShareableColleague[]> {
  const response = await fetch(`${BASE_URL}/me/colleagues`, {
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao listar colegas")
  const body = (await response.json()) as { colleagues: ShareableColleague[] }
  return body.colleagues ?? []
}

export async function inviteChatUserShare(
  chatId: string,
  target: { userId?: string; email?: string },
): Promise<ChatUserShare> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share-users`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(target),
  })
  if (!response.ok) throw await shareError(response, "Falha ao compartilhar")
  const body = (await response.json()) as { share: ChatUserShare }
  return body.share
}

export async function fetchPendingChatShares(): Promise<ChatUserShare[]> {
  const response = await fetch(`${BASE_URL}/me/chat-shares`, {
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao carregar convites")
  const body = (await response.json()) as { shares: ChatUserShare[] }
  return body.shares ?? []
}

export async function forkChatShare(
  shareId: string,
): Promise<{ chatId: string; share: ChatUserShare }> {
  const response = await fetch(`${BASE_URL}/me/chat-shares/${shareId}/fork`, {
    method: "POST",
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao criar cópia")
  return response.json()
}

export async function revokeUserChatShare(shareId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/me/chat-shares/${shareId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok && response.status !== 204) {
    throw await shareError(response, "Falha ao revogar convite")
  }
}

export async function fetchArtifactShareStatus(
  artifactId: string,
): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/artifacts/${artifactId}/share`, {
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao consultar publicação")
  return response.json()
}

export async function publishArtifactShare(
  artifactId: string,
): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/artifacts/${artifactId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  })
  if (!response.ok) throw await shareError(response, "Falha ao publicar artefato")
  return response.json()
}

export async function revokeArtifactShare(artifactId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/artifacts/${artifactId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok && response.status !== 204) {
    throw await shareError(response, "Falha ao revogar link")
  }
}

export async function fetchPublicChat(
  token: string,
  signal?: AbortSignal,
): Promise<PublicChatPayload> {
  const response = await fetch(`${BASE_URL}/public/chats/${token}`, { signal })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Esta conversa não está mais disponível.")
    }
    throw new Error(`Não foi possível carregar a conversa (${response.status}).`)
  }
  return response.json()
}

export async function fetchPublicArtifact(
  token: string,
  signal?: AbortSignal,
): Promise<PublicArtifactPayload> {
  const response = await fetch(`${BASE_URL}/public/artifacts/${token}`, { signal })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Este artefato não está mais disponível.")
    }
    throw new Error(`Não foi possível carregar o artefato (${response.status}).`)
  }
  return response.json()
}
