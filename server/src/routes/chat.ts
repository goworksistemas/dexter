/**
 * POST /api/chat — streaming SSE do Dexter.
 *
 * Contrato com o front: web/src/lib/agentcore/contract.ts (read-only).
 * `threadId` é o agent_chats.id (UUID gerado pelo front) — upsert por esse id.
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import { streamChat, type LlmMessage } from "../llm/router.js"
import { resolveModel } from "../llm/models.js"
import { endSSE, initSSE, writeSSE, writeSSEHeartbeat } from "../lib/sse.js"
import { DEXTER_SYSTEM_PROMPT } from "../llm/system-prompt.js"
import { resolveUser } from "../services/auth.js"
import {
  getChat,
  getMessages,
  insertMessage,
  upsertChat,
} from "../services/chat-store.js"
import { buildProjectPromptBlock } from "../services/project-store.js"
import { resolveAccess, accessSummary, type SystemAccess } from "../systems/access.js"
import {
  formatArtifactsSystemBlock,
  stripArtifactAppendix,
  type ArtifactWire,
} from "../systems/artifacts-context.js"
import { runAgentLoop, type ToolCallRecord } from "../systems/agent-loop.js"
import { auditToolCall } from "../systems/audit.js"

const attachmentSchema = z.object({
  type: z.enum(["image", "document"]),
  name: z.string(),
  mediaType: z.string(),
  dataBase64: z.string(),
})

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
})

const artifactWireSchema = z.object({
  kind: z.enum(["html", "markdown"]),
  title: z.string(),
  content: z.string(),
  version: z.number().int().positive(),
  is_truncated: z.boolean().optional(),
})

const chatContextSchema = z
  .object({
    system: z.string().optional(),
    tenantId: z.string().optional(),
    /** id do modelo escolhido na UI (ver GET /api/models). */
    model: z.string().optional(),
    /** projeto ativo ao criar a conversa (persistido no upsert se chat novo). */
    projectId: z.string().uuid().optional(),
    /** Versão atual dos artefatos — vai ao system prompt, NÃO à bolha do user. */
    artifacts: z.array(artifactWireSchema).optional(),
  })
  .passthrough()

const chatRequestSchema = z.object({
  threadId: z.string().uuid(),
  messages: z.array(chatMessageSchema).min(1),
  context: chatContextSchema.optional(),
})

/** Monta o system prompt final: base + projeto + artefatos + mapa de acesso. */
function buildSystemPrompt(
  context: z.infer<typeof chatContextSchema> | undefined,
  access: SystemAccess[],
  projectBlock: string | null,
  artifactsBlock: string | null,
): string {
  let prompt = DEXTER_SYSTEM_PROMPT
  if (context?.system) {
    prompt += `\n\nContexto desta conversa: sistema alvo "${context.system}".`
  }
  if (projectBlock) {
    prompt += `\n\n${projectBlock}`
  }
  if (artifactsBlock) {
    prompt += `\n\n${artifactsBlock}`
  }
  prompt +=
    "\n\n## Acesso deste usuário aos sistemas GoWork\n" +
    accessSummary(access) +
    "\n\nRegras de dados:\n" +
    "- Para responder sobre dados de um sistema que o usuário acessa, USE as tools (elas retornam o dado real, já no escopo dele).\n" +
    "- Prefira tools especializadas quando couberem; senão schema→SQL cobre qualquer tabela read-only.\n" +
    "- Contagem por empresa/cliente/unidade: resolver cadastro (companies etc.) + contar via FK (company_id); NUNCA só p_texto no título.\n" +
    "- Total exato = count(*) ou total_encontrado — NUNCA conte itens de lista truncada.\n" +
    "- Se o usuário acessa o sistema, NÃO diga que não tem acesso/informação sem tentar schema→SQL.\n" +
    "- NUNCA invente números, valores ou listas — só afirme o que as tools retornarem.\n" +
    "- Se a tool retornar erro de acesso, ou o usuário perguntar sobre um sistema que ele NÃO acessa, diga que ele não tem acesso àquele dado.\n" +
    "- Responda em português, de forma objetiva."
  return prompt
}

/** Converte as mensagens do request para o formato Anthropic, incluindo os
 * anexos (imagem/PDF) da ÚLTIMA mensagem do usuário como blocos de conteúdo
 * (visão do Claude). Histórico anterior vai como texto simples.
 * Apêndice legado de artefatos é removido do content (fica só no system). */
function toAnthropicMessages(
  msgs: z.infer<typeof chatRequestSchema>["messages"]
): Anthropic.MessageParam[] {
  const nonSystem = msgs.filter((m) => m.role !== "system")
  return nonSystem.map((m, i) => {
    const content = stripArtifactAppendix(m.content)
    const isLast = i === nonSystem.length - 1
    if (isLast && m.role === "user" && m.attachments && m.attachments.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = []
      for (const a of m.attachments) {
        if (a.type === "image") {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: a.mediaType as "image/png",
              data: a.dataBase64,
            },
          })
        } else {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: a.dataBase64 },
          })
        }
      }
      if (content) blocks.push({ type: "text", text: content })
      return { role: "user", content: blocks }
    }
    return { role: m.role as "user" | "assistant", content }
  })
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
    const title = isNewChat
      ? stripArtifactAppendix(lastMessage.content).slice(0, 60)
      : undefined

    await upsertChat({
      id: body.threadId,
      userId,
      agent: "dexter",
      channel: "web",
      system: body.context?.system,
      tenantId: body.context?.tenantId,
      title,
      projectId: body.context?.projectId ?? null,
    })

    // Texto limpo do usuário (sem apêndice legado de artefatos).
    const userText = stripArtifactAppendix(lastMessage.content)

    // Regenerar / retry: se a última mensagem persistida já é este mesmo
    // turno do usuário, não duplica o insert (o front truncou só a resposta).
    const lastStored = existingMessages[existingMessages.length - 1]
    const lastStoredClean = lastStored
      ? stripArtifactAppendix(lastStored.content)
      : ""
    const alreadyStoredUser =
      lastStored?.role === "user" && lastStoredClean === userText
    if (!alreadyStoredUser) {
      await insertMessage({
        chatId: body.threadId,
        userId,
        role: "user",
        content: userText,
        traceId: request.traceId,
      })
    }

    const llmMessages: LlmMessage[] = body.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: stripArtifactAppendix(m.content),
      }))

    // Instruções/arquivos do projeto: prioriza o project_id persistido no chat.
    const chatRow = await getChat(body.threadId, userId)
    const projectId = chatRow?.project_id ?? body.context?.projectId ?? null
    const projectBlock = projectId
      ? await buildProjectPromptBlock(projectId, userId)
      : null

    const artifactsFromContext = (body.context?.artifacts ?? []) as ArtifactWire[]
    const artifactsBlock = formatArtifactsSystemBlock(artifactsFromContext)

    const systemPrompt = buildSystemPrompt(
      body.context,
      access,
      projectBlock,
      artifactsBlock,
    )

    // Modelo escolhido na interface (context.model) — cai no default se ausente.
    const modelInfo = resolveModel(body.context?.model)

    initSSE(reply)

    // Abort quando o cliente fecha a conexão (botão Parar / tab). Troca de
    // conversa no SPA NÃO fecha o fetch — o ChatRunsStore mantém o reader.
    const controller = new AbortController()
    let clientOpen = true
    let timedOut = false
    request.raw.on("close", () => {
      clientOpen = false
      controller.abort()
    })

    const emit = (evt: Parameters<typeof writeSSE>[1]): void => {
      if (!clientOpen) return
      try {
        writeSSE(reply, evt)
      } catch {
        clientOpen = false
      }
    }

    // Keepalive: evita proxy/idle drop e dá sinal de vida ao front.
    const heartbeat = setInterval(() => {
      if (!clientOpen) return
      try {
        writeSSEHeartbeat(reply)
      } catch {
        clientOpen = false
      }
    }, 15_000)

    const runTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.AGENT_RUN_TIMEOUT_MS)

    let fullText = ""
    let endReason: string = "ok"
    let steps = 0
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
          messages: toAnthropicMessages(body.messages),
          access,
          email: email ?? "",
          signal: controller.signal,
          onTextDelta: (t) => {
            fullText += t
            emit({ event: "text-delta", data: { textDelta: t } })
          },
          onToolCall: (rec) => {
            toolCalls.push(rec)
            emit({
              event: "tool-call",
              data: {
                toolCallId: rec.toolName,
                toolName: rec.fn ?? rec.toolName,
                args: rec.input,
              },
            })
          },
          onProgress: (evt) => emit({ event: "progress", data: evt }),
        })
        usedModel = result.model
        tokensIn = result.inputTokens
        tokensOut = result.outputTokens
        endReason = result.endReason
        steps = result.steps
      } else {
        // Provider sem tools (ex.: self-hosted) — streaming simples.
        emit({ event: "progress", data: { type: "status", text: "Gerando resposta" } })
        const handle = streamChat({
          provider: modelInfo.provider,
          model: modelInfo.model,
          systemPrompt,
          messages: llmMessages,
          signal: controller.signal,
        })
        for await (const delta of handle.textDeltas) {
          fullText += delta
          emit({ event: "text-delta", data: { textDelta: delta } })
        }
        const result = await handle.result()
        usedModel = result.model
        tokensIn = result.inputTokens
        tokensOut = result.outputTokens
        endReason = fullText.trim() ? "ok" : "empty"
      }

      if (!fullText.trim() && timedOut) {
        fullText =
          "Esta resposta demorou demais e foi interrompida. Toque em **Tentar novamente**."
        endReason = "timeout"
        emit({ event: "text-delta", data: { textDelta: fullText } })
      }

      const assistantMessageId = await insertMessage({
        chatId: body.threadId,
        userId,
        role: "assistant",
        content: fullText,
        model: usedModel,
        tokensIn,
        tokensOut,
        traceId: request.traceId,
      })

      // Auditoria LGPD de cada tool call (best-effort). O message_id liga os
      // passos à resposta — é o que alimenta o "Ver detalhes" no histórico.
      for (const tc of toolCalls) {
        await auditToolCall({
          chatId: body.threadId,
          userId,
          messageId: assistantMessageId,
          toolName: tc.toolName,
          input: tc.input,
          output: tc.ok ? tc.output : { error: tc.error },
          status: tc.ok ? "ok" : "error",
          durationMs: tc.durationMs,
          traceId: request.traceId,
        })
      }

      request.log.info(
        {
          traceId: request.traceId,
          chatId: body.threadId,
          endReason,
          steps,
          chars: fullText.length,
        },
        "chat run ended",
      )
      emit({ event: "done", data: {} })
    } catch (err) {
      const aborted = controller.signal.aborted
      endReason = timedOut ? "timeout" : aborted ? "aborted" : "api_error"
      const message = timedOut
        ? "Esta resposta demorou demais e foi interrompida. Toque em Tentar novamente."
        : aborted
          ? "Geração cancelada."
          : err instanceof Error
            ? err.message
            : "erro desconhecido"

      request.log.error(
        {
          err,
          traceId: request.traceId,
          chatId: body.threadId,
          endReason,
          steps,
        },
        "erro no streaming do chat",
      )

      if (!aborted || timedOut) {
        emit({ event: "error", data: { message } })
      }
    } finally {
      clearInterval(heartbeat)
      clearTimeout(runTimer)
      if (clientOpen) {
        endSSE(reply)
      } else {
        try {
          reply.raw.end()
        } catch {
          /* já fechado */
        }
      }
    }
  })
}
