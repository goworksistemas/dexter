/**
 * Store de gerações SSE por `chatId`, independente do ciclo de vida do
 * `ChatThread` / `useLocalRuntime`. Trocar de conversa ou desmontar a UI
 * NÃO aborta o fetch — só o cancelamento explícito (botão Parar), que também
 * cancela o run no servidor.
 *
 * O run em si vive no SERVIDOR (registro de runs do AgentCore): se a conexão
 * cair no meio (rede, proxy), o store reanexa via `resumeStream` — o replay
 * traz o texto completo; e ao reabrir uma conversa com geração ainda viva
 * (F5, aba nova), `resumeRunSeAtivo` retoma o acompanhamento de onde parou.
 */
import type { ThreadMessageLike } from "@assistant-ui/react"

import { AgentCoreTransport } from "@/lib/agentcore"
import type {
  AgentProgressEvent,
  ArtifactWire,
  ChatAttachment,
  ChatMessage,
  ChatRunStatusWire,
  ChatStreamChunk,
  ChatTransport,
} from "@/lib/agentcore/contract"
import { stripArtifactAppendix } from "@/lib/artifacts/context-inject"
import {
  aplicarProgresso,
  progressoVazio,
  type RunProgress,
} from "./run-steps"
import { toast } from "sonner"

export type ChatRunStatus = "running" | "complete" | "error" | "cancelled"

/** Sem evento SSE → aviso na UI. */
const STALL_WARN_MS = 90_000
/** Sem evento SSE → aborta como erro (run órfão / servidor morto). */
const STALL_FAIL_MS = 180_000

/** Tentativas de reanexar depois de uma queda de conexão no meio do run. */
const MAX_TENTATIVAS_REANEXACAO = 3
/** Atraso base entre tentativas (backoff exponencial: 1s, 2s, 4s). */
const ATRASO_REANEXACAO_MS = 1_000
const MSG_QUEDA_SEM_REANEXAR =
  "A conexão com o AgentCore caiu e não foi possível reanexar. " +
  "Recarregue a conversa — se a geração terminou, a resposta está salva."

/** Espera `ms`, retornando mais cedo se o run for abortado nesse meio tempo. */
function esperar(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Resultado do consumo de uma fonte de chunks SSE. */
type ResultadoConsumo =
  | { tipo: "assentado" }
  /** Conexão caiu sem terminal — o run pode continuar vivo no servidor. */
  | { tipo: "queda" }

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
  /**
   * Histórico local já incluindo a mensagem nova do usuário. Serve para o
   * snapshot otimista da UI; no fio vai só a última mensagem do usuário —
   * o AgentCore monta o contexto a partir do banco.
   */
  messages: ChatMessage[]
  model?: string | null
  projectId?: string | null
  attachments?: ChatAttachment[]
  /** Artefatos — só em `context` (system prompt). Nunca na bolha do user. */
  artifacts?: ArtifactWire[]
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
  /** Texto do assistente pendente de flush pra UI (coalescido por rAF). */
  private readonly pendingText = new Map<string, string>()
  private readonly textFlushRaf = new Map<string, number>()
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
    this.cancelarLocal(chatId)

    // Cancela também no servidor: a desconexão do SSE não aborta mais o run
    // — sem este POST a geração continuaria em segundo plano.
    void this.transport.cancelRun(chatId).catch(() => {
      // Sem run ativo no servidor (ou rede fora) — nada a cancelar.
    })
  }

  /**
   * Cancela e AGUARDA o servidor assentar o run — o 204 do cancel só volta
   * depois de o run antigo persistir o que tinha (terminal publicado). É o
   * que o "Tentar novamente" usa antes de truncar o histórico: sem a espera,
   * a resposta parcial do run cancelado poderia ser gravada DEPOIS do
   * truncate e ressuscitar como lixo. Cobre também run fantasma: mesmo sem
   * nada rodando localmente, cancela o que o servidor conhecer (404 = nada).
   */
  async cancelarEAguardarServidor(chatId: string): Promise<void> {
    this.cancelarLocal(chatId)
    try {
      await this.transport.cancelRun(chatId)
    } catch {
      // Sem run no servidor ou rede fora — o retry segue mesmo assim.
    }
  }

  /** Encerra a UI e aborta o fetch local — parte síncrona do cancelamento. */
  private cancelarLocal(chatId: string): void {
    const run = this.runs.get(chatId)
    const controller = this.controllers.get(chatId)

    // Encerra a UI na hora — não espera o SSE/reader desenrolar (senão a
    // bolha fica status "running" pra sempre se o sync ignorar o settle).
    if (run?.status === "running") {
      const texto = this.pendingText.get(chatId) ?? run.assistantText
      this.cancelTextUi(chatId)
      this.settle(chatId, run.assistantMessageId, {
        assistantText: texto,
        status: "cancelled",
      })
    }

    controller?.abort()
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
    this.cancelTextUi(params.chatId)

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

    void this.consume(params, assistantMessageId, controller)
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
        this.cancelTextUi(chatId)
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
    if (
      evento.type === "tool_call_end" &&
      evento.status === "error" &&
      typeof evento.summary === "string" &&
      evento.summary.includes("Mail.ReadWrite")
    ) {
      toast.error(
        "Reconecte o Outlook em Conexões (faltam permissões Mail.ReadWrite).",
      )
    }
    const progress = aplicarProgresso(prev.progress, evento)
    if (progress === prev.progress) return
    // Chegou evento real — limpa aviso de stall.
    this.updateRunFor(chatId, assistantMessageId, {
      progress: { ...progress, stalledSeconds: undefined },
    })
  }

  /** Empurra texto parcial no máximo 1x por frame — evita reparse markdown a cada token. */
  private scheduleTextUi(
    chatId: string,
    assistantMessageId: string,
    texto: string,
  ): void {
    this.pendingText.set(chatId, texto)
    if (this.textFlushRaf.has(chatId)) return
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            this.textFlushRaf.delete(chatId)
            this.flushPendingText(chatId, assistantMessageId)
          })
        : (setTimeout(() => {
            this.textFlushRaf.delete(chatId)
            this.flushPendingText(chatId, assistantMessageId)
          }, 16) as unknown as number)
    this.textFlushRaf.set(chatId, raf)
  }

  private flushPendingText(
    chatId: string,
    assistantMessageId: string,
  ): void {
    const texto = this.pendingText.get(chatId)
    if (texto === undefined) return
    this.pendingText.delete(chatId)
    this.updateRunFor(chatId, assistantMessageId, { assistantText: texto })
  }

  private cancelTextUi(chatId: string): void {
    const raf = this.textFlushRaf.get(chatId)
    if (raf !== undefined) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf)
      else clearTimeout(raf)
      this.textFlushRaf.delete(chatId)
    }
    this.pendingText.delete(chatId)
  }

  private settle(
    chatId: string,
    assistantMessageId: string,
    patch: Partial<ChatRunSnapshot> & { assistantText?: string },
  ): void {
    if (!this.isCurrent(chatId, assistantMessageId)) return
    this.cancelTextUi(chatId)
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
    controller: AbortController,
  ): Promise<void> {
    const { chatId } = params

    // No fio vai SÓ a mensagem nova (o histórico o AgentCore lê do banco).
    // Sem apêndice legado de artefatos — eles vão só em `context`.
    const ultimaDoUsuario = [...params.messages]
      .reverse()
      .find((m) => m.role === "user")
    if (!ultimaDoUsuario) {
      this.settle(chatId, assistantMessageId, {
        assistantText: "",
        status: "error",
        error: "Nenhuma mensagem do usuário para enviar.",
      })
      return
    }
    const mensagemNova: ChatMessage = {
      ...ultimaDoUsuario,
      content: stripArtifactAppendix(ultimaDoUsuario.content),
      ...(params.attachments && params.attachments.length > 0
        ? { attachments: params.attachments }
        : {}),
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

    const fonte = this.transport.stream(
      { threadId: chatId, message: mensagemNova, context },
      controller.signal,
    )
    await this.consumirComReanexacao(chatId, assistantMessageId, controller, fonte)
  }

  /**
   * Reanexa a UI num run que continua vivo no SERVIDOR (F5, aba nova) —
   * chamado ao abrir uma conversa, com o histórico já persistido como base
   * do snapshot; a bolha do assistente em geração é acrescentada aqui.
   * Devolve `true` se reanexou (o snapshot assume a thread via subscribe).
   */
  async resumeRunSeAtivo(
    chatId: string,
    historico: ChatRunMessage[],
  ): Promise<boolean> {
    if (this.runs.get(chatId)?.status === "running") return false

    let statusServidor: ChatRunStatusWire
    try {
      statusServidor = await this.transport.fetchRunStatus(chatId)
    } catch {
      // Servidor inacessível — o histórico do banco já está na tela.
      return false
    }
    if (!statusServidor.active) return false
    // Um startRun pode ter começado enquanto o status carregava.
    if (this.runs.get(chatId)?.status === "running") return false

    this.clearStall(chatId)
    this.cancelTextUi(chatId)

    const assistantMessageId = crypto.randomUUID()
    const messages: ChatRunMessage[] = [
      ...historico,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      },
    ]
    const snapshot: ChatRunSnapshot = {
      chatId,
      status: "running",
      messages,
      assistantText: "",
      assistantMessageId,
      progress: progressoVazio(),
    }
    this.runs.set(chatId, snapshot)

    const controller = new AbortController()
    this.controllers.set(chatId, controller)
    this.touchActivity(chatId)
    this.startStallWatch(chatId, assistantMessageId, controller)
    this.notify()

    void this.consumirComReanexacao(
      chatId,
      assistantMessageId,
      controller,
      this.transport.resumeStream(chatId, controller.signal),
    )
    return true
  }

  /**
   * Consome a fonte até assentar; em queda de conexão, tenta reanexar no run
   * do servidor quantas vezes forem necessárias (cada reanexação bem-sucedida
   * zera as tentativas — só desiste depois de MAX_TENTATIVAS_REANEXACAO
   * quedas seguidas sem conseguir voltar).
   */
  private async consumirComReanexacao(
    chatId: string,
    assistantMessageId: string,
    controller: AbortController,
    fonteInicial: AsyncIterable<ChatStreamChunk>,
  ): Promise<void> {
    let fonte = fonteInicial
    for (;;) {
      const resultado = await this.consumirFonte(
        chatId,
        assistantMessageId,
        controller,
        fonte,
      )
      if (resultado.tipo === "assentado") return
      const proxima = await this.reanexar(chatId, assistantMessageId, controller)
      if (!proxima) return
      fonte = proxima
    }
  }

  /**
   * Depois de uma queda: re-checa o estado do run no servidor e devolve a
   * fonte reanexada, ou `null` quando o run assentou por outro caminho (fim
   * no servidor, cancelamento, run substituído) — nesses casos o settle já
   * foi feito aqui dentro quando cabia.
   */
  private async reanexar(
    chatId: string,
    assistantMessageId: string,
    controller: AbortController,
  ): Promise<AsyncIterable<ChatStreamChunk> | null> {
    const { signal } = controller

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_REANEXACAO; tentativa++) {
      if (!this.isCurrent(chatId, assistantMessageId)) return null
      if (this.runs.get(chatId)?.status !== "running") return null
      if (signal.aborted) {
        this.settle(chatId, assistantMessageId, { status: "cancelled" })
        return null
      }

      await esperar(ATRASO_REANEXACAO_MS * 2 ** (tentativa - 1), signal)
      if (!this.isCurrent(chatId, assistantMessageId)) return null
      if (this.runs.get(chatId)?.status !== "running") return null
      if (signal.aborted) {
        this.settle(chatId, assistantMessageId, { status: "cancelled" })
        return null
      }

      let statusServidor: ChatRunStatusWire
      try {
        statusServidor = await this.transport.fetchRunStatus(chatId)
      } catch {
        // Rede ainda fora — conta a tentativa e insiste.
        continue
      }

      if (statusServidor.active) {
        // O replay traz o texto completo desde o início — o primeiro flush
        // substitui o parcial local, sem duplicar (progresso é idempotente
        // por id de passo).
        this.touchActivity(chatId)
        return this.transport.resumeStream(chatId, signal)
      }

      // O run terminou enquanto a conexão esteve fora. A resposta completa
      // está no banco — o settle dispara o sync que troca o parcial por ela.
      if (
        statusServidor.status === "done" ||
        statusServidor.status === "cancelled"
      ) {
        this.settle(chatId, assistantMessageId, { status: "complete" })
      } else if (statusServidor.status === "error") {
        const msg = "A geração terminou com erro no servidor."
        this.settle(chatId, assistantMessageId, {
          status: "error",
          error: msg,
        })
      } else {
        // Servidor não conhece o run (reiniciou, ou a janela de reanexação
        // passou) — não dá para afirmar que a resposta existe.
        this.settleQueda(chatId, assistantMessageId)
      }
      return null
    }

    if (
      this.isCurrent(chatId, assistantMessageId) &&
      this.runs.get(chatId)?.status === "running"
    ) {
      this.settleQueda(chatId, assistantMessageId)
    }
    return null
  }

  /** Settle de queda sem reanexação: erro com o parcial preservado. */
  private settleQueda(chatId: string, assistantMessageId: string): void {
    const parcial = this.runs.get(chatId)?.assistantText ?? ""
    this.settle(chatId, assistantMessageId, {
      assistantText: parcial
        ? `${parcial}\n\n_${MSG_QUEDA_SEM_REANEXAR}_`
        : `_${MSG_QUEDA_SEM_REANEXAR}_`,
      status: "error",
      error: MSG_QUEDA_SEM_REANEXAR,
    })
  }

  private async consumirFonte(
    chatId: string,
    assistantMessageId: string,
    controller: AbortController,
    fonte: AsyncIterable<ChatStreamChunk>,
  ): Promise<ResultadoConsumo> {
    const { signal } = controller
    let texto = ""

    try {
      for await (const chunk of fonte) {
        // Abandonar o loop sem abortar deixaria o fetch/SSE aberto no servidor.
        if (!this.isCurrent(chatId, assistantMessageId)) {
          controller.abort()
          return { tipo: "assentado" }
        }
        // Parar já settled — descarta o resto do SSE.
        if (this.runs.get(chatId)?.status !== "running") {
          controller.abort()
          return { tipo: "assentado" }
        }
        this.touchActivity(chatId)

        if (chunk.type === "heartbeat") {
          // Só atualiza lastActivity — não mexe na UI.
          continue
        } else if (chunk.type === "text-delta") {
          texto += chunk.textDelta
          this.scheduleTextUi(chatId, assistantMessageId, texto)
        } else if (chunk.type === "progress") {
          this.applyProgress(chatId, assistantMessageId, chunk.event)
        } else if (chunk.type === "error") {
          if (chunk.retriable && !signal.aborted) {
            // Queda de rede/proxy — o run pode continuar vivo no servidor.
            // Consolida o parcial na UI e deixa a reanexação decidir.
            this.flushPendingText(chatId, assistantMessageId)
            return { tipo: "queda" }
          }
          texto = texto
            ? `${texto}\n\n_Erro: ${chunk.message}_`
            : `_Erro: ${chunk.message}_`
          this.settle(chatId, assistantMessageId, {
            assistantText: texto,
            status: "error",
            error: chunk.message,
          })
          controller.abort()
          return { tipo: "assentado" }
        } else if (chunk.type === "done") {
          this.settle(chatId, assistantMessageId, {
            assistantText: texto,
            status: "complete",
          })
          controller.abort()
          return { tipo: "assentado" }
        }
      }

      if (!this.isCurrent(chatId, assistantMessageId)) {
        return { tipo: "assentado" }
      }
      // cancelRun já pode ter settled — não sobrescreve.
      if (this.runs.get(chatId)?.status !== "running") {
        return { tipo: "assentado" }
      }

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
      return { tipo: "assentado" }
    } catch (err) {
      if (!this.isCurrent(chatId, assistantMessageId)) {
        return { tipo: "assentado" }
      }
      if (this.runs.get(chatId)?.status !== "running") {
        return { tipo: "assentado" }
      }
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
      return { tipo: "assentado" }
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
