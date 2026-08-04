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
import { enabledModels } from "../llm/models.js"
import { resolveModelForUser } from "../services/model-access.js"
import { getEffectiveKey, isKeyProvider } from "../services/llm-keys.js"
import { isErroSanitizado } from "../lib/erro-modelo.js"
import { endSSE, initSSE, writeSSE, writeSSEHeartbeat } from "../lib/sse.js"
import { DEXTER_SYSTEM_PROMPT, MULTI_AGENT_PROMPT_BLOCK } from "../llm/system-prompt.js"
import { resolveUser } from "../services/auth.js"
import {
  isMultiAgentAuthorized,
  loadMultiAgentPreferences,
} from "../services/multi-agent-prefs.js"
import {
  getChat,
  getMessages,
  insertMessage,
  upsertChat,
} from "../services/chat-store.js"
import { buildProjectPromptBlock } from "../services/project-store.js"
import {
  getKbPromptContext,
  type KbPromptContext,
} from "../services/kb-store.js"
import {
  connectorsPromptBlock,
  resolveConnectorRuntime,
} from "../connectors/status.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import { resolveAccess, accessSummary, type SystemAccess } from "../systems/access.js"
import {
  formatArtifactsSystemBlock,
  stripArtifactAppendix,
  type ArtifactWire,
} from "../systems/artifacts-context.js"
import { runAgentLoop, type ToolCallRecord } from "../systems/agent-loop.js"
import { runOpenAiAgentLoop } from "../systems/openai-agent-loop.js"
import { auditToolCalls } from "../systems/audit.js"
import { isOpenAiCompatibleProvider } from "../lib/openai-compatible.js"
import { persistChatImageUrl } from "../lib/chat-images.js"
import { generateImageGemini, generateImageOpenAI } from "../lib/images.js"
import {
  classifyImageIntent,
  enrichImagePrompt,
  isImageOutputRequest,
  listChatModels,
  listImageGenModels,
  replyNeedImageModel,
  replyOnImageModelButChat,
} from "../lib/image-intent.js"
import {
  isImageGenerationModel,
  modelAllowsFiles,
  modelAllowsVision,
} from "../llm/capabilities.js"

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

/** Bloco da base de conhecimento GoWork: docs `always_load` inteiros + índice
 * do resto (que o modelo lê sob demanda com kb__buscar). Sem docs → null. */
function formatKbBlock(kb: KbPromptContext | null): string | null {
  if (!kb) return null
  if (kb.alwaysDocs.length === 0 && kb.index.length === 0) return null

  const parts: string[] = ["## Base de conhecimento GoWork"]
  for (const doc of kb.alwaysDocs) {
    parts.push(`### ${doc.title}\n${doc.content}`)
  }
  if (kb.index.length > 0) {
    parts.push(
      "Documentos adicionais (use a tool kb__buscar):\n" +
        kb.index
          .map((d) => `- ${d.slug} — ${d.title} (${d.category})`)
          .join("\n"),
    )
  }
  return parts.join("\n\n")
}

/** Monta o system prompt final: base + projeto + artefatos + mapa de acesso. */
function buildSystemPrompt(
  context: z.infer<typeof chatContextSchema> | undefined,
  access: SystemAccess[],
  projectBlock: string | null,
  artifactsBlock: string | null,
  connectors?: ConnectorRuntime,
  kbContext?: KbPromptContext | null,
  multiAgentEnabled?: boolean,
): string {
  let prompt = DEXTER_SYSTEM_PROMPT
  if (multiAgentEnabled) {
    prompt += `\n\n${MULTI_AGENT_PROMPT_BLOCK}`
  }
  if (context?.system) {
    prompt += `\n\nContexto desta conversa: sistema alvo "${context.system}".`
  }
  if (projectBlock) {
    prompt += `\n\n${projectBlock}`
  }
  if (artifactsBlock) {
    prompt += `\n\n${artifactsBlock}`
  }
  const kbBlock = formatKbBlock(kbContext ?? null)
  if (kbBlock) {
    prompt += `\n\n${kbBlock}`
  }
  prompt +=
    "\n\n## Acesso deste usuário aos sistemas GoWork\n" +
    accessSummary(access) +
    "\n\n## Lembrete operacional (esta conversa)\n" +
    "- Dados só via tools dos sistemas listados acima; sem tool = não sabe.\n" +
    "- Especializada se couber; senão schema→SQL. Zero alucinação; total ≠ lista truncada.\n" +
    "- Análise/investigação = dossiê (fatos + vínculos + implicação). Proibido superficial.\n" +
    "- NetworkGo pessoas = profiles (nunca public.users). Códigos N#### em ticket_number.\n" +
    "- Sem acesso ao sistema ou sem_acesso → diga isso; caso contrário tente consultar.\n" +
    "- Português, assertivo, detalhado quando o pedido for análise."
  if (connectors) {
    prompt += connectorsPromptBlock(connectors)
  }
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

/** Mensagem de erro enviada ao cliente no evento SSE `error`: só faixas
 * conhecidas. Detalhe interno (SQL/PostgREST, payload do provider) fica no
 * log — nunca no stream.
 *
 * O agent loop Anthropic já traduz a falha do provider para português e marca
 * o Error (`erroSanitizado`) — nesse caso a mensagem vai como está, senão as
 * regex abaixo (em inglês, para a mensagem crua de OpenAI/Ollama) jogariam
 * todo o caminho padrão no fallback genérico. */
function mensagemErroCliente(err: unknown): string {
  if (isErroSanitizado(err)) return err.message
  const msg = err instanceof Error ? err.message : ""
  if (/overloaded|529/i.test(msg)) {
    return "O modelo está sobrecarregado agora. Tente novamente em instantes."
  }
  if (/rate.?limit|429|quota/i.test(msg)) {
    return "Limite de requisições atingido. Aguarde um momento e tente novamente."
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(msg)) {
    return "A chamada ao modelo demorou demais e foi interrompida."
  }
  if (/context.?length|too many tokens|maximum context/i.test(msg)) {
    return "O contexto desta conversa ficou grande demais após as consultas. Tente novamente com um pedido mais focado."
  }
  return "Não consegui concluir esta resposta. Tente novamente."
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

    const { userId, email, role } = await resolveUser(request)

    // Preflight de acesso: o que este usuário (por email) enxerga em cada
    // sistema. Vazio se não houver email ou nenhum sistema configurado.
    const access = email ? await resolveAccess(email) : []
    const connectors = await resolveConnectorRuntime(userId)
    const multiAgentPrefs = await loadMultiAgentPreferences(userId)
    const multiAgentEnabled = isMultiAgentAuthorized(multiAgentPrefs)

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
      // Pina a conversa no modelo usado — troca global não afeta chats antigos.
      model: body.context?.model,
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

    // Base de conhecimento da empresa (cache de 60s no store). Falha aqui NÃO
    // derruba o chat — segue sem o bloco, com o motivo no log.
    let kbContext: KbPromptContext | null = null
    try {
      kbContext = await getKbPromptContext()
    } catch (err) {
      request.log.warn({ err }, "base de conhecimento indisponível neste run")
    }

    const systemPrompt = buildSystemPrompt(
      body.context,
      access,
      projectBlock,
      artifactsBlock,
      connectors,
      kbContext,
      multiAgentEnabled,
    )

    // Modelo escolhido na interface (context.model) — catálogo admin + default,
    // respeitando os modelos liberados para este usuário (profiles.allowed_models).
    const modelInfo = await resolveModelForUser(body.context?.model, {
      userId,
      role,
    })

    // Chave efetiva deste request: pessoal do usuário (BYOK) → global → env.
    const providerApiKey = isKeyProvider(modelInfo.provider)
      ? await getEffectiveKey(modelInfo.provider, userId)
      : undefined

    const lastAttachments = lastMessage.attachments ?? []
    if (lastAttachments.length > 0) {
      const wantsImage = lastAttachments.some((a) => a.type === "image")
      const wantsFile = lastAttachments.some((a) => a.type === "document")
      const imageGen = isImageGenerationModel(
        modelInfo.provider,
        modelInfo.model,
      )
      // Geração com referência usa a mesma tag Visão (Nano Banana / gpt-image).
      if (
        wantsImage &&
        !modelAllowsVision(
          modelInfo.provider,
          modelInfo.model,
          modelInfo.capabilities,
        )
      ) {
        reply.code(400).send({
          error: "model_no_vision",
          message: imageGen
            ? "Este modelo de imagem não aceita referência. Use Nano Banana / gpt-image ou gere só com texto."
            : "Este modelo não analisa imagens. Escolha um com a tag Visão.",
        })
        return
      }
      if (
        wantsFile &&
        !modelAllowsFiles(
          modelInfo.provider,
          modelInfo.model,
          modelInfo.capabilities,
        )
      ) {
        reply.code(400).send({
          error: "model_no_files",
          message: imageGen
            ? "Modelos de geração de imagem aceitam só imagens de referência (não PDF)."
            : "Este modelo não lê arquivos/PDF. Escolha um com a tag Arquivos.",
        })
        return
      }
    }

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
    let usedModel = modelInfo.model
    let tokensIn: number | undefined
    let tokensOut: number | undefined
    const toolCalls: ToolCallRecord[] = []

    let assistantMessageId: string | undefined
    let persistido = false
    let persistFalhou = false
    /**
     * Persiste a resposta do assistente — SEMPRE que houver texto, inclusive
     * quando o usuário aperta Parar ou o provider falha no meio. Sem isso o
     * texto aparecia na tela e sumia ao recarregar a conversa (e o par
     * user/assistant ficava desbalanceado no próximo turno). Idempotente.
     *
     * Run sem texto mas com tool calls também grava (placeholder): é o
     * message_id desta linha que liga os passos ao "Ver detalhes" — sem ela a
     * auditoria fica órfã e invisível.
     */
    const persistirResposta = async (): Promise<void> => {
      if (persistido) return
      persistido = true
      const texto = fullText.trim()
      if (!texto && toolCalls.length === 0) return
      const sufixo =
        endReason === "aborted" ? "\n\n_(interrompido pelo usuário)_" : ""
      const corpo =
        texto || "_(sem resposta do modelo — veja os passos desta execução)_"
      try {
        assistantMessageId = await insertMessage({
          chatId: body.threadId,
          userId,
          role: "assistant",
          content: corpo + sufixo,
          model: usedModel,
          tokensIn,
          tokensOut,
          traceId: request.traceId,
        })
      } catch (err) {
        // O front sincroniza a cauda depois do run: sem esta linha a resposta
        // desaparece da tela. Sinaliza para o run terminar em `error`, não em
        // `done` limpo.
        persistFalhou = true
        request.log.error(
          { err, traceId: request.traceId, chatId: body.threadId, endReason },
          "falha ao persistir a resposta do assistente",
        )
      }
    }

    let auditado = false
    /**
     * Auditoria LGPD das tool calls (best-effort) — UM único INSERT em lote,
     * ANTES do `done`: o front refaz `GET /api/chats/:id/steps` ~250 ms depois
     * de o run sair de `running` e aceita a primeira resposta, então gravar
     * depois do stream deixaria o "Ver detalhes" da resposta nova vazio.
     */
    const gravarAuditoria = async (): Promise<void> => {
      if (auditado) return
      auditado = true
      if (toolCalls.length === 0) return
      if (!assistantMessageId) {
        request.log.warn(
          { traceId: request.traceId, chatId: body.threadId, endReason },
          "auditoria sem message_id — os passos não aparecerão em Ver detalhes",
        )
      }
      try {
        await auditToolCalls(
          toolCalls.map((tc) => ({
            chatId: body.threadId,
            userId,
            messageId: assistantMessageId,
            toolName: tc.toolName,
            input: tc.input,
            output: tc.ok ? tc.output : { error: tc.error },
            status: tc.ok ? ("ok" as const) : ("error" as const),
            durationMs: tc.durationMs,
            traceId: request.traceId,
          })),
        )
      } catch (err) {
        request.log.warn(
          { err, traceId: request.traceId, chatId: body.threadId },
          "auditoria das tool calls falhou",
        )
      }
    }

    try {
      const onToolCallEmit = (rec: ToolCallRecord): void => {
        toolCalls.push(rec)
        emit({
          event: "tool-call",
          data: {
            toolCallId: rec.toolName,
            toolName: rec.fn ?? rec.toolName,
            args: rec.input,
          },
        })
      }

      const userPrompt = stripArtifactAppendix(lastMessage.content).trim()
      const references = lastAttachments
        .filter((a) => a.type === "image")
        .map((a) => ({
          mediaType: a.mediaType,
          dataBase64: a.dataBase64,
          name: a.name,
        }))
      const imageIntent = classifyImageIntent(userPrompt, {
        hasImageReferences: references.length > 0,
      })
      const onImageModel = isImageGenerationModel(
        modelInfo.provider,
        modelInfo.model,
      )

      // Modelo de imagem: só gera se a intenção for gerar/editar (evita gastar cota).
      if (onImageModel) {
        if (imageIntent.intent !== "generate") {
          emit({
            event: "progress",
            data: { type: "status", text: "Interpretando pedido" },
          })
          const catalog = await enabledModels()
          fullText = replyOnImageModelButChat(
            modelInfo.label,
            listChatModels(catalog),
            imageIntent,
          )
          emit({ event: "text-delta", data: { textDelta: fullText } })
          endReason = "ok"
        } else {
          emit({
            event: "progress",
            data: {
              type: "status",
              text:
                references.length > 0 ? "Editando com referência" : "Gerando imagem",
            },
          })
          const prompt = enrichImagePrompt(userPrompt || "Gere uma imagem.")
          const img =
            modelInfo.provider === "gemini"
              ? await generateImageGemini({
                  model: modelInfo.model,
                  prompt,
                  references,
                  signal: controller.signal,
                  apiKey: providerApiKey,
                })
              : await generateImageOpenAI({
                  model: modelInfo.model,
                  prompt,
                  references,
                  signal: controller.signal,
                  apiKey: providerApiKey,
                })
          usedModel = img.model
          const storedUrl = await persistChatImageUrl({
            userId,
            chatId: body.threadId,
            imageUrl: img.imageUrl,
          })
          const preface = [
            img.revisedPrompt ? `*Prompt revisado:* ${img.revisedPrompt}` : "",
            img.text?.trim() || "",
          ]
            .filter(Boolean)
            .join("\n\n")
          fullText =
            (preface ? `${preface}\n\n` : "") +
            `![imagem gerada](${storedUrl})`
          emit({ event: "text-delta", data: { textDelta: fullText } })
          endReason = "ok"
        }
      } else if (
        isImageOutputRequest(userPrompt, {
          hasImageReferences: references.length > 0,
        })
      ) {
        // Chat model + pedido claro de imagem: orientar (não alucinar).
        emit({
          event: "progress",
          data: { type: "status", text: "Verificando modelos de imagem" },
        })
        const catalog = await enabledModels()
        fullText = replyNeedImageModel(
          modelInfo.label,
          listImageGenModels(catalog),
          userPrompt,
        )
        emit({ event: "text-delta", data: { textDelta: fullText } })
        endReason = "ok"
      } else if (modelInfo.provider === "anthropic") {
        const result = await runAgentLoop({
          model: modelInfo.model,
          systemPrompt,
          messages: toAnthropicMessages(body.messages),
          access,
          connectors,
          userId,
          email: email ?? "",
          apiKey: providerApiKey,
          signal: controller.signal,
          multiAgentEnabled,
          onTextDelta: (t) => {
            fullText += t
            emit({ event: "text-delta", data: { textDelta: t } })
          },
          onToolCall: onToolCallEmit,
          onProgress: (evt) => emit({ event: "progress", data: evt }),
        })
        usedModel = result.model
        tokensIn = result.inputTokens
        tokensOut = result.outputTokens
        endReason = result.endReason
        steps = result.steps
      } else if (isOpenAiCompatibleProvider(modelInfo.provider)) {
        const result = await runOpenAiAgentLoop({
          provider: modelInfo.provider,
          model: modelInfo.model,
          systemPrompt,
          messages: llmMessages,
          attachments: lastAttachments,
          access,
          connectors,
          userId,
          email: email ?? "",
          apiKey: providerApiKey,
          signal: controller.signal,
          multiAgentEnabled,
          onTextDelta: (t) => {
            fullText += t
            emit({ event: "text-delta", data: { textDelta: t } })
          },
          onToolCall: onToolCallEmit,
          onProgress: (evt) => emit({ event: "progress", data: evt }),
        })
        usedModel = result.model
        tokensIn = result.inputTokens
        tokensOut = result.outputTokens
        endReason = result.endReason
        steps = result.steps
      } else {
        // Ollama — streaming simples (sem tools Anthropic/OpenAI).
        emit({
          event: "progress",
          data: { type: "status", text: "Gerando resposta" },
        })
        const handle = streamChat({
          provider: modelInfo.provider,
          model: modelInfo.model,
          systemPrompt,
          messages: llmMessages,
          signal: controller.signal,
          apiKey: providerApiKey,
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
      await persistirResposta()
      await gravarAuditoria()
      if (persistFalhou) {
        emit({
          event: "error",
          data: {
            message:
              "Não consegui salvar esta resposta no histórico. Copie o texto antes de recarregar a conversa.",
          },
        })
      } else {
        emit({ event: "done", data: {} })
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      endReason = timedOut ? "timeout" : aborted ? "aborted" : "api_error"
      const message = timedOut
        ? "Esta resposta demorou demais e foi interrompida. Toque em Tentar novamente."
        : aborted
          ? "Geração cancelada."
          : mensagemErroCliente(err)

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

      await persistirResposta()
      await gravarAuditoria()
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

    // Rede de segurança: se por algum caminho a resposta/auditoria não foi
    // gravada (ambas idempotentes).
    await persistirResposta()
    await gravarAuditoria()
  })
}
