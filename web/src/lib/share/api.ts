/**
 * API de compartilhamento público (chats e artefatos).
 */
import { getAccessToken } from "@/lib/supabase/auth"

const BASE_URL = "/api"

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

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function shareError(response: Response, fallback: string): Error {
  if (response.status === 401) {
    return new Error("Sessão inválida. Faça login novamente.")
  }
  if (response.status === 404) {
    return new Error("Recurso não encontrado.")
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
  if (!response.ok) throw shareError(response, "Falha ao consultar compartilhamento")
  return response.json()
}

export async function publishChatShare(chatId: string): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  })
  if (!response.ok) throw shareError(response, "Falha ao publicar conversa")
  return response.json()
}

export async function revokeChatShare(chatId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/chats/${chatId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok && response.status !== 204) {
    throw shareError(response, "Falha ao revogar link")
  }
}

export async function fetchArtifactShareStatus(
  artifactId: string,
): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/artifacts/${artifactId}/share`, {
    headers: await authHeaders(),
  })
  if (!response.ok) throw shareError(response, "Falha ao consultar publicação")
  return response.json()
}

export async function publishArtifactShare(
  artifactId: string,
): Promise<ShareLinkStatus> {
  const response = await fetch(`${BASE_URL}/artifacts/${artifactId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  })
  if (!response.ok) throw shareError(response, "Falha ao publicar artefato")
  return response.json()
}

export async function revokeArtifactShare(artifactId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/artifacts/${artifactId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  })
  if (!response.ok && response.status !== 204) {
    throw shareError(response, "Falha ao revogar link")
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
