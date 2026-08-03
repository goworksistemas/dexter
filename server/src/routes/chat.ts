/**
 * POST /api/chat — streaming SSE do Dexter.
 *
 * Contrato com o front: web/src/lib/agentcore/contract.ts (read-only).
 * `threadId` é o agent_chats.id (UUID gerado pelo front) — upsert por esse id.
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type Anthropic from "@anthropic-ai/sdk"

import { streamChat, type LlmMessage } from "../llm/router.js"
import { resolveModel } from "../llm/models.js"
import { endSSE, initSSE, writeSSE } from "../lib/sse.js"
import { DEXTER_SYSTEM_PROMPT } from "../llm/system-prompt.js"
import { resolveUser } from "../services/auth.js"
import { getMessages, insertMessage, upsertChat } from "../services/chat-store.js"
import { resolveAccess, accessSummary, type SystemAccess } from "../systems/access.js"
import { runAgentLoop, type ToolCallRecord } from "../systems/agent-loop.js"
import { auditToolCall } from "../systems/audit.js"

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

/** Monta o system prompt final: base + contexto + o que o usuário acessa. */
function buildSystemPrompt(
  context: z.infer<typeof chatContextSchema> | undefined,
  access: SystemAccess[]
): string {
  let prompt = DEXTER_SYSTEM_PROMPT
  if (context?.system) {
    prompt += `\n\nContexto desta conversa: sistema alvo "${context.system}".`
  }
  prompt +=
    "\n\n## Acesso deste usuário aos sistemas GoWork\n" +
    accessSummary(access) +
    "\n\nRegras de dados:\n" +
    "- Para responder sobre dados de um sistema que o usuário acessa, USE as tools (elas retornam o dado real, já no escopo dele).\n" +
    "- NUNCA invente números, valores ou listas — só afirme o que as tools retornarem.\n" +
    "- Se a tool retornar erro de acesso, ou o usuário perguntar sobre um sistema que ele não acessa, diga que ele não tem acesso àquele dado.\n" +
    "- Responda em português, de forma objetiva."
  return prompt
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

    const { userId, email } = await resolveUser(request)

    // Preflight de acesso: o que este usuário (por email) enxerga em cada
    // sistema. Vazio se não houver email ou nenhum sistema configurado.
    const access = email ? await resolveAccess(email) : []

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

    const systemPrompt = buildSystemPrompt(body.context, access)

    // Modelo escolhido na interface (context.model) — cai no default se ausente.
    const modelInfo = resolveModel(body.context?.model)

    initSSE(reply)

    const controller = new AbortController()
    request.raw.on("close", () => controller.abort())

    let fullText = ""
    try {
      let usedModel = modelInfo.model
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      const toolCalls: ToolCallRecord[] = []

      if (modelInfo.provider === "anthropic") {
        // Caminho com tools: o Claude pode consultar os sistemas via RPCs
        // read-only com gate. O backend injeta o email do usuário autenticado
        // em cada chamada — o LLM nunca escolhe de quem é o dado.
        const result = await runAgentLoop({
          model: modelInfo.model,
          systemPrompt,
          messages: llmMessages as Anthropic.MessageParam[],
          access,
          email: email ?? "",
          signal: controller.signal,
          onTextDelta: (t) => {
            fullText += t
            writeSSE(reply, { event: "text-delta", data: { textDelta: t } })
          },
          onToolCall: (rec) => {
            toolCalls.push(rec)
            writeSSE(reply, {
              event: "tool-call",
              data: { toolCallId: rec.toolName, toolName: rec.fn ?? rec.toolName, args: rec.input },
            })
          },
        })
        usedModel = result.model
        tokensIn = result.inputTokens
        tokensOut = result.outputTokens
      } else {
        // Provider sem tools (ex.: self-hosted) — streaming simples.
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
        usedModel = result.model
        tokensIn = result.inputTokens
        tokensOut = result.outputTokens
      }

      await insertMessage({
        chatId: body.threadId,
        userId,
        role: "assistant",
        content: fullText,
        model: usedModel,
        tokensIn,
        tokensOut,
        traceId: request.traceId,
      })

      // Auditoria LGPD de cada tool call (best-effort).
      for (const tc of toolCalls) {
        await auditToolCall({
          chatId: body.threadId,
          userId,
          toolName: tc.toolName,
          input: tc.input,
          output: tc.ok ? tc.output : { error: tc.error },
          status: tc.ok ? "ok" : "error",
          durationMs: tc.durationMs,
          traceId: request.traceId,
        })
      }

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
