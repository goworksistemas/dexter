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
import { enabledModels, responseMaxTokens } from "../llm/models.js"
import { resolveModelForUser } from "../services/model-access.js"
import { getEffectiveKey, isKeyProvider, listUserKeys } from "../services/llm-keys.js"
import { keySourceForProvider } from "../llm/model-catalog-meta.js"
import {
  buildModelCreditContext,
  modelIsAvailableWithCredit,
  recordQuotaError,
} from "../services/provider-credit.js"
import { computeMessageCostUsd } from "../services/model-pricing.js"
import { isErroSanitizado } from "../lib/erro-modelo.js"
import { endSSE, initSSE, writeSSE, writeSSEHeartbeat } from "../lib/sse.js"
import {
  DEXTER_SYSTEM_PROMPT,
  MULTI_AGENT_PROMPT_BLOCK,
  flattenSystemPrompt,
  type SystemPromptParts,
} from "../llm/system-prompt.js"
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
import { aplicarJanela } from "../services/context-window.js"
import { getChatSummary } from "../services/chat-summary.js"
import {
  consumirCotaDeChat,
  mensagemLimiteAtingido,
} from "../services/chat-rate-limit.js"
import {
  ajustarContexto,
  juntarBlocosDinamicos,
  type BlocoDinamico,
} from "../services/context-budget.js"
import { agendarPosRun } from "../services/jobs.js"
import {
  chatRunRegistry,
  type RunAssinante,
} from "../services/chat-run-registry.js"
import {
  buscarTrechosRelevantes,
  formatarBlocoRag,
} from "../services/message-embeddings.js"
import {
  criarGuardaOrcamento,
  invalidarCacheDeGasto,
} from "../services/run-budget.js"
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
  formatArtifactsTitlesBlock,
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

/**
 * Formato atual: só a mensagem NOVA vai no fio — o histórico o server carrega
 * de `agent_messages`. `messages[]` é o formato legado (front antigo ainda no
 * ar durante o deploy): dele só a última mensagem é aproveitada, o resto vem
 * do banco do mesmo jeito.
 */
const chatRequestSchema = z
  .object({
    threadId: z.string().uuid(),
    message: chatMessageSchema.optional(),
    messages: z.array(chatMessageSchema).min(1).optional(),
    context: chatContextSchema.optional(),
  })
  .refine((body) => body.message != null || (body.messages?.length ?? 0) > 0, {
    message: "informe `message` (mensagem nova) ou `messages` (formato legado)",
    path: ["message"],
  })

/**
 * Aviso no fim do system prompt quando a janela deslizante cortou histórico e
 * ainda NÃO existe resumo cobrindo o trecho (conversa que acabou de passar da
 * janela, ou sumarização que falhou).
 */
const NOTA_HISTORICO_CORTADO =
  "Nota: esta conversa tem histórico anterior não incluído; se o usuário " +
  "referenciar algo antigo que você não vê, diga que precisa que ele repita a informação."

/** Bloco da base de conhecimento GoWork: docs `always_load` (já capados pelo
 * kb-store) + índice do resto, que o modelo lê sob demanda com kb__buscar.
 * Sem docs → null. */
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

interface SystemPromptInput {
  context: z.infer<typeof chatContextSchema> | undefined
  access: SystemAccess[]
  projectBlock: string | null
  artifactsBlock: string | null
  /** Índice dos artefatos (sem conteúdo) — usado se o contexto estourar. */
  artifactsTitlesBlock: string | null
  connectors?: ConnectorRuntime
  kbContext?: KbPromptContext | null
  multiAgentEnabled?: boolean
  /** Houve corte da janela deslizante — avisa o modelo no fim do prompt. */
  historicoCortado?: boolean
  /** Resumo rolling do trecho cortado (services/chat-summary.ts). */
  resumoHistorico?: string | null
  /** Trechos antigos recuperados por similaridade (services/message-embeddings). */
  ragBlock?: string | null
}

interface SystemPromptMontado {
  staticBlock: string
  /** Blocos do dinâmico na ordem final — tipados para o context-budget. */
  blocos: BlocoDinamico[]
}

/**
 * Monta o system prompt em duas partes para o prompt caching da Anthropic:
 *  - estático: base do Dexter + bloco multi-agentes + base de conhecimento
 *    (muda no máximo quando o admin edita a KB — o kb-store já cacheia 60s);
 *  - dinâmico: sistema alvo, projeto, artefatos, acesso, lembrete operacional,
 *    conectores, resumo/RAG do histórico (muda a cada conversa/turno).
 *
 * O dinâmico sai como lista TIPADA (não string única) porque o gerente de
 * orçamento (services/context-budget.ts) precisa saber o que pode degradar sem
 * reordenar o prompt.
 */
function buildSystemPrompt(input: SystemPromptInput): SystemPromptMontado {
  let staticBlock = DEXTER_SYSTEM_PROMPT
  if (input.multiAgentEnabled) {
    staticBlock += `\n\n${MULTI_AGENT_PROMPT_BLOCK}`
  }
  const kbBlock = formatKbBlock(input.kbContext ?? null)
  if (kbBlock) {
    staticBlock += `\n\n${kbBlock}`
  }

  const blocos: BlocoDinamico[] = []
  if (input.context?.system) {
    blocos.push({
      tipo: "outro",
      texto: `Contexto desta conversa: sistema alvo "${input.context.system}".`,
    })
  }
  if (input.projectBlock) {
    blocos.push({ tipo: "outro", texto: input.projectBlock })
  }
  if (input.artifactsBlock) {
    blocos.push({
      tipo: "artefatos",
      texto: input.artifactsBlock,
      titulos: input.artifactsTitlesBlock ?? input.artifactsBlock,
    })
  }
  blocos.push({
    tipo: "outro",
    texto:
      "## Acesso deste usuário aos sistemas GoWork\n" +
      accessSummary(input.access),
  })
  blocos.push({
    tipo: "outro",
    texto:
      "## Lembrete operacional (esta conversa)\n" +
      "- Dados só via tools dos sistemas listados acima; sem tool = não sabe.\n" +
      "- Especializada se couber; senão schema→SQL. Zero alucinação; total ≠ lista truncada.\n" +
      "- Análise/investigação = dossiê (fatos + vínculos + implicação). Proibido superficial.\n" +
      "- NetworkGo pessoas = profiles (nunca public.users). Códigos N#### em ticket_number.\n" +
      "- Sem acesso ao sistema ou sem_acesso → diga isso; caso contrário tente consultar.\n" +
      "- Português, assertivo, detalhado quando o pedido for análise.",
  })
  if (input.connectors) {
    const bloco = connectorsPromptBlock(input.connectors).trim()
    if (bloco) blocos.push({ tipo: "outro", texto: bloco })
  }
  // Com resumo, o modelo recebe o conteúdo do trecho cortado em vez do aviso
  // genérico de "peça para o usuário repetir".
  if (input.resumoHistorico) {
    blocos.push({
      tipo: "resumo",
      texto:
        "## Resumo do histórico anterior desta conversa\n" +
        input.resumoHistorico,
    })
  } else if (input.historicoCortado) {
    blocos.push({ tipo: "outro", texto: NOTA_HISTORICO_CORTADO })
  }
  // Resumo (visão geral) e RAG (detalhe pontual) são complementares: quando os
  // dois existem, os dois entram.
  if (input.ragBlock) {
    blocos.push({ tipo: "rag", texto: input.ragBlock })
  }

  return { staticBlock, blocos }
}

/** Histórico (já limpo e dentro da janela) + mensagem nova no formato
 * Anthropic. Os anexos (imagem/PDF) da mensagem nova viram blocos de conteúdo
 * (visão do Claude); o histórico vai como texto simples. */
function toAnthropicMessages(
  historico: LlmMessage[],
  nova: {
    content: string
    attachments?: z.infer<typeof attachmentSchema>[]
  },
): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = historico.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  const anexos = nova.attachments ?? []
  if (anexos.length === 0) {
    msgs.push({ role: "user", content: nova.content })
    return msgs
  }

  const blocks: Anthropic.ContentBlockParam[] = []
  for (const a of anexos) {
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
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: a.dataBase64,
        },
      })
    }
  }
  if (nova.content) blocks.push({ type: "text", text: nova.content })
  msgs.push({ role: "user", content: blocks })
  return msgs
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

    // Formato novo (`message`) ou legado (última do `messages[]`) — o resto do
    // histórico vem do banco nos dois casos.
    const novaMensagem =
      body.message ?? body.messages?.[body.messages.length - 1]
    if (!novaMensagem || novaMensagem.role !== "user") {
      reply.code(400).send({ error: "a mensagem enviada precisa ser do usuário" })
      return
    }

    const { userId, email, role } = await resolveUser(request)

    // Rate limit por USUÁRIO (item 4.3). O limitador global do index.ts é por
    // IP e, atrás do Traefik, o escritório inteiro divide o mesmo — por isso
    // esta camada, que só existe depois da autenticação.
    const cota = await consumirCotaDeChat(userId)
    if (!cota.permitido) {
      request.log.warn(
        {
          traceId: request.traceId,
          userId,
          usadas: cota.usadas,
          limite: cota.limite,
        },
        "rate limit por usuário atingido no /api/chat",
      )
      reply
        .code(429)
        .header("retry-after", String(cota.retryAfterSec))
        .send({
          error: "rate_limited",
          message: mensagemLimiteAtingido(cota),
        })
      return
    }

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
      ? stripArtifactAppendix(novaMensagem.content).slice(0, 60)
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
    const userText = stripArtifactAppendix(novaMensagem.content)

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

    // Contexto do turno: histórico do BANCO (o front manda só a mensagem nova)
    // cortado pela janela deslizante. Quando o turno do usuário já estava
    // persistido (regenerar), a última linha é a própria mensagem nova e sai
    // daqui para não entrar duas vezes.
    const historicoPersistido: LlmMessage[] = existingMessages
      .slice(0, alreadyStoredUser ? -1 : undefined)
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: stripArtifactAppendix(m.content),
      }))
      // Conteúdo vazio quebra a API (bloco de texto precisa ter texto).
      .filter((m) => m.content.trim().length > 0)

    const janela = aplicarJanela(
      historicoPersistido,
      config.CONTEXT_WINDOW_MESSAGES,
    )

    // Resumo rolling do que ficou fora da janela. Só entra se a última
    // mensagem coberta ainda existe: depois de editar/regenerar, o resumo
    // descreveria turnos apagados — nesse caso vale mais a nota genérica.
    let resumoHistorico: string | null = null
    if (janela.cortou) {
      try {
        const resumo = await getChatSummary(body.threadId)
        if (
          resumo &&
          existingMessages.some(
            (m) => m.id === resumo.covered_until_message_id,
          )
        ) {
          resumoHistorico = resumo.text
        }
      } catch (err) {
        request.log.warn(
          { err, traceId: request.traceId, chatId: body.threadId },
          "resumo do histórico indisponível neste run",
        )
      }
    }

    // RAG do histórico antigo (item 1.9): só quando a janela cortou algo — se
    // a conversa inteira cabe no prompt, não há o que recuperar. Complementa o
    // resumo (visão geral) com o detalhe pontual. Falha aqui devolve [].
    const trechosRag = janela.cortou
      ? await buscarTrechosRelevantes({
          chatId: body.threadId,
          userId,
          pergunta: userText,
          limite: 3,
          traceId: request.traceId,
          log: request.log,
        })
      : []
    const ragBlock = formatarBlocoRag(trechosRag)

    // Instruções/arquivos do projeto: prioriza o project_id persistido no chat.
    const chatRow = await getChat(body.threadId, userId)
    const projectId = chatRow?.project_id ?? body.context?.projectId ?? null
    const projectBlock = projectId
      ? await buildProjectPromptBlock(projectId, userId)
      : null

    const artifactsFromContext = (body.context?.artifacts ?? []) as ArtifactWire[]
    const artifactsBlock = formatArtifactsSystemBlock(artifactsFromContext)
    const artifactsTitlesBlock = formatArtifactsTitlesBlock(artifactsFromContext)

    // Base de conhecimento da empresa (cache de 60s no store). Falha aqui NÃO
    // derruba o chat — segue sem o bloco, com o motivo no log.
    let kbContext: KbPromptContext | null = null
    try {
      kbContext = await getKbPromptContext()
    } catch (err) {
      request.log.warn({ err }, "base de conhecimento indisponível neste run")
    }

    const promptMontado = buildSystemPrompt({
      context: body.context,
      access,
      projectBlock,
      artifactsBlock,
      artifactsTitlesBlock,
      connectors,
      kbContext,
      multiAgentEnabled,
      historicoCortado: janela.cortou,
      resumoHistorico,
      ragBlock,
    })

    // Modelo escolhido na interface (context.model) — catálogo admin + default,
    // respeitando os modelos liberados para este usuário (profiles.allowed_models).
    const modelInfo = await resolveModelForUser(body.context?.model, {
      userId,
      role,
    })

    // Orçamento de contexto (item 1.10): estima o payload e degrada (artefatos
    // → títulos, janela menor, RAG fora) ANTES de o provider devolver
    // context_length_exceeded no meio do run.
    const ajuste = ajustarContexto({
      systemStatic: promptMontado.staticBlock,
      blocosDinamicos: promptMontado.blocos,
      historico: janela.mensagens,
      novaMensagem: userText,
      inputTokenLimit: modelInfo.inputTokenLimit,
      margemSaidaTokens: responseMaxTokens(modelInfo.model),
    })
    for (const corte of ajuste.cortes) {
      request.log.info(
        {
          traceId: request.traceId,
          chatId: body.threadId,
          model: modelInfo.id,
          acao: corte.acao,
          tokensAntes: corte.tokensAntes,
          tokensDepois: corte.tokensDepois,
          orcamentoTokens: ajuste.orcamentoTokens,
          detalhe: corte.detalhe,
        },
        "contexto degradado para caber no orçamento do modelo",
      )
    }
    if (!ajuste.dentroDoOrcamento) {
      request.log.warn(
        {
          traceId: request.traceId,
          chatId: body.threadId,
          model: modelInfo.id,
          tokensEstimados: ajuste.metricas.total,
          orcamentoTokens: ajuste.orcamentoTokens,
        },
        "contexto acima do orçamento mesmo após degradar tudo",
      )
    }

    const systemPrompt: SystemPromptParts = {
      staticBlock: promptMontado.staticBlock,
      dynamicBlock: juntarBlocosDinamicos(ajuste.blocosDinamicos),
    }
    const historicoJanela: LlmMessage[] = ajuste.historico
    const llmMessages: LlmMessage[] = [
      ...historicoJanela,
      { role: "user", content: userText },
    ]

    // Métricas de input por componente (item 1.11): é o que permite ver PARA
    // ONDE o input está indo sem abrir o payload. Só log — nada em banco.
    request.log.info(
      {
        traceId: request.traceId,
        chatId: body.threadId,
        model: modelInfo.id,
        orcamentoTokens: ajuste.orcamentoTokens,
        cortes: ajuste.cortes.length,
        janelaMensagens: historicoJanela.length,
        ragTrechos: ajuste.blocosDinamicos.some((b) => b.tipo === "rag")
          ? trechosRag.length
          : 0,
        tokens: ajuste.metricas,
      },
      "input estimado por componente",
    )

    const userKeys = await listUserKeys(userId).catch(() => [])
    const personalProviders = new Set(
      userKeys.map((k) => k.provider),
    )
    const creditCtx = await buildModelCreditContext(userId, personalProviders)
    if (!modelIsAvailableWithCredit(creditCtx, modelInfo.provider)) {
      reply.code(402).send({
        error: "no_credit",
        message:
          "Sem crédito disponível para este provider ou orçamento mensal esgotado. Escolha outro modelo ou fale com um administrador.",
      })
      return
    }
    const modelKeySource = keySourceForProvider(
      modelInfo.provider,
      personalProviders,
    )

    // Chave efetiva deste request: pessoal do usuário (BYOK) → global → env.
    const providerApiKey = isKeyProvider(modelInfo.provider)
      ? await getEffectiveKey(modelInfo.provider, userId)
      : undefined

    const lastAttachments = novaMensagem.attachments ?? []
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

    // Guarda do orçamento mensal DENTRO do run (item 4.4): null quando o
    // usuário não tem teto em profiles.usage_budget_usd — nesse caso os loops
    // nem chamam a checagem.
    const budgetGuard = await criarGuardaOrcamento({
      userId,
      modelId: modelInfo.id,
    })

    initSSE(reply)

    // O run é registrado ANTES de começar e vive DESLIGADO desta conexão:
    // cliente desconectar (F5, fechar aba, rede caiu) só desanexa o assinante
    // — a geração segue neste processo, os eventos ficam no registro
    // (reanexável via GET /api/chat/:threadId/stream) e a resposta é
    // persistida no banco ao final. Abortam o run apenas o cancelamento
    // explícito (POST /api/chat/:threadId/cancel), a substituição por um run
    // novo do mesmo chat e o timeout abaixo.
    const controller = new AbortController()
    const run = chatRunRegistry.iniciar({
      chatId: body.threadId,
      userId,
      controller,
    })

    let clientOpen = true
    let timedOut = false
    const assinante: RunAssinante = {
      emitir: (evt) => {
        if (!clientOpen) return
        try {
          writeSSE(reply, evt)
        } catch {
          clientOpen = false
        }
      },
    }
    chatRunRegistry.assinar(run, assinante)
    request.raw.on("close", () => {
      clientOpen = false
      chatRunRegistry.desassinar(run, assinante)
    })

    const emit = (evt: Parameters<typeof writeSSE>[1]): void => {
      chatRunRegistry.publicar(run, evt)
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
    /** Prompt caching (só Anthropic) — gravados separados de tokensIn. */
    let tokensCacheWrite: number | undefined
    let tokensCacheRead: number | undefined
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
        const cacheTokens = {
          cacheWriteTokens: tokensCacheWrite,
          cacheReadTokens: tokensCacheRead,
        }
        let costUsd = await computeMessageCostUsd(
          modelInfo.id,
          tokensIn,
          tokensOut,
          cacheTokens,
        )
        if (costUsd == null && usedModel) {
          costUsd = await computeMessageCostUsd(
            usedModel,
            tokensIn,
            tokensOut,
            cacheTokens,
          )
        }
        assistantMessageId = await insertMessage({
          chatId: body.threadId,
          userId,
          role: "assistant",
          content: corpo + sufixo,
          model: usedModel,
          tokensIn,
          tokensOut,
          tokensCacheWrite,
          tokensCacheRead,
          costUsd,
          traceId: request.traceId,
        })
        // O gasto do mês acabou de mudar — o cache de 30s da guarda de
        // orçamento não pode continuar servindo o valor anterior.
        invalidarCacheDeGasto(userId)
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

    let posRunAgendado = false
    /**
     * Trabalho pós-run: resumo rolling do histórico que saiu da janela (1.7) e
     * indexação dessas mensagens para o RAG (1.9). Vai para a fila quando há
     * Redis; sem Redis roda no processo, sem await — é acessório e não pode
     * atrasar o `done` nem derrubar a resposta.
     */
    const agendarResumo = (): void => {
      if (posRunAgendado) return
      posRunAgendado = true
      agendarPosRun({
        chatId: body.threadId,
        userId,
        traceId: request.traceId,
        log: request.log,
      })
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

      const userPrompt = userText.trim()
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
          messages: toAnthropicMessages(historicoJanela, {
            content: userText,
            attachments: lastAttachments,
          }),
          access,
          connectors,
          userId,
          email: email ?? "",
          projectId: projectId ?? undefined,
          apiKey: providerApiKey,
          signal: controller.signal,
          multiAgentEnabled,
          budgetGuard: budgetGuard ?? undefined,
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
        tokensCacheWrite = result.cacheWriteTokens
        tokensCacheRead = result.cacheReadTokens
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
          projectId: projectId ?? undefined,
          apiKey: providerApiKey,
          signal: controller.signal,
          multiAgentEnabled,
          budgetGuard: budgetGuard ?? undefined,
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
          // Ollama não tem prompt caching — vai o texto único.
          systemPrompt: flattenSystemPrompt(systemPrompt),
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
      agendarResumo()
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

      const errMsg = err instanceof Error ? err.message : String(err)
      void recordQuotaError(
        userId,
        modelInfo.provider,
        modelKeySource,
        errMsg,
      )

      await persistirResposta()
      await gravarAuditoria()
      agendarResumo()
      if (!aborted || timedOut) {
        emit({ event: "error", data: { message } })
      }
    } finally {
      clearInterval(heartbeat)
      clearTimeout(runTimer)
      // Cancelamento (Parar) encerra sem evento no stream — garante o
      // terminal no registro para reanexações não ficarem penduradas.
      chatRunRegistry.encerrar(
        run,
        endReason === "aborted" && !timedOut ? "cancelled" : "done",
      )
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
    agendarResumo()
  })

  const runParamsSchema = z.object({ threadId: z.string().uuid() })

  /**
   * Estado do run desta conversa neste processo: em andamento ou recém-
   * encerrado (janela de reanexação). O front usa ao abrir a conversa para
   * decidir se reanexa (GET .../stream) — run desconhecido significa que não
   * há nada rodando e o histórico do banco já é a verdade.
   */
  app.get("/api/chat/:threadId/run", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params)
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request" })
      return
    }
    const { userId } = await resolveUser(request)
    const run = chatRunRegistry.obter(parsed.data.threadId, userId)
    if (!run) {
      return { active: false, status: null }
    }
    return { active: run.status === "running", status: run.status }
  })

  /**
   * Reanexa num run em andamento (ou recém-encerrado): replay de tudo que já
   * foi produzido (progresso + texto acumulado) e eventos ao vivo até o
   * terminal — mesmo contrato SSE do POST /api/chat. É o que permite F5,
   * fechar a aba ou trocar de rede sem perder a resposta.
   */
  app.get("/api/chat/:threadId/stream", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params)
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request" })
      return
    }
    const { userId } = await resolveUser(request)

    let clientOpen = true
    let heartbeat: NodeJS.Timeout | undefined
    let encerrado = false
    // O handler só resolve quando o stream termina (terminal do run ou
    // desconexão) — mesmo ciclo de vida do POST /api/chat.
    let resolverFim: (() => void) | null = null
    const fim = new Promise<void>((resolve) => {
      resolverFim = resolve
    })
    const finalizar = (): void => {
      if (encerrado) return
      encerrado = true
      if (heartbeat) clearInterval(heartbeat)
      if (clientOpen) {
        try {
          endSSE(reply)
        } catch {
          /* já fechado */
        }
      }
      resolverFim?.()
    }
    const assinante: RunAssinante = {
      emitir: (evt) => {
        if (!clientOpen) return
        try {
          writeSSE(reply, evt)
          if (evt.event === "done" || evt.event === "error") {
            finalizar()
          }
        } catch {
          clientOpen = false
        }
      },
    }

    const anexo = chatRunRegistry.anexar(parsed.data.threadId, userId, assinante)
    if (!anexo) {
      reply.code(404).send({
        error: "no_active_run",
        message: "Nenhuma geração em andamento nesta conversa.",
      })
      return
    }

    initSSE(reply)
    heartbeat = setInterval(() => {
      if (!clientOpen || encerrado) return
      try {
        writeSSEHeartbeat(reply)
      } catch {
        clientOpen = false
      }
    }, 15_000)
    request.raw.on("close", () => {
      clientOpen = false
      chatRunRegistry.desassinar(anexo.run, assinante)
      finalizar()
    })

    // Replay síncrono antes de qualquer evento ao vivo (o assinante já está
    // registrado, mas broadcasts só acontecem quando o loop cede o event
    // loop — nada intercala aqui).
    for (const evt of anexo.replay) {
      assinante.emitir(evt)
    }

    await fim
  })

  /** Teto de espera do cancel pelo assentamento do run — loop preso não pode
   * pendurar o POST (o abort já foi disparado de qualquer forma). */
  const CANCEL_AGUARDA_FIM_MS = 10_000

  /**
   * Cancela a geração em andamento (botão Parar / retry). Como a desconexão
   * do SSE não aborta mais o run, este endpoint é o ÚNICO cancelamento
   * explícito. O 204 só volta DEPOIS de o run assentar (terminal publicado,
   * resposta parcial já persistida) — o "Tentar novamente" depende disso
   * para truncar o histórico sem corrida com o run antigo.
   */
  app.post("/api/chat/:threadId/cancel", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params)
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request" })
      return
    }
    const { userId } = await resolveUser(request)
    const run = chatRunRegistry.obter(parsed.data.threadId, userId)
    if (!run || run.status !== "running") {
      reply.code(404).send({
        error: "no_active_run",
        message: "Nenhuma geração em andamento nesta conversa.",
      })
      return
    }
    chatRunRegistry.cancelar(parsed.data.threadId, userId)
    await chatRunRegistry.aguardarFim(run, CANCEL_AGUARDA_FIM_MS)
    reply.code(204).send()
  })
}
