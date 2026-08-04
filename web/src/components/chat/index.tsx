/**
 * Ponto de entrada do chat do Dexter. O shell importa só isto:
 *   import { ChatThread } from "@/components/chat"
 *
 * Gerações SSE ficam no `chatRunsStore` (nível app). Este componente anexa
 * a UI à conversa ativa e expõe editar / tentar novamente.
 */
import { useCallback, useEffect } from "react"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import type { ThreadMessage, ThreadMessageLike } from "@assistant-ui/react"
import { toast } from "sonner"

import { Thread } from "@/components/chat/thread"
import { useArtifacts } from "@/lib/artifacts"
import {
  useActiveChatProjectId,
  useChatModel,
  useChats,
  useChatRunProgress,
  useChatRuns,
  useChatStepsHistory,
  useIsChatRunning,
} from "@/lib/chats"
import { runSnapshotToThreadMessages } from "@/lib/chats/chat-runs-store"
import { truncateChatFromMessage } from "@/lib/chats/api"
import { useDexterRuntime } from "@/lib/runtime/use-dexter-runtime"
import {
  usePendingAttachments,
  useSentAttachments,
} from "@/lib/runtime/pending-attachments"

function textoDaMensagem(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

function paraThreadMessageLike(message: ThreadMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: textoDaMensagem(message),
    createdAt: message.createdAt,
  }
}

export function ChatThread() {
  const {
    activeChatId,
    isLoadingHistory,
    expectsThread,
    historyError,
    reloadHistory,
    hasMoreHistory,
    isLoadingOlderHistory,
    loadOlderHistory,
    registerRuntime,
    refreshChats,
    consumePendingFirstMessage,
  } = useChats()
  const projectId = useActiveChatProjectId()
  // Modelo POR CONVERSA: pinado no chat > default global (só p/ novas).
  const { effectiveModelId } = useChatModel()
  const { startRun, cancelRun, getRun, subscribe } = useChatRuns()
  const storeRunning = useIsChatRunning(activeChatId)
  const runProgress = useChatRunProgress(activeChatId)
  const stepsByMessageId = useChatStepsHistory(activeChatId)
  const { setChatId, getContextArtifacts } = useArtifacts()

  const pendingAttachments = usePendingAttachments()
  const sentAttachments = useSentAttachments()

  const getArtifacts = useCallback(
    () => getContextArtifacts(),
    [getContextArtifacts],
  )

  const runtime = useDexterRuntime(
    activeChatId,
    effectiveModelId,
    undefined,
    {
      attachmentsRef: pendingAttachments.ref,
      clear: pendingAttachments.clear,
      onSent: sentAttachments.registrar,
    },
    projectId,
    getArtifacts,
  )

  useEffect(() => {
    setChatId(activeChatId)
  }, [activeChatId, setChatId])

  useEffect(() => {
    pendingAttachments.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId])

  useEffect(() => {
    registerRuntime(runtime)
    return () => registerRuntime(null)
  }, [runtime, registerRuntime])

  // Espelha o store → thread enquanto roda. Ao cancelar/erro/complete, aplica
  // UMA vez se a thread ainda acha que está running (senão o Parar “não faz nada”).
  // Depois disso o loadHistory/API manda no histórico — não ficar reaplicando
  // snapshot settled por cima.
  useEffect(() => {
    const sync = () => {
      const snap = getRun(activeChatId)
      if (!snap) return
      if (snap.status === "running") {
        runtime.thread.reset(runSnapshotToThreadMessages(snap))
        return
      }
      if (runtime.thread.getState().isRunning) {
        runtime.thread.reset(runSnapshotToThreadMessages(snap))
      }
    }
    sync()
    return subscribe(sync)
  }, [activeChatId, runtime, getRun, subscribe])

  /**
   * Primeira mensagem digitada fora do chat (composer da página do projeto).
   * Dispara direto no store com o projectId que veio junto — não dá para
   * depender de `useActiveChatProjectId()` aqui, porque no commit em que o
   * ChatThread monta o ProjectsProvider ainda não sincronizou a URL nova.
   */
  useEffect(() => {
    const pendente = consumePendingFirstMessage(activeChatId)
    if (!pendente) return
    startRun({
      chatId: activeChatId,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: pendente.text,
          createdAt: new Date().toISOString(),
        },
      ],
      model: effectiveModelId,
      projectId: pendente.projectId,
    })
    const snap = getRun(activeChatId)
    if (snap) {
      runtime.thread.reset(runSnapshotToThreadMessages(snap))
    }
  }, [
    activeChatId,
    consumePendingFirstMessage,
    getRun,
    runtime,
    effectiveModelId,
    startRun,
  ])

  useEffect(() => {
    let estavaRodando = runtime.thread.getState().isRunning || storeRunning
    return subscribe(() => {
      const rodandoAgora = getRun(activeChatId)?.status === "running"
      if (estavaRodando && !rodandoAgora) refreshChats()
      estavaRodando = rodandoAgora
    })
  }, [runtime, refreshChats, subscribe, getRun, activeChatId, storeRunning])

  const stopGeneration = useCallback(() => {
    cancelRun(activeChatId)
    try {
      runtime.thread.composer.cancel()
    } catch {
      // composer.cancel é best-effort (runtime local); o store manda.
    }
  }, [cancelRun, activeChatId, runtime])

  const iniciarRegeneracao = useCallback(
    (messages: ThreadMessageLike[]) => {
      const artifacts = getContextArtifacts()
      startRun({
        chatId: activeChatId,
        messages: messages.map((m) => ({
          id: m.id ?? crypto.randomUUID(),
          role: (m.role ?? "user") as "user" | "assistant" | "system",
          content:
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .map((p) =>
                      p && typeof p === "object" && "text" in p
                        ? String((p as { text?: unknown }).text ?? "")
                        : "",
                    )
                    .join("")
                : "",
          createdAt:
            m.createdAt instanceof Date
              ? m.createdAt.toISOString()
              : typeof m.createdAt === "string"
                ? m.createdAt
                : undefined,
        })),
        model: effectiveModelId,
        projectId,
        artifacts: artifacts.length > 0 ? artifacts : undefined,
      })
      const snap = getRun(activeChatId)
      if (snap) {
        runtime.thread.reset(runSnapshotToThreadMessages(snap))
      }
    },
    [
      activeChatId,
      getContextArtifacts,
      getRun,
      projectId,
      runtime,
      effectiveModelId,
      startRun,
    ],
  )

  const editUserMessage = useCallback(
    async (messageId: string, newText: string) => {
      const trimmed = newText.trim()
      if (!trimmed) {
        toast.error("A mensagem não pode ficar vazia.")
        return
      }
      if (storeRunning) {
        toast.error("Aguarde o fim da geração ou pare a resposta.")
        return
      }

      const current = runtime.thread.getState().messages
      const index = current.findIndex((m) => m.id === messageId)
      if (index < 0 || current[index]!.role !== "user") {
        toast.error("Mensagem não encontrada.")
        return
      }

      try {
        await truncateChatFromMessage(activeChatId, messageId)
        const kept = current.slice(0, index).map(paraThreadMessageLike)
        const userMessage: ThreadMessageLike = {
          id: crypto.randomUUID(),
          role: "user",
          content: trimmed,
          createdAt: new Date(),
        }
        iniciarRegeneracao([...kept, userMessage])
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Falha ao editar a mensagem.",
        )
      }
    },
    [activeChatId, iniciarRegeneracao, runtime, storeRunning],
  )

  const retryLastExchange = useCallback(async () => {
    // Run travado no store: cancela e segue com o retry (recuperação).
    if (storeRunning) {
      cancelRun(activeChatId)
    }

    const current = runtime.thread.getState().messages
    let lastUserIndex = -1
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i]!.role === "user") {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex < 0) {
      toast.error("Nada para tentar novamente.")
      return
    }

    // Mantém até a última msg do usuário (inclusive); apaga respostas depois.
    const keepCount = lastUserIndex + 1
    const deleteFrom = current[lastUserIndex + 1]
    try {
      if (deleteFrom?.id) {
        await truncateChatFromMessage(activeChatId, deleteFrom.id)
      }
      iniciarRegeneracao(current.slice(0, keepCount).map(paraThreadMessageLike))
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao tentar novamente.",
      )
    }
  }, [activeChatId, cancelRun, iniciarRegeneracao, runtime, storeRunning])

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        runtime={runtime}
        pendingAttachments={pendingAttachments}
        attachmentsByMessageId={sentAttachments.porMensagem}
        storeRunning={storeRunning}
        isLoadingHistory={isLoadingHistory}
        expectsThread={expectsThread}
        historyError={historyError}
        onRetryHistory={reloadHistory}
        hasMoreHistory={hasMoreHistory}
        isLoadingOlderHistory={isLoadingOlderHistory}
        onLoadOlderHistory={() => void loadOlderHistory()}
        chatId={activeChatId}
        runProgress={runProgress}
        stepsByMessageId={stepsByMessageId}
        onStop={stopGeneration}
        onEditUserMessage={editUserMessage}
        onRetryLastExchange={retryLastExchange}
      />
    </AssistantRuntimeProvider>
  )
}
