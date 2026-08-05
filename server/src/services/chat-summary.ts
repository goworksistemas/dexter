/**
 * Sumarização rolling do histórico de um chat.
 *
 * A janela deslizante (services/context-window.ts) manda ao modelo só as
 * últimas N mensagens. O que sai da janela sumia do contexto — aqui esse
 * trecho vira um resumo incremental guardado em `agent_chats.metadata.summary`
 * e injetado no bloco dinâmico do system prompt no lugar dos turnos cortados.
 *
 * O resumo é gerado APÓS o run (fire-and-forget) com um modelo barato (Haiku)
 * e NUNCA derruba o chat: toda falha vira log. O custo dessa chamada não vai
 * para `agent_messages` — poluiria o histórico e a auditoria da conversa; fica
 * só no log estruturado com o traceId do run que a disparou.
 */
import type { FastifyBaseLogger } from "fastify"

import { config } from "../config.js"
import { supabase } from "../lib/supabase.js"
import { enabledModels, resolveModel, type ModelInfo } from "../llm/models.js"
import { streamChat } from "../llm/router.js"
import { stripArtifactAppendix } from "../systems/artifacts-context.js"
import { getMessages, type StoredMessage } from "./chat-store.js"
import { indiceInicioJanela } from "./context-window.js"
import { getEffectiveKey, isKeyProvider } from "./llm-keys.js"
import { computeMessageCostUsd } from "./model-pricing.js"

/** Formato persistido em `agent_chats.metadata.summary`. */
export interface ChatSummaryRecord {
  /** Texto do resumo (já limitado a MAX_CHARS_RESUMO). */
  text: string
  /** Última mensagem coberta — base do próximo resumo incremental. */
  covered_until_message_id: string
  updated_at: string
}

/** Teto do resumo: cabe em ~400 tokens no system prompt de todo turno. */
const MAX_CHARS_RESUMO = 1_500

/** Cap por mensagem enviada ao sumarizador (tool results densos são enormes). */
const MAX_CHARS_MENSAGEM = 2_000

/** Teto de mensagens novas por rodada — protege contra backlog gigante. */
const MAX_MENSAGENS_POR_RODADA = 40

/** Sumarização é acessório: não pode segurar recurso além disso. */
const TIMEOUT_MS = 45_000

const SYSTEM_PROMPT_SUMARIZADOR = `Você mantém a MEMÓRIA de longo prazo de uma conversa entre um usuário e o Dexter (assistente interno da GoWork).

Você recebe o resumo anterior (se houver) e as mensagens que acabaram de sair da janela de contexto. Devolva UM único resumo atualizado, que substitui o anterior.

Regras:
- Português do Brasil, texto corrido em tópicos curtos (use "- " por item).
- Máximo de ${MAX_CHARS_RESUMO} caracteres. Se faltar espaço, condense o mais antigo e preserve o mais recente.
- PRESERVE sempre: entidades citadas (empresas, unidades, pessoas, códigos N####, ids), números e métricas que vieram de consultas (com a fonte/sistema), decisões tomadas e pendências/próximos passos combinados.
- DESCARTE: saudações, preâmbulos, explicações de como a resposta foi montada, texto de erro transitório.
- NÃO invente nada que não esteja no material recebido. Não escreva "não há informação" para itens ausentes: simplesmente omita.
- Responda SÓ com o resumo. Sem título, sem preâmbulo, sem comentar o que você fez.`

/** Chats com sumarização em andamento — evita rodada dupla no mesmo chat. */
const emAndamento = new Set<string>()

function parseSummary(raw: unknown): ChatSummaryRecord | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const text = typeof obj.text === "string" ? obj.text.trim() : ""
  const covered =
    typeof obj.covered_until_message_id === "string"
      ? obj.covered_until_message_id
      : ""
  if (!text || !covered) return null
  return {
    text,
    covered_until_message_id: covered,
    updated_at:
      typeof obj.updated_at === "string" ? obj.updated_at : new Date(0).toISOString(),
  }
}

/** Resumo já persistido deste chat (null quando ainda não há). */
export async function getChatSummary(
  chatId: string,
): Promise<ChatSummaryRecord | null> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("metadata")
    .eq("id", chatId)
    .maybeSingle()

  if (error) throw new Error(`getChatSummary falhou: ${error.message}`)
  if (!data) return null
  const metadata = (data.metadata as Record<string, unknown> | null) ?? {}
  return parseSummary(metadata.summary)
}

/**
 * Grava o resumo preservando o resto do metadata. `updated_at` do chat NÃO é
 * tocado de propósito: sumarizar não é atividade do usuário e reordenaria a
 * sidebar sozinho.
 */
async function saveChatSummary(
  chatId: string,
  record: ChatSummaryRecord,
): Promise<void> {
  const { data, error } = await supabase
    .from("agent_chats")
    .select("metadata")
    .eq("id", chatId)
    .maybeSingle()
  if (error) throw new Error(`saveChatSummary (leitura) falhou: ${error.message}`)
  if (!data) throw new Error("saveChatSummary: chat inexistente")

  const metadata = (data.metadata as Record<string, unknown> | null) ?? {}
  const { error: updError } = await supabase
    .from("agent_chats")
    .update({ metadata: { ...metadata, summary: record } })
    .eq("id", chatId)
  if (updError) {
    throw new Error(`saveChatSummary falhou: ${updError.message}`)
  }
}

/**
 * Modelo do sumarizador: o Haiku mais recente habilitado no catálogo, senão o
 * default. Não passa por `resolveModelForUser` de propósito — a restrição
 * `profiles.allowed_models` governa o que o usuário ESCOLHE na interface; esta
 * chamada é interna e deve ser sempre a mais barata disponível.
 */
async function resolverModeloSumarizador(): Promise<ModelInfo> {
  const catalogo = await enabledModels()
  const haikus = catalogo
    .filter((m) => m.provider === "anthropic" && /haiku/i.test(m.model))
    .sort((a, b) =>
      String(b.releasedAt ?? "").localeCompare(String(a.releasedAt ?? "")),
    )
  return haikus[0] ?? (await resolveModel())
}

function truncarMensagem(texto: string): string {
  const limpo = texto.trim()
  if (limpo.length <= MAX_CHARS_MENSAGEM) return limpo
  return `${limpo.slice(0, MAX_CHARS_MENSAGEM)}…[mensagem truncada]`
}

function montarEntrada(
  resumoAnterior: string | null,
  novas: StoredMessage[],
): string {
  const partes: string[] = []
  partes.push(
    resumoAnterior
      ? `### Resumo anterior (cobre o começo da conversa)\n${resumoAnterior}`
      : "### Resumo anterior\n(não existe — este é o primeiro resumo desta conversa)",
  )
  partes.push(
    "### Mensagens que acabaram de sair da janela de contexto\n" +
      novas
        .map(
          (m) =>
            `[${m.role === "assistant" ? "dexter" : m.role}] ${truncarMensagem(m.content)}`,
        )
        .join("\n\n"),
  )
  return partes.join("\n\n")
}

async function gerarResumo(
  modelo: ModelInfo,
  apiKey: string | undefined,
  entrada: string,
): Promise<{ texto: string; inputTokens?: number; outputTokens?: number }> {
  const handle = streamChat({
    provider: modelo.provider,
    model: modelo.model,
    systemPrompt: SYSTEM_PROMPT_SUMARIZADOR,
    messages: [{ role: "user", content: entrada }],
    signal: AbortSignal.timeout(TIMEOUT_MS),
    apiKey,
  })

  let texto = ""
  for await (const delta of handle.textDeltas) {
    texto += delta
  }
  const result = await handle.result()
  return {
    texto: texto.trim().slice(0, MAX_CHARS_RESUMO),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  }
}

export interface MaybeUpdateChatSummaryParams {
  chatId: string
  userId: string
  /** Do run que disparou a sumarização — amarra os dois no log. */
  traceId?: string
  log: FastifyBaseLogger
}

/**
 * Atualiza o resumo do chat se o histórico fora da janela cresceu desde a
 * última cobertura. Fire-and-forget: NUNCA lança — toda falha vira log.
 * Devolve o resumo gravado (ou null quando não havia nada a fazer).
 */
export async function maybeUpdateChatSummary(
  params: MaybeUpdateChatSummaryParams,
): Promise<ChatSummaryRecord | null> {
  const { chatId, userId, traceId, log } = params
  if (emAndamento.has(chatId)) return null
  emAndamento.add(chatId)
  const iniciadoEm = Date.now()

  try {
    // Mesma limpeza que a rota de chat aplica antes de cortar a janela
    // (apêndice legado de artefatos e mensagens vazias) — se as duas listas
    // divergirem, o índice de corte também diverge.
    const todas = (await getMessages(chatId, userId))
      .filter((m) => m.role !== "system")
      .map((m) => ({ ...m, content: stripArtifactAppendix(m.content) }))
      .filter((m) => m.content.trim().length > 0)
    // O corte é calculado sobre TODAS as mensagens persistidas porque é
    // exatamente esse array que o próximo turno vai passar por aplicarJanela().
    const inicio = indiceInicioJanela(todas, config.CONTEXT_WINDOW_MESSAGES)
    if (inicio <= 0) return null

    const fora = todas.slice(0, inicio)
    const anterior = await getChatSummary(chatId)
    const idxCoberto = anterior
      ? fora.findIndex((m) => m.id === anterior.covered_until_message_id)
      : -1
    // Resumo anterior aponta para mensagem que não está mais no trecho cortado
    // (histórico editado/truncado, ou limite de janela mudou) → refaz do zero.
    const resumoBase = idxCoberto >= 0 ? anterior!.text : null
    const candidatas = idxCoberto >= 0 ? fora.slice(idxCoberto + 1) : fora
    if (candidatas.length === 0) return null

    const novas = candidatas.slice(-MAX_MENSAGENS_POR_RODADA)
    const modelo = await resolverModeloSumarizador()
    const apiKey = isKeyProvider(modelo.provider)
      ? await getEffectiveKey(modelo.provider, userId)
      : undefined

    const { texto, inputTokens, outputTokens } = await gerarResumo(
      modelo,
      apiKey,
      montarEntrada(resumoBase, novas),
    )
    if (!texto) {
      log.warn(
        { traceId, chatId, model: modelo.id },
        "sumarização do histórico voltou vazia — resumo mantido como estava",
      )
      return null
    }

    const record: ChatSummaryRecord = {
      text: texto,
      covered_until_message_id: fora[fora.length - 1]!.id,
      updated_at: new Date().toISOString(),
    }
    await saveChatSummary(chatId, record)

    const costUsd = await computeMessageCostUsd(
      modelo.id,
      inputTokens,
      outputTokens,
    ).catch(() => null)
    log.info(
      {
        traceId,
        chatId,
        model: modelo.id,
        mensagensResumidas: novas.length,
        mensagensForaDaJanela: fora.length,
        tokensIn: inputTokens,
        tokensOut: outputTokens,
        costUsd,
        chars: texto.length,
        durationMs: Date.now() - iniciadoEm,
      },
      "resumo rolling do histórico atualizado",
    )
    return record
  } catch (err) {
    log.warn(
      { err, traceId, chatId },
      "falha ao atualizar o resumo do histórico (o chat segue sem resumo)",
    )
    return null
  } finally {
    emAndamento.delete(chatId)
  }
}
