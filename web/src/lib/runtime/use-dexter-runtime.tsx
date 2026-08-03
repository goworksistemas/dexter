/**
 * Adapta o `ChatTransport` ao runtime do assistant-ui v0.15.
 *
 * A geração SSE vive no `chatRunsStore` (nível app): desmontar o ChatThread
 * ou trocar de conversa só desanexa o watch do adapter — não aborta o fetch.
 * Cancelamento explícito: `chatRunsStore.cancelRun(chatId)` (botão Parar).
 */
import { useMemo, useRef } from "react"
import { useLocalRuntime } from "@assistant-ui/react"
import type {
  AssistantRuntime,
  ChatModelAdapter,
  ChatModelRunResult,
  ThreadMessage,
} from "@assistant-ui/react"

import type { ChatAttachment, ChatMessage, ChatTransport } from "@/lib/agentcore/contract"
import { chatRunsStore } from "@/lib/chats/chat-runs-store"
import { MockTransport } from "@/lib/runtime/mock-transport"
import { AgentCoreTransport } from "@/lib/agentcore"

/** Ponte com os anexos pendentes do composer (ver `pending-attachments.ts`). */
export interface PendingAttachmentsBridge {
  attachmentsRef: { current: ChatAttachment[] }
  clear: () => void
  onSent?: (messageId: string, attachments: ChatAttachment[]) => void
}

function extrairTexto(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

function paraChatMessages(messages: readonly ThreadMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: extrairTexto(message),
    createdAt: message.createdAt.toISOString(),
  }))
}

function resultadoDeTexto(
  texto: string,
  status: ChatModelRunResult["status"],
): ChatModelRunResult {
  return {
    content: [{ type: "text", text: texto }],
    status,
  }
}

/**
 * Observa o snapshot do store e emite `ChatModelRunResult` até a geração
 * assentar ou o `abortSignal` do runtime disparar (desanexar a UI — sem
 * cancelar o store).
 */
async function* watchStoreRun(
  chatId: string,
  signal: AbortSignal,
): AsyncGenerator<ChatModelRunResult, void, undefined> {
  const queue: string[] = []
  let wake: (() => void) | null = null

  const enqueue = () => {
    const run = chatRunsStore.getRun(chatId)
    if (!run) return
    queue.push(run.assistantText + "\0" + run.status + "\0" + (run.error ?? ""))
    wake?.()
  }

  const unsub = chatRunsStore.subscribe(enqueue)
  enqueue()

  const onAbort = () => wake?.()
  signal.addEventListener("abort", onAbort)

  try {
    let lastKey = ""
    while (!signal.aborted) {
      while (queue.length > 0) {
        const key = queue.shift()!
        if (key === lastKey) continue
        lastKey = key
        const run = chatRunsStore.getRun(chatId)
        if (!run) return
        const texto = run.assistantText
        if (run.status === "running") {
          yield resultadoDeTexto(texto, { type: "running" })
        } else if (run.status === "error") {
          yield resultadoDeTexto(texto, {
            type: "incomplete",
            reason: "error",
            error: run.error ?? "erro",
          })
          return
        } else if (run.status === "cancelled") {
          yield resultadoDeTexto(texto, {
            type: "incomplete",
            reason: "cancelled",
          })
          return
        } else {
          yield resultadoDeTexto(texto, {
            type: "complete",
            reason: "stop",
          })
          return
        }
      }

      if (signal.aborted) break

      await new Promise<void>((resolve) => {
        if (signal.aborted || queue.length > 0) {
          resolve()
          return
        }
        wake = resolve
      })
      wake = null
    }

    // UI desanexou: deixa o store continuar. Fecha o generator local como
    // "running" truncado — o sync do ChatThread assume ao voltar.
    const run = chatRunsStore.getRun(chatId)
    if (run?.status === "running") {
      yield resultadoDeTexto(run.assistantText, { type: "running" })
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    unsub()
  }
}

export type ArtifactsContextBridge = () => Array<{
  kind: string
  title: string
  content: string
  version: number
}>

function criarChatModelAdapter(
  threadIdRef: { current: string },
  modelIdRef: { current: string | null },
  projectIdRef: { current: string | null },
  pendingAttachmentsRef: { current: PendingAttachmentsBridge | null },
  artifactsGetterRef: { current: ArtifactsContextBridge | null },
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const chatId = threadIdRef.current
      const chatMessages = paraChatMessages(messages)

      const bridge = pendingAttachmentsRef.current
      const anexosPendentes = bridge?.attachmentsRef.current ?? []
      let attachments: ChatAttachment[] | undefined
      if (anexosPendentes.length > 0) {
        attachments = anexosPendentes
        for (let i = chatMessages.length - 1; i >= 0; i--) {
          if (chatMessages[i]!.role === "user") {
            bridge?.onSent?.(chatMessages[i]!.id, anexosPendentes)
            break
          }
        }
        bridge?.clear()
      }

      const artifacts = artifactsGetterRef.current?.() ?? []

      const jaRodando = chatRunsStore.isRunning(chatId)
      if (!jaRodando) {
        chatRunsStore.startRun({
          chatId,
          messages: chatMessages,
          model: modelIdRef.current,
          projectId: projectIdRef.current,
          attachments,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
        })
      }

      yield* watchStoreRun(chatId, abortSignal)
    },
  }
}

function criarTransportPadrao(): ChatTransport {
  return import.meta.env.VITE_USE_MOCK === "true"
    ? new MockTransport()
    : new AgentCoreTransport()
}

/**
 * Hook que monta o AssistantRuntime. A geração real fica no `chatRunsStore`;
 * o adapter só anexa/desanexa a UI à geração do `threadId` ativo.
 */
export function useDexterRuntime(
  threadId?: string,
  selectedModelId?: string | null,
  transport?: ChatTransport,
  pendingAttachments?: PendingAttachmentsBridge,
  projectId?: string | null,
  getArtifacts?: ArtifactsContextBridge | null,
): AssistantRuntime {
  const transportRef = useRef<ChatTransport | null>(null)
  if (!transportRef.current) {
    transportRef.current = transport ?? criarTransportPadrao()
    chatRunsStore.setTransport(transportRef.current)
  }

  const fallbackIdRef = useRef<string | null>(null)
  if (!fallbackIdRef.current) fallbackIdRef.current = crypto.randomUUID()

  const threadIdRef = useRef(threadId ?? fallbackIdRef.current)
  threadIdRef.current = threadId ?? fallbackIdRef.current

  const modelIdRef = useRef<string | null>(selectedModelId ?? null)
  modelIdRef.current = selectedModelId ?? null

  const projectIdRef = useRef<string | null>(projectId ?? null)
  projectIdRef.current = projectId ?? null

  const pendingAttachmentsRef = useRef<PendingAttachmentsBridge | null>(
    pendingAttachments ?? null,
  )
  pendingAttachmentsRef.current = pendingAttachments ?? null

  const artifactsGetterRef = useRef<ArtifactsContextBridge | null>(
    getArtifacts ?? null,
  )
  artifactsGetterRef.current = getArtifacts ?? null

  const adapter = useMemo(
    () =>
      criarChatModelAdapter(
        threadIdRef,
        modelIdRef,
        projectIdRef,
        pendingAttachmentsRef,
        artifactsGetterRef,
      ),
    [],
  )

  return useLocalRuntime(adapter)
}
