/**
 * Jobs assíncronos do AgentCore (item 2.1) — o que fica na fila e o que roda
 * inline quando não há Redis.
 *
 * Cada função `agendar*` é o ÚNICO ponto que o resto do código chama: ela tenta
 * enfileirar e, se a fila estiver desligada (dev local sem Redis) ou o enqueue
 * falhar, executa o mesmo trabalho no processo — comportamento idêntico ao de
 * antes da fila existir. Nenhum caminho aqui pode derrubar a resposta do chat.
 *
 * `startJobWorkers` registra os workers no MESMO processo Fastify; com N
 * réplicas o BullMQ garante que cada job é processado uma única vez.
 */
import type { FastifyBaseLogger } from "fastify"

import { config } from "../config.js"
import { enqueue, registerWorker } from "../lib/queue.js"
import { maybeUpdateChatSummary } from "./chat-summary.js"
import { indexarMensagensDoChat } from "./message-embeddings.js"
import {
  executarJobDeWorkflow,
  type WorkflowRunJobData,
} from "./workflow-runner.js"

export interface ChatSummaryJobData {
  chatId: string
  userId: string
  traceId?: string
}

export interface MessageEmbeddingsJobData {
  chatId: string
  userId: string
  /** Janela usada no run — o job indexa só o que ficou FORA dela. */
  janelaMensagens: number
  traceId?: string
}

/**
 * Trabalho pós-run de um turno de chat: resumo rolling (1.7) e indexação do
 * histórico que saiu da janela (1.9). Os dois são acessórios — nunca esperados
 * pelo stream.
 */
export function agendarPosRun(params: {
  chatId: string
  userId: string
  traceId?: string
  log: FastifyBaseLogger
}): void {
  const { chatId, userId, traceId, log } = params

  void (async () => {
    const resumo: ChatSummaryJobData = { chatId, userId, traceId }
    // jobId por chat+trace evita job duplicado se a rota reentrar (retry/abort).
    const enfileirouResumo = await enqueue("chat-summary", resumo, {
      jobId: `summary:${chatId}:${traceId ?? Date.now()}`,
    })
    if (!enfileirouResumo) {
      await maybeUpdateChatSummary({ chatId, userId, traceId, log })
    }
  })()

  void (async () => {
    const embeddings: MessageEmbeddingsJobData = {
      chatId,
      userId,
      janelaMensagens: config.CONTEXT_WINDOW_MESSAGES,
      traceId,
    }
    const enfileirou = await enqueue("message-embeddings", embeddings, {
      jobId: `embed:${chatId}:${traceId ?? Date.now()}`,
    })
    if (!enfileirou) {
      await indexarMensagensDoChat({ ...embeddings, log })
    }
  })()
}

/**
 * Registra os workers deste processo. No-op quando não há Redis.
 *
 * O enfileiramento da execução de workflow mora no próprio `workflow-runner`
 * (é o tick que decide o que está vencido) — aqui só o consumo.
 */
export function startJobWorkers(log: FastifyBaseLogger): void {
  registerWorker<ChatSummaryJobData>(
    "chat-summary",
    async (data, ctx) => {
      await maybeUpdateChatSummary({
        chatId: data.chatId,
        userId: data.userId,
        traceId: data.traceId,
        log: ctx.log,
      })
    },
    log,
    // Sumarização chama o Haiku: concorrência baixa para não virar rajada.
    { concurrency: 2 },
  )

  registerWorker<MessageEmbeddingsJobData>(
    "message-embeddings",
    async (data, ctx) => {
      await indexarMensagensDoChat({
        chatId: data.chatId,
        userId: data.userId,
        janelaMensagens: data.janelaMensagens,
        traceId: data.traceId,
        log: ctx.log,
      })
    },
    log,
    { concurrency: 3 },
  )

  registerWorker<WorkflowRunJobData>(
    "workflow-run",
    async (data, ctx) => {
      await executarJobDeWorkflow(data, ctx.log)
    },
    log,
    // Execução agendada roda o agent loop inteiro (até 5 min) — uma por vez.
    { concurrency: 1 },
  )
}
