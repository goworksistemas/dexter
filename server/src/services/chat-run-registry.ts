/**
 * Registro em memória dos runs de chat deste processo — é o que torna o
 * "processar em segundo plano" real.
 *
 * O loop do agente publica os eventos SSE aqui; a resposta do POST /api/chat
 * e as reanexações (GET /api/chat/:threadId/stream) são apenas ASSINANTES.
 * Cliente desconectar (F5, fechar aba, rede caiu) NÃO cancela a geração: ela
 * segue neste processo e a resposta é persistida em `agent_messages` pelo
 * próprio run. Abortam o run apenas o cancelamento explícito
 * (POST /api/chat/:threadId/cancel — botão Parar), a substituição por um run
 * novo do mesmo chat (regenerar/reenviar) e o timeout do run.
 *
 * O registro vive no MESMO processo que executa o loop (o run morre junto com
 * o processo — persistir isto em banco não manteria a geração viva), por isso
 * não há tabela nova: a persistência do resultado continua sendo a de sempre.
 */
import type { SSEEvent } from "../lib/sse.js"

export type ChatRunStatus = "running" | "done" | "error" | "cancelled"

export interface RunAssinante {
  /** Entrega um evento SSE a esta conexão. Falha derruba só o assinante. */
  emitir: (evt: SSEEvent) => void
}

export interface ChatRunEntry {
  chatId: string
  userId: string
  status: ChatRunStatus
  /** Abortar = cancelamento explícito, substituição ou timeout do run. */
  controller: AbortController
  /** Texto do assistente acumulado — replay em uma única text-delta. */
  textoAcumulado: string
  /** Eventos não-texto (progress/tool-call), na ordem — replay ao anexar. */
  eventos: SSEEvent[]
  /** error/done que encerrou o run — replay para quem anexa na janela de graça. */
  eventoTerminal: SSEEvent | null
  assinantes: Set<RunAssinante>
  /** Resolvidos quando o terminal é publicado (ver `aguardarFim`). */
  esperasFim: Set<() => void>
  iniciadoEm: number
}

export interface AnexoRun {
  run: ChatRunEntry
  /** Estado já produzido: progresso + texto acumulado + terminal (se houver). */
  replay: SSEEvent[]
  /** false = o run já terminou (o replay contém o evento terminal). */
  ativo: boolean
}

/**
 * Run encerrado continua reanexável por esta janela — cobre o cliente que
 * reconecta logo depois de a geração terminar (a resposta já está no banco,
 * mas o replay + `done` fecham o ciclo do stream sem erro).
 */
const TTL_APOS_FIM_MS = 60_000

export class ChatRunRegistry {
  private readonly runs = new Map<string, ChatRunEntry>()
  private readonly limpezas = new Map<string, NodeJS.Timeout>()
  private readonly ttlAposFimMs: number

  constructor(ttlAposFimMs: number = TTL_APOS_FIM_MS) {
    this.ttlAposFimMs = ttlAposFimMs
  }

  /**
   * Registra um run novo. Se já houver geração em andamento no mesmo chat, a
   * anterior é abortada — mesma semântica do front (reenviar/regenerar
   * substitui a geração corrente).
   */
  iniciar(params: {
    chatId: string
    userId: string
    controller: AbortController
  }): ChatRunEntry {
    const anterior = this.runs.get(params.chatId)
    if (anterior && anterior.status === "running") {
      anterior.status = "cancelled"
      anterior.controller.abort()
    }
    const limpeza = this.limpezas.get(params.chatId)
    if (limpeza) {
      clearTimeout(limpeza)
      this.limpezas.delete(params.chatId)
    }

    const run: ChatRunEntry = {
      chatId: params.chatId,
      userId: params.userId,
      status: "running",
      controller: params.controller,
      textoAcumulado: "",
      eventos: [],
      eventoTerminal: null,
      assinantes: new Set(),
      esperasFim: new Set(),
      iniciadoEm: Date.now(),
    }
    this.runs.set(params.chatId, run)
    return run
  }

  assinar(run: ChatRunEntry, assinante: RunAssinante): void {
    run.assinantes.add(assinante)
  }

  desassinar(run: ChatRunEntry, assinante: RunAssinante): void {
    run.assinantes.delete(assinante)
  }

  /**
   * Publica um evento do run: acumula no buffer de replay e repassa aos
   * assinantes conectados. `error`/`done` marcam o terminal — depois dele
   * nada mais é publicado (o encerramento é idempotente).
   */
  publicar(run: ChatRunEntry, evt: SSEEvent): void {
    if (run.eventoTerminal) return

    if (evt.event === "text-delta") {
      run.textoAcumulado += evt.data.textDelta
    } else if (evt.event === "error" || evt.event === "done") {
      run.eventoTerminal = evt
      if (evt.event === "error") {
        run.status = "error"
      } else if (run.status === "running") {
        run.status = "done"
      }
      this.agendarLimpeza(run)
      for (const resolver of run.esperasFim) resolver()
      run.esperasFim.clear()
    } else {
      run.eventos.push(evt)
    }

    // Remover o elemento corrente durante a iteração de um Set é seguro.
    for (const assinante of run.assinantes) {
      try {
        assinante.emitir(evt)
      } catch {
        run.assinantes.delete(assinante)
      }
    }
  }

  /**
   * Garante o evento terminal nos caminhos que encerram sem emitir nada no
   * stream (cancelamento pelo botão Parar). Sem isso, quem reanexasse ficaria
   * pendurado esperando um `done` que nunca vem. No-op se o run já terminou.
   */
  encerrar(run: ChatRunEntry, statusFinal: ChatRunStatus): void {
    if (run.eventoTerminal) return
    if (statusFinal !== "running") {
      run.status = statusFinal
    }
    this.publicar(run, { event: "done", data: {} })
  }

  /** Run do chat (ativo ou na janela pós-fim). Ownership obrigatório. */
  obter(chatId: string, userId: string): ChatRunEntry | null {
    const run = this.runs.get(chatId)
    if (!run || run.userId !== userId) return null
    return run
  }

  /**
   * Anexa uma conexão nova ao run: devolve o replay do que já foi produzido e
   * registra o assinante para os eventos ao vivo (só enquanto o run roda).
   * `null` = não há run conhecido para este chat/usuário.
   */
  anexar(
    chatId: string,
    userId: string,
    assinante: RunAssinante,
  ): AnexoRun | null {
    const run = this.obter(chatId, userId)
    if (!run) return null

    const replay: SSEEvent[] = [...run.eventos]
    if (run.textoAcumulado) {
      replay.push({
        event: "text-delta",
        data: { textDelta: run.textoAcumulado },
      })
    }
    if (run.eventoTerminal) {
      replay.push(run.eventoTerminal)
    }

    const ativo = run.status === "running"
    if (ativo) {
      run.assinantes.add(assinante)
    }
    return { run, replay, ativo }
  }

  /**
   * Resolve quando o run publica o terminal — que só acontece DEPOIS de a
   * resposta (mesmo parcial) ser persistida em `agent_messages`. É o que
   * permite ao cancelamento devolver 204 sem corrida: quem cancela para
   * refazer (retry) pode truncar o histórico sabendo que o run antigo não
   * vai gravar nada depois. `timeoutMs` evita pendurar num loop preso.
   */
  aguardarFim(run: ChatRunEntry, timeoutMs: number): Promise<void> {
    if (run.eventoTerminal) return Promise.resolve()
    return new Promise((resolve) => {
      const resolver = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        run.esperasFim.delete(resolver)
        resolve()
      }, timeoutMs)
      timer.unref()
      run.esperasFim.add(resolver)
    })
  }

  /** Cancela a geração em andamento (botão Parar). false = nada rodando. */
  cancelar(chatId: string, userId: string): boolean {
    const run = this.obter(chatId, userId)
    if (!run || run.status !== "running") return false
    run.status = "cancelled"
    run.controller.abort()
    return true
  }

  private agendarLimpeza(run: ChatRunEntry): void {
    // Run já substituído por outro não agenda nada — sai do mapa pelo novo.
    if (this.runs.get(run.chatId) !== run) return
    const anterior = this.limpezas.get(run.chatId)
    if (anterior) clearTimeout(anterior)
    const timer = setTimeout(() => {
      this.limpezas.delete(run.chatId)
      if (this.runs.get(run.chatId) === run) {
        this.runs.delete(run.chatId)
      }
    }, this.ttlAposFimMs)
    // Não pode segurar o processo vivo no shutdown.
    timer.unref()
    this.limpezas.set(run.chatId, timer)
  }
}

/** Instância única do processo — compartilhada pelas rotas de chat. */
export const chatRunRegistry = new ChatRunRegistry()
