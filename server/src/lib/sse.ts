/**
 * Utilitário de Server-Sent Events (SSE) do AgentCore.
 *
 * O formato dos eventos é o CONTRATO com o frontend (web/src/lib/agentcore):
 *
 *   event: text-delta
 *   data: {"textDelta":"olá"}
 *
 *   event: tool-call
 *   data: {"toolCallId":"abc","toolName":"buscar","args":{...}}
 *
 *   event: tool-result
 *   data: {"toolCallId":"abc","result":{...}}
 *
 *   event: error
 *   data: {"message":"..."}
 *
 *   event: done
 *   data: {}
 *
 * Blocos separados por linha em branco (\n\n); `data` é sempre JSON válido.
 */
import type { FastifyReply } from "fastify"

export type SSEEvent =
  | { event: "text-delta"; data: { textDelta: string } }
  | { event: "tool-call"; data: { toolCallId: string; toolName: string; args: unknown } }
  | { event: "tool-result"; data: { toolCallId: string; result: unknown } }
  | { event: "error"; data: { message: string } }
  | { event: "done"; data: Record<string, never> }

/** Prepara os headers e abre o stream SSE na resposta. */
export function initSSE(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
}

/** Escreve um evento SSE no stream. */
export function writeSSE(reply: FastifyReply, evt: SSEEvent): void {
  reply.raw.write(`event: ${evt.event}\n`)
  reply.raw.write(`data: ${JSON.stringify(evt.data)}\n\n`)
}

/** Fecha o stream. */
export function endSSE(reply: FastifyReply): void {
  reply.raw.end()
}
