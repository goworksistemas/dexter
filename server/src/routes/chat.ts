/**
 * POST /api/chat — streaming SSE do Dexter.
 *
 * Contrato com o front: web/src/lib/agentcore/contract.ts (read-only).
 * `threadId` é o agent_chats.id (UUID gerado pelo front) — upsert por esse id.
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { streamChat, type LlmMessage } from "../llm/router.js"
import { resolveModel } from "../llm/models.js"
import { endSSE, initSSE, writeSSE } from "../lib/sse.js"
import { DEXTER_SYSTEM_PROMPT } from "../llm/system-prompt.js"
import { resolveUser } from "../services/auth.js"
import { getMessages, insertMessage, upsertChat } from "../services/chat-store.js"

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().optional(),
})

const chatContextSchema = z
  .object({
    system: z.string().optional(),
    tenantId: z.string().optional(),
    /** id do modelo escolhido na UI (ver GET /api/models). */
    model: z.string().optional(),
  })
  .passthrough()

const chatRequestSchema = z.object({
  threadId: z.string().uuid(),
  messages: z.array(chatMessageSchema).min(1),
  context: chatContextSchema.optional(),
})

/** Monta o system prompt final, citando o sistema-alvo quando informado. */
function buildSystemPrompt(context: z.infer<typeof chatContextSchema> | undefined): string {
  if (!context?.system) return DEXTER_SYSTEM_PROMPT
  return `${DEXTER_SYSTEM_PROMPT}\n\nContexto desta conversa: sistema alvo "${context.system}".`
}

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data

    const lastMessage = body.messages[body.messages.length - 1]
    if (!lastMessage || lastMessage.role !== "user") {
      reply.code(400).send({ error: "última mensagem do array precisa ser do usuário" })
      return
    }

    const { userId } = await resolveUser(request)

    // Se ainda não há mensagens no chat, é uma conversa nova — usa a 1ª
    // mensagem do usuário (truncada) como título.
    const existingMessages = await getMessages(body.threadId, userId)
    const isNewChat = existingMessages.length === 0
    const title = isNewChat ? lastMessage.content.slice(0, 60) : undefined

    await upsertChat({
      id: body.threadId,
      userId,
      agent: "dexter",
      channel: "web",
      system: body.context?.system,
      tenantId: body.context?.tenantId,
      title,
    })

    await insertMessage({
      chatId: body.threadId,
      userId,
      role: "user",
      content: lastMessage.content,
      traceId: request.traceId,
    })

    const llmMessages: LlmMessage[] = body.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

    const systemPrompt = buildSystemPrompt(body.context)

    // Modelo escolhido na interface (context.model) — cai no default se ausente.
    const modelInfo = resolveModel(body.context?.model)

    initSSE(reply)

    const controller = new AbortController()
    request.raw.on("close", () => controller.abort())

    let fullText = ""
    try {
      const handle = streamChat({
        provider: modelInfo.provider,
        model: modelInfo.model,
        systemPrompt,
        messages: llmMessages,
        signal: controller.signal,
      })

      for await (const delta of handle.textDeltas) {
        fullText += delta
        writeSSE(reply, { event: "text-delta", data: { textDelta: delta } })
      }

      const result = await handle.result()

      await insertMessage({
        chatId: body.threadId,
        userId,
        role: "assistant",
        content: fullText,
        model: result.model,
        tokensIn: result.inputTokens,
        tokensOut: result.outputTokens,
        traceId: request.traceId,
      })

      writeSSE(reply, { event: "done", data: {} })
    } catch (err) {
      request.log.error({ err, traceId: request.traceId }, "erro no streaming do chat")
      writeSSE(reply, {
        event: "error",
        data: { message: err instanceof Error ? err.message : "erro desconhecido" },
      })
    } finally {
      endSSE(reply)
    }
  })
}
