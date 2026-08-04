/**
 * Estado de artefatos da conversa ativa: lista, painel aberto e save.
 * Conteúdo editado vai ao modelo via context (system prompt no AgentCore) —
 * NUNCA colado na bolha da mensagem do usuário.
 */
import * as React from "react"
import { toast } from "sonner"

import { useAuth } from "@/providers/auth-provider"
import {
  fetchArtifactsForChat,
  markArtifactTruncated,
  upsertArtifact,
} from "./api"
import { publishArtifactLive } from "./live-channel"
import {
  looksTruncated,
  selectArtifactsForContext,
} from "./context-inject"
import { stableSourceKey } from "./parse"
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
    is_truncated?: boolean
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

  /** Conversa atual para descartar respostas de fetches de conversas antigas. */
  const chatIdRef = React.useRef<string | null>(chatId)
  chatIdRef.current = chatId

  const refresh = React.useCallback(
    (signal?: AbortSignal) => {
      const requestedChatId = chatId
      if (!requestedChatId || !isAuthenticated) {
        setArtifacts([])
        setIsLoading(false)
        return
      }
      setIsLoading(true)
      fetchArtifactsForChat(requestedChatId, signal)
        .then((lista) => {
          // Resposta atrasada da conversa anterior não pode vazar para a atual
          // (a lista alimenta context.artifacts, ou seja, o system prompt).
          if (signal?.aborted || chatIdRef.current !== requestedChatId) return
          setArtifacts(lista)
          // Marca no DB os que a heurística detecta (sem apagar).
          for (const a of lista) {
            if (!a.is_truncated && looksTruncated(a.kind, a.content)) {
              void markArtifactTruncated(a.id)
            }
          }
        })
        .catch((err) => {
          if (signal?.aborted) return
          console.error("Falha ao carregar artefatos:", err)
        })
        .finally(() => {
          // Um refresh mais novo já assumiu o spinner.
          if (signal?.aborted || chatIdRef.current !== requestedChatId) return
          setIsLoading(false)
        })
    },
    [chatId, isAuthenticated],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  React.useEffect(() => {
    setActive(null)
    setIsPanelOpen(false)
  }, [chatId])

  const findBySourceKey = React.useCallback(
    (sourceKey: string) => {
      const exact = artifacts.find((a) => a.source_key === sourceKey)
      if (exact) return exact
      // Compat: kind:current ↔ source_key legado (hash).
      if (sourceKey.endsWith(":current")) {
        const kind = sourceKey.slice(0, -":current".length) as ArtifactKind
        return artifacts
          .filter((a) => a.kind === kind)
          .sort((a, b) => b.version - a.version)[0]
      }
      return undefined
    },
    [artifacts],
  )

  const openArtifact = React.useCallback(
    (input: OpenArtifactInput) => {
      const existing =
        artifacts.find((a) => a.source_key === input.sourceKey) ??
        artifacts
          .filter((a) => a.kind === input.kind)
          .sort((a, b) => b.version - a.version)[0]
      setActive({
        ...input,
        // Caller (ensureFromBlock pós-upsert) é autoritativo — não usar
        // existing.content do state stale, que apagaria a edição nova.
        sourceKey: existing?.source_key ?? input.sourceKey,
        content: input.content,
        title: input.title || existing?.title || input.title,
        kind: input.kind,
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
      publishArtifactLive({
        artifactId: saved.id,
        kind: saved.kind,
        title: saved.title ?? active.title,
        content: saved.content,
        version: saved.version,
        at: Date.now(),
      })
      return saved
    },
    [active, chatId],
  )

  const runEnsureFromBlock = React.useCallback(
    async (block: DetectedArtifactBlock, messageId?: string | null) => {
      if (!chatId) return

      // Um artefato ativo por kind: reusa source_key legado ou kind:current.
      const sameKind = artifacts
        .filter((a) => a.kind === block.kind)
        .sort((a, b) => {
          if (b.version !== a.version) return b.version - a.version
          return Date.parse(b.updated_at) - Date.parse(a.updated_at)
        })[0]
      const sourceKey =
        sameKind?.source_key ?? block.sourceKey ?? stableSourceKey(block.kind)
      const incomplete =
        Boolean(block.truncated) || looksTruncated(block.kind, block.content)

      // Truncado: não sobrescreve um completo válido; persiste incompleto
      // só se ainda não houver versão completa do mesmo kind (p/ o prompt).
      if (incomplete) {
        const completo =
          sameKind &&
          !sameKind.is_truncated &&
          !looksTruncated(sameKind.kind, sameKind.content)
            ? sameKind
            : null
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
        try {
          const saved = await upsertArtifact({
            chatId,
            sourceKey,
            kind: block.kind,
            title: block.title,
            content: block.content,
            messageId,
            isTruncated: true,
          })
          setArtifacts((prev) => [saved, ...prev.filter((a) => a.id !== saved.id)])
          openArtifact({
            sourceKey: saved.source_key,
            kind: saved.kind,
            title: saved.title ?? block.title,
            content: saved.content,
            messageId: saved.message_id ?? messageId,
            truncated: true,
          })
        } catch (err) {
          console.warn("Artefato truncado local:", err)
          openArtifact({
            sourceKey,
            kind: block.kind,
            title: block.title,
            content: block.content,
            messageId,
            truncated: true,
          })
        }
        return
      }

      // Completo: sempre upsert no mesmo source_key/kind (edição in-place).
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
        publishArtifactLive({
          artifactId: saved.id,
          kind: saved.kind,
          title: saved.title ?? block.title,
          content: saved.content,
          version: saved.version,
          at: Date.now(),
        })
        openArtifact({
          sourceKey: saved.source_key,
          kind: saved.kind,
          title: saved.title ?? block.title,
          content: saved.content,
          messageId: saved.message_id,
          truncated: false,
        })
      } catch (err) {
        console.warn("Falha ao persistir artefato:", err)
        toast.error(
          "Não foi possível salvar este artefato no servidor. As edições podem não ser mantidas.",
        )
        openArtifact({
          sourceKey,
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

  /**
   * Uma cadeia de upsert por (chat, kind): vários MessageBubble montando ao
   * mesmo tempo usariam o mesmo source_key e estourariam a unique
   * (chat_id, source_key) em paralelo.
   */
  const ensureQueueRef = React.useRef(new Map<string, Promise<void>>())

  const ensureFromBlock = React.useCallback(
    (block: DetectedArtifactBlock, messageId?: string | null): Promise<void> => {
      if (!chatId) return Promise.resolve()
      const key = `${chatId}:${block.kind}`
      const queue = ensureQueueRef.current
      const anterior = queue.get(key) ?? Promise.resolve()
      const atual = anterior
        .catch(() => undefined)
        .then(() => runEnsureFromBlock(block, messageId))
      queue.set(key, atual)
      void atual
        .catch(() => undefined)
        .finally(() => {
          if (queue.get(key) === atual) queue.delete(key)
        })
      return atual
    },
    [chatId, runEnsureFromBlock],
  )

  const getContextArtifacts = React.useCallback(() => {
    // Versão atual por kind (inclui incompletos marcados p/ o modelo completar).
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
      is_truncated: a.is_truncated,
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
