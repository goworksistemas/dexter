/**
 * Store de gerações SSE por `chatId`, independente do ciclo de vida do
 * `ChatThread` / `useLocalRuntime`. Trocar de conversa ou desmontar a UI
 * NÃO aborta o fetch — só o cancelamento explícito (botão Parar).
 */
import type { ThreadMessageLike } from "@assistant-ui/react"

import { AgentCoreTransport } from "@/lib/agentcore"
import type {
  AgentProgressEvent,
  ChatAttachment,
  ChatMessage,
  ChatTransport,
} from "@/lib/agentcore/contract"
import { stripArtifactAppendix } from "@/lib/artifacts/context-inject"
import {
  aplicarProgresso,
  progressoVazio,
  type RunProgress,
} from "./run-steps"

export type ChatRunStatus = "running" | "complete" | "error" | "cancelled"

/** Sem evento SSE → aviso na UI. */
const STALL_WARN_MS = 90_000
/** Sem evento SSE → aborta como erro (run órfão / servidor morto). */
const STALL_FAIL_MS = 180_000

export interface ChatRunMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt?: string
}

export interface ChatRunSnapshot {
  chatId: string
  status: ChatRunStatus
  messages: ChatRunMessage[]
  /** Texto parcial/final da resposta do assistente em geração. */
  assistantText: string
  assistantMessageId: string
  error?: string
  /**
   * O que o agente fez/está fazendo neste run (timeline de tools + fase atual).
   * A identidade do objeto só muda quando chega progresso — assim o painel não
   * re-renderiza a cada delta de texto.
   */
  progress: RunProgress
}

export interface StartChatRunParams {
  chatId: string
  /** Histórico completo já incluindo a última mensagem do usuário. */
  messages: ChatMessage[]
  model?: string | null
  projectId?: string | null
  attachments?: ChatAttachment[]
  /** Artefatos — só em `context` (system prompt). Nunca na bolha do user. */
  artifacts?: Array<{
    kind: string
    title: string
    content: string
    version: number
  }>
}

type Listener = () => void

function criarTransportPadrao(): ChatTransport {
  return new AgentCoreTransport()
}

export class ChatRunsStore {
  private readonly runs = new Map<string, ChatRunSnapshot>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<Listener>()
  private readonly lastActivityAt = new Map<string, number>()
  private readonly stallTimers = new Map<string, ReturnType<typeof setInterval>>()
  private transport: ChatTransport
  private onRunSettled: ((chatId: string) => void) | null = null

  constructor(transport?: ChatTransport) {
    this.transport = transport ?? criarTransportPadrao()
  }

  setTransport(transport: ChatTransport): void {
    this.transport = transport
  }

  setOnRunSettled(cb: ((chatId: string) => void) | null): void {
    this.onRunSettled = cb
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  getRun(chatId: string): ChatRunSnapshot | undefined {
    return this.runs.get(chatId)
  }

  isRunning(chatId: string): boolean {
    return this.runs.get(chatId)?.status === "running"
  }

  getRunningChatIds(): string[] {
    const ids: string[] = []
    for (const [id, run] of this.runs) {
      if (run.status === "running") ids.push(id)
    }
    return ids
  }

  /** Remove snapshot já reconciliado (ex.: após loadHistory da API). */
  discardRun(chatId: string): void {
    if (this.runs.get(chatId)?.status === "running") return
    if (!this.runs.has(chatId)) return
    this.runs.delete(chatId)
    this.clearStall(chatId)
    this.notify()
  }

  cancelRun(chatId: string): void {
    const controller = this.controllers.get(chatId)
    if (controller) controller.abort()
  }

  /**
   * Inicia (ou reinicia) uma geração para o chat. Se já houver uma rodando
   * no mesmo chat, a anterior é abortada explicitamente.
   */
  startRun(params: StartChatRunParams): void {
    const existing = this.controllers.get(params.chatId)
    if (existing) {
      existing.abort()
      this.controllers.delete(params.chatId)
    }
    this.clearStall(params.chatId)

    const assistantMessageId = crypto.randomUUID()
    const messages: ChatRunMessage[] = params.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: stripArtifactAppendix(m.content),
      createdAt: m.createdAt,
    }))
    messages.push({
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    })

    const snapshot: ChatRunSnapshot = {
      chatId: params.chatId,
      status: "running",
      messages,
      assistantText: "",
      assistantMessageId,
      progress: progressoVazio(),
    }
    this.runs.set(params.chatId, snapshot)

    const controller = new AbortController()
    this.controllers.set(params.chatId, controller)
    this.touchActivity(params.chatId)
    this.startStallWatch(params.chatId, assistantMessageId, controller)
    this.notify()

    void this.consume(params, assistantMessageId, controller.signal)
  }

  private isCurrent(chatId: string, assistantMessageId: string): boolean {
    return this.runs.get(chatId)?.assistantMessageId === assistantMessageId
  }

  private touchActivity(chatId: string): void {
    this.lastActivityAt.set(chatId, Date.now())
  }

  private clearStall(chatId: string): void {
    const t = this.stallTimers.get(chatId)
    if (t) clearInterval(t)
    this.stallTimers.delete(chatId)
    this.lastActivityAt.delete(chatId)
  }

  private startStallWatch(
    chatId: string,
    assistantMessageId: string,
    controller: AbortController,
  ): void {
    const prev = this.stallTimers.get(chatId)
    if (prev) clearInterval(prev)

    const timer = setInterval(() => {
      if (!this.isCurrent(chatId, assistantMessageId)) {
        this.clearStall(chatId)
        return
      }
      const run = this.runs.get(chatId)
      if (!run || run.status !== "running") {
        this.clearStall(chatId)
        return
      }
      const last = this.lastActivityAt.get(chatId) ?? run.progress.startedAt
      const idle = Date.now() - last
      if (idle >= STALL_FAIL_MS) {
        const msg =
          "Sem resposta do servidor há 3 minutos. A geração foi interrompida — toque em Tentar novamente."
        this.updateRunFor(chatId, assistantMessageId, {
          assistantText: run.assistantText
            ? `${run.assistantText}\n\n_${msg}_`
            : `_${msg}_`,
          status: "error",
          error: msg,
          progress: {
            ...run.progress,
            finishedAt: Date.now(),
            statusText: undefined,
            stalledSeconds: Math.round(idle / 1000),
          },
        })
        this.controllers.delete(chatId)
        this.clearStall(chatId)
        controller.abort()
        this.onRunSettled?.(chatId)
        return
      }
      if (idle >= STALL_WARN_MS) {
        const secs = Math.round(idle / 1000)
        const statusText = `Sem resposta há ${secs}s`
        if (run.progress.statusText !== statusText || run.progress.stalledSeconds !== secs) {
          this.updateRunFor(chatId, assistantMessageId, {
            progress: {
              ...run.progress,
              statusText,
              stalledSeconds: secs,
            },
          })
        }
      }
    }, 5_000)

    this.stallTimers.set(chatId, timer)
  }

  private updateRunFor(
    chatId: string,
    assistantMessageId: string,
    patch: Partial<ChatRunSnapshot> & { assistantText?: string },
  ): void {
    if (!this.isCurrent(chatId, assistantMessageId)) return
    this.updateRun(chatId, patch)
  }

  private updateRun(
    chatId: string,
    patch: Partial<ChatRunSnapshot> & {
      assistantText?: string
    },
  ): void {
    const prev = this.runs.get(chatId)
    if (!prev) return

    const assistantText = patch.assistantText ?? prev.assistantText
    const messages = prev.messages.map((m) =>
      m.id === prev.assistantMessageId ? { ...m, content: assistantText } : m,
    )

    const encerrou = patch.status !== undefined && patch.status !== "running"
    const progress =
      patch.progress ??
      (encerrou && prev.progress.finishedAt === undefined
        ? {
            ...prev.progress,
            finishedAt: Date.now(),
            statusText: undefined,
            stalledSeconds: undefined,
          }
        : prev.progress)

    this.runs.set(chatId, {
      ...prev,
      ...patch,
      assistantText,
      messages,
      progress,
    })
    this.notify()
  }

  private applyProgress(
    chatId: string,
    assistantMessageId: string,
    evento: AgentProgressEvent,
  ): void {
    if (!this.isCurrent(chatId, assistantMessageId)) return
    const prev = this.runs.get(chatId)
    if (!prev) return
    const progress = aplicarProgresso(prev.progress, evento)
    if (progress === prev.progress) return
    // Chegou evento real — limpa aviso de stall.
    this.updateRunFor(chatId, assistantMessageId, {
      progress: { ...progress, stalledSeconds: undefined },
    })
  }

  private settle(
    chatId: string,
    assistantMessageId: string,
    patch: Partial<ChatRunSnapshot> & { assistantText?: string },
  ): void {
    if (!this.isCurrent(chatId, assistantMessageId)) return
    this.updateRunFor(chatId, assistantMessageId, patch)
    if (this.controllers.get(chatId)?.signal.aborted !== undefined) {
      // remove só se ainda for o controller deste run
    }
    const ctrl = this.controllers.get(chatId)
    // Só apaga o controller se o run atual ainda for este (startRun já trocou).
    if (this.isCurrent(chatId, assistantMessageId)) {
      this.controllers.delete(chatId)
      this.clearStall(chatId)
      this.onRunSettled?.(chatId)
    }
    void ctrl
  }

  private async consume(
    params: StartChatRunParams,
    assistantMessageId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { chatId } = params
    let texto = ""

    // Mensagens limpas — sem apêndice legado. Artefatos vão só em context.
    const chatMessages: ChatMessage[] = params.messages.map((m) => ({
      ...m,
      content: stripArtifactAppendix(m.content),
    }))
    if (params.attachments && params.attachments.length > 0) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i]!.role === "user") {
          chatMessages[i] = {
            ...chatMessages[i]!,
            attachments: params.attachments,
          }
          break
        }
      }
    }

    const context =
      params.model || params.projectId || (params.artifacts && params.artifacts.length > 0)
        ? {
            ...(params.model ? { model: params.model } : {}),
            ...(params.projectId ? { projectId: params.projectId } : {}),
            ...(params.artifacts && params.artifacts.length > 0
              ? { artifacts: params.artifacts }
              : {}),
          }
        : undefined

    try {
      for await (const chunk of this.transport.stream(
        { threadId: chatId, messages: chatMessages, context },
        signal,
      )) {
        if (!this.isCurrent(chatId, assistantMessageId)) return
        this.touchActivity(chatId)

        if (chunk.type === "heartbeat") {
          // Só atualiza lastActivity — não mexe na UI.
          continue
        } else if (chunk.type === "text-delta") {
          texto += chunk.textDelta
          this.updateRunFor(chatId, assistantMessageId, { assistantText: texto })
        } else if (chunk.type === "progress") {
          this.applyProgress(chatId, assistantMessageId, chunk.event)
        } else if (chunk.type === "error") {
          texto = texto
            ? `${texto}\n\n_Erro: ${chunk.message}_`
            : `_Erro: ${chunk.message}_`
          this.settle(chatId, assistantMessageId, {
            assistantText: texto,
            status: "error",
            error: chunk.message,
          })
          return
        } else if (chunk.type === "done") {
          this.settle(chatId, assistantMessageId, {
            assistantText: texto,
            status: "complete",
          })
          return
        }
      }

      if (!this.isCurrent(chatId, assistantMessageId)) return

      if (signal.aborted) {
        this.settle(chatId, assistantMessageId, {
          assistantText: texto,
          status: "cancelled",
        })
      } else {
        this.settle(chatId, assistantMessageId, {
          assistantText: texto,
          status: texto ? "complete" : "error",
          error: texto ? undefined : "Stream encerrado sem resposta.",
        })
      }
    } catch (err) {
      if (!this.isCurrent(chatId, assistantMessageId)) return
      if (signal.aborted) {
        this.settle(chatId, assistantMessageId, {
          assistantText: texto,
          status: "cancelled",
        })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.settle(chatId, assistantMessageId, {
          assistantText: texto
            ? `${texto}\n\n_Erro: ${message}_`
            : `_Erro: ${message}_`,
          status: "error",
          error: message,
        })
      }
    }
  }
}

/** Converte snapshot do store para o formato do assistant-ui (`thread.reset`). */
export function runSnapshotToThreadMessages(
  snapshot: ChatRunSnapshot,
): ThreadMessageLike[] {
  return snapshot.messages.map((m) => {
    const content =
      m.role === "user" ? stripArtifactAppendix(m.content) : m.content
    if (m.role === "assistant") {
      const running =
        snapshot.status === "running" && m.id === snapshot.assistantMessageId
      return {
        id: m.id,
        role: m.role,
        content,
        createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
        status: running
          ? { type: "running" }
          : snapshot.status === "error" && m.id === snapshot.assistantMessageId
            ? {
                type: "incomplete",
                reason: "error",
                error: snapshot.error ?? "erro",
              }
            : snapshot.status === "cancelled" &&
                m.id === snapshot.assistantMessageId
              ? { type: "incomplete", reason: "cancelled" }
              : { type: "complete", reason: "stop" },
      } satisfies ThreadMessageLike
    }
    return {
      id: m.id,
      role: m.role,
      content,
      createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
    } satisfies ThreadMessageLike
  })
}

/** Instância singleton — sobrevive a remounts do ChatThread. */
export const chatRunsStore = new ChatRunsStore()
