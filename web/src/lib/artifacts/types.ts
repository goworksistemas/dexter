export type ArtifactKind = "html" | "markdown"

export interface AgentArtifact {
  id: string
  chat_id: string
  message_id: string | null
  user_id: string
  kind: ArtifactKind
  title: string | null
  content: string
  version: number
  source_key: string
  /** Resposta cortada / fence aberto — não injetar no prompt. */
  is_truncated: boolean
  created_at: string
  updated_at: string
}

export interface DetectedArtifactBlock {
  kind: ArtifactKind
  language: string
  content: string
  /** Índice do bloco detectável no texto da mensagem. */
  blockIndex: number
  sourceKey: string
  title: string
  substantial: boolean
  /** Bloco cujo fence nunca fechou — resposta do modelo foi cortada. */
  truncated: boolean
}
