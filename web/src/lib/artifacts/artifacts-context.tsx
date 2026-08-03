/**
 * Estado de artefatos da conversa ativa: lista, painel aberto e save.
 * Conteúdo editado vai ao modelo via context (system prompt no AgentCore) —
 * NUNCA colado na bolha da mensagem do usuário.
 */
import * as React from "react"

import { useAuth } from "@/providers/auth-provider"
import {
  fetchArtifactsForChat,
  markArtifactTruncated,
  upsertArtifact,
} from "./api"
import {
  looksTruncated,
  selectArtifactsForContext,
} from "./context-inject"
import type { AgentArtifact, ArtifactKind, DetectedArtifactBlock } from "./types"

export type OpenArtifactInput = {
  sourceKey: string
  kind: ArtifactKind
  title: string
  content: string
  messageId?: string | null
  /** Bloco veio de uma resposta cortada pelo limite de tokens. */
  truncated?: boolean
}

interface ArtifactsContextValue {
  chatId: string | null
  artifacts: AgentArtifact[]
  isLoading: boolean
  active: OpenArtifactInput | null
  isPanelOpen: boolean
  openArtifact: (input: OpenArtifactInput) => void
  closePanel: () => void
  saveActive: (content: string, title?: string) => Promise<AgentArtifact>
  getContextArtifacts: () => Array<{
    kind: ArtifactKind
    title: string
    content: string
    version: number
  }>
  findBySourceKey: (sourceKey: string) => AgentArtifact | undefined
  ensureFromBlock: (
    block: DetectedArtifactBlock,
    messageId?: string | null,
  ) => Promise<void>
  refresh: () => void
  setChatId: (chatId: string | null) => void
}

const ArtifactsContext = React.createContext<ArtifactsContextValue | null>(null)

export function ArtifactsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  const [chatId, setChatId] = React.useState<string | null>(null)
  const [artifacts, setArtifacts] = React.useState<AgentArtifact[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [active, setActive] = React.useState<OpenArtifactInput | null>(null)
  const [isPanelOpen, setIsPanelOpen] = React.useState(false)

  const refresh = React.useCallback(() => {
    if (!chatId || !isAuthenticated) {
      setArtifacts([])
      return
    }
    setIsLoading(true)
    fetchArtifactsForChat(chatId)
      .then((lista) => {
        setArtifacts(lista)
        // Marca no DB os que a heurística detecta (sem apagar).
        for (const a of lista) {
          if (!a.is_truncated && looksTruncated(a.kind, a.content)) {
            void markArtifactTruncated(a.id)
          }
        }
      })
      .catch((err) => {
        console.error("Falha ao carregar artefatos:", err)
      })
      .finally(() => setIsLoading(false))
  }, [chatId, isAuthenticated])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  React.useEffect(() => {
    setActive(null)
    setIsPanelOpen(false)
  }, [chatId])

  const findBySourceKey = React.useCallback(
    (sourceKey: string) => artifacts.find((a) => a.source_key === sourceKey),
    [artifacts],
  )

  const openArtifact = React.useCallback(
    (input: OpenArtifactInput) => {
      const existing = artifacts.find((a) => a.source_key === input.sourceKey)
      setActive({
        ...input,
        content: existing?.content ?? input.content,
        title: existing?.title ?? input.title,
        kind: existing?.kind ?? input.kind,
      })
      setIsPanelOpen(true)
    },
    [artifacts],
  )

  const closePanel = React.useCallback(() => {
    setIsPanelOpen(false)
  }, [])

  const saveActive = React.useCallback(
    async (content: string, title?: string) => {
      if (!chatId || !active) throw new Error("Nenhum artefato aberto.")
      const saved = await upsertArtifact({
        chatId,
        sourceKey: active.sourceKey,
        kind: active.kind,
        title: (title ?? active.title).trim() || active.title,
        content,
        messageId: active.messageId,
        isTruncated: false,
      })
      setArtifacts((prev) => {
        const rest = prev.filter((a) => a.id !== saved.id)
        return [saved, ...rest]
      })
      setActive((prev) =>
        prev
          ? {
              ...prev,
              content: saved.content,
              title: saved.title ?? prev.title,
              truncated: false,
            }
          : prev,
      )
      return saved
    },
    [active, chatId],
  )

  const ensureFromBlock = React.useCallback(
    async (block: DetectedArtifactBlock, messageId?: string | null) => {
      if (!chatId) return

      // Truncado: NÃO versiona como artefato válido — só abre o painel local
      // se ainda não houver um completo do mesmo kind.
      if (block.truncated || looksTruncated(block.kind, block.content)) {
        const completo = artifacts.find(
          (a) =>
            a.kind === block.kind &&
            !a.is_truncated &&
            !looksTruncated(a.kind, a.content),
        )
        if (completo) {
          openArtifact({
            sourceKey: completo.source_key,
            kind: completo.kind,
            title: completo.title ?? block.title,
            content: completo.content,
            messageId: completo.message_id ?? messageId,
            truncated: false,
          })
          return
        }
        openArtifact({
          sourceKey: block.sourceKey,
          kind: block.kind,
          title: block.title,
          content: block.content,
          messageId,
          truncated: true,
        })
        return
      }

      const existingSameKey = artifacts.find(
        (a) => a.source_key === block.sourceKey,
      )
      if (existingSameKey) {
        openArtifact({
          sourceKey: existingSameKey.source_key,
          kind: existingSameKey.kind,
          title: existingSameKey.title ?? block.title,
          content: existingSameKey.content,
          messageId: existingSameKey.message_id ?? messageId,
          truncated: false,
        })
        return
      }

      // Regeneração com hash diferente: atualiza o artefato mais recente do
      // mesmo kind (evita v1/v1/v2 paralelos no prompt).
      const sameKind = artifacts
        .filter((a) => a.kind === block.kind && !a.is_truncated)
        .sort((a, b) => {
          if (b.version !== a.version) return b.version - a.version
          return Date.parse(b.updated_at) - Date.parse(a.updated_at)
        })[0]

      const sourceKey = sameKind?.source_key ?? block.sourceKey

      try {
        const saved = await upsertArtifact({
          chatId,
          sourceKey,
          kind: block.kind,
          title: block.title,
          content: block.content,
          messageId,
          isTruncated: false,
        })
        setArtifacts((prev) => [saved, ...prev.filter((a) => a.id !== saved.id)])
        openArtifact({
          sourceKey: saved.source_key,
          kind: saved.kind,
          title: saved.title ?? block.title,
          content: saved.content,
          messageId: saved.message_id,
          truncated: false,
        })
      } catch (err) {
        console.warn("Artefato local (chat ainda sem persistência):", err)
        openArtifact({
          sourceKey: block.sourceKey,
          kind: block.kind,
          title: block.title,
          content: block.content,
          messageId,
          truncated: false,
        })
      }
    },
    [artifacts, chatId, openArtifact],
  )

  const getContextArtifacts = React.useCallback(() => {
    // Só a versão atual por kind; sem truncados; content já limitado.
    return selectArtifactsForContext(
      artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title ?? "Artefato",
        content: a.content,
        version: a.version,
        is_truncated: a.is_truncated,
        updated_at: a.updated_at,
      })),
    ).map((a) => ({
      kind: a.kind,
      title: a.title,
      content: a.content,
      version: a.version,
    }))
  }, [artifacts])

  const value = React.useMemo<ArtifactsContextValue>(
    () => ({
      chatId,
      artifacts,
      isLoading,
      active,
      isPanelOpen,
      openArtifact,
      closePanel,
      saveActive,
      getContextArtifacts,
      findBySourceKey,
      ensureFromBlock,
      refresh,
      setChatId,
    }),
    [
      chatId,
      artifacts,
      isLoading,
      active,
      isPanelOpen,
      openArtifact,
      closePanel,
      saveActive,
      getContextArtifacts,
      findBySourceKey,
      ensureFromBlock,
      refresh,
    ],
  )

  return (
    <ArtifactsContext.Provider value={value}>{children}</ArtifactsContext.Provider>
  )
}

export function useArtifacts(): ArtifactsContextValue {
  const ctx = React.useContext(ArtifactsContext)
  if (!ctx) {
    throw new Error("useArtifacts deve ser usado dentro de <ArtifactsProvider>")
  }
  return ctx
}

/** Hook opcional — retorna null fora do provider (ex.: settings). */
export function useArtifactsOptional(): ArtifactsContextValue | null {
  return React.useContext(ArtifactsContext)
}
