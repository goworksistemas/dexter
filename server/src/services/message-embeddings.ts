/**
 * RAG sobre o histórico longo de uma conversa (item 1.9).
 *
 * A janela deslizante manda ao modelo só as últimas N mensagens; o resumo
 * rolling (chat-summary.ts) cobre o trecho cortado em VISÃO GERAL. O que falta
 * é o DETALHE pontual — o número, o id, o nome que apareceu no turno 7. Aqui as
 * mensagens que já saíram da janela ganham embedding (OpenAI
 * text-embedding-3-small, 1536d, tabela agent_message_embeddings) e a pergunta
 * nova recupera os top-k trechos relevantes pela RPC match_chat_messages.
 *
 * Resumo e RAG são COMPLEMENTARES: os dois entram no prompt quando existem.
 *
 * Feature 100% opcional: sem chave OpenAI disponível (BYOK → global → env) todo
 * o módulo vira no-op silencioso (log debug). Nenhuma função aqui lança para o
 * caminho do chat.
 */
import type { FastifyBaseLogger } from "fastify"

import { supabase } from "../lib/supabase.js"
import { stripArtifactAppendix } from "../systems/artifacts-context.js"
import { getMessages, type StoredMessage } from "./chat-store.js"
import { indiceInicioJanela } from "./context-window.js"
import { getEffectiveKey, getGlobalKey } from "./llm-keys.js"

/** Modelo e dimensão FIXOS — a coluna vector(1536) da migration 0034 depende disso. */
const EMBEDDING_MODEL = "text-embedding-3-small"
const EMBEDDING_DIMENSIONS = 1536

/** Teto por mensagem enviada ao embedding (tool result denso é gigante). */
const MAX_CHARS_POR_MENSAGEM = 4_000

/** Mensagens indexadas por rodada — protege contra backlog de conversa antiga. */
const MAX_MENSAGENS_POR_RODADA = 20

/** Indexação/busca são acessórios: não seguram recurso além disso. */
const TIMEOUT_MS = 20_000

/** Trecho de cada mensagem recuperada que vai ao prompt. */
export const RAG_TRECHO_MAX_CHARS = 600

export interface TrechoRelevante {
  messageId: string
  role: "user" | "assistant" | "system"
  /** Já truncado em RAG_TRECHO_MAX_CHARS. */
  trecho: string
  /** Distância coseno devolvida pela RPC (menor = mais próximo). */
  distancia: number
}

/**
 * Chave OpenAI efetiva: pessoal do usuário → global (banco → env).
 * `undefined` desliga a feature inteira sem erro.
 */
async function resolverChaveOpenAi(userId?: string): Promise<string | undefined> {
  try {
    return userId
      ? await getEffectiveKey("openai", userId)
      : await getGlobalKey("openai")
  } catch {
    return undefined
  }
}

/** A feature está disponível? (só para logs/decisões externas) */
export async function embeddingsDisponiveis(userId?: string): Promise<boolean> {
  return Boolean(await resolverChaveOpenAi(userId))
}

function truncar(texto: string): string {
  const limpo = stripArtifactAppendix(texto).trim()
  return limpo.length <= MAX_CHARS_POR_MENSAGEM
    ? limpo
    : limpo.slice(0, MAX_CHARS_POR_MENSAGEM)
}

/**
 * Gera embeddings de um lote de textos. A API aceita array de entrada, então
 * indexar 20 mensagens custa UMA requisição.
 */
async function gerarEmbeddings(
  textos: string[],
  apiKey: string,
): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: textos,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const corpo = await res.text().catch(() => "")
    throw new Error(
      `embeddings HTTP ${res.status}${corpo ? `: ${corpo.slice(0, 200)}` : ""}`,
    )
  }
  const json = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>
  }
  // A API garante a ordem, mas o campo `index` é a fonte de verdade.
  const porIndice = new Map<number, number[]>()
  ;(json.data ?? []).forEach((item, i) => {
    const pos = typeof item.index === "number" ? item.index : i
    if (Array.isArray(item.embedding)) porIndice.set(pos, item.embedding)
  })
  const out = textos.map((_, i) => porIndice.get(i))
  if (out.some((v) => v === undefined)) {
    throw new Error("resposta de embeddings incompleta")
  }
  return out as number[][]
}

/** Ids do chat que já têm embedding (para não pagar duas vezes pela mesma mensagem). */
async function idsJaIndexados(chatId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("agent_message_embeddings")
    .select("message_id")
    .eq("chat_id", chatId)
  if (error) throw new Error(`idsJaIndexados falhou: ${error.message}`)
  return new Set((data ?? []).map((r) => String(r.message_id)))
}

export interface IndexarParams {
  chatId: string
  userId: string
  /** Mesma janela que a rota de chat usa — nada dentro dela é indexado. */
  janelaMensagens: number
  traceId?: string
  log: FastifyBaseLogger
}

/**
 * Indexa as mensagens do chat que (a) já saíram da janela de contexto e
 * (b) ainda não têm embedding. O que ainda vai no prompt NÃO é indexado: seria
 * pagar embedding por texto que o modelo já está lendo.
 *
 * Fire-and-forget: nunca lança. Devolve quantas mensagens indexou.
 */
export async function indexarMensagensDoChat(
  params: IndexarParams,
): Promise<number> {
  const { chatId, userId, janelaMensagens, traceId, log } = params
  const iniciado = Date.now()
  try {
    const apiKey = await resolverChaveOpenAi(userId)
    if (!apiKey) {
      log.debug(
        { traceId, chatId },
        "RAG do histórico desligado — sem chave OpenAI disponível",
      )
      return 0
    }

    // Mesma limpeza da rota de chat: se as listas divergirem, o índice de corte
    // também diverge e o RAG indexaria mensagem que ainda está no prompt.
    const todas = (await getMessages(chatId, userId))
      .filter((m) => m.role !== "system")
      .map((m) => ({ ...m, content: stripArtifactAppendix(m.content) }))
      .filter((m) => m.content.trim().length > 0)

    const inicio = indiceInicioJanela(todas, janelaMensagens)
    if (inicio <= 0) return 0

    const fora = todas.slice(0, inicio)
    const jaIndexados = await idsJaIndexados(chatId)
    const pendentes = fora
      .filter((m) => !jaIndexados.has(m.id))
      // Mais recentes primeiro: se houver backlog, o que é mais provável de ser
      // consultado entra antes.
      .slice(-MAX_MENSAGENS_POR_RODADA)
    if (pendentes.length === 0) return 0

    const vetores = await gerarEmbeddings(
      pendentes.map((m) => truncar(m.content)),
      apiKey,
    )

    const { error } = await supabase.from("agent_message_embeddings").upsert(
      pendentes.map((m, i) => ({
        message_id: m.id,
        chat_id: chatId,
        embedding: vetores[i]!,
      })),
      { onConflict: "message_id" },
    )
    if (error) throw new Error(`upsert de embeddings falhou: ${error.message}`)

    log.info(
      {
        traceId,
        chatId,
        indexadas: pendentes.length,
        foraDaJanela: fora.length,
        model: EMBEDDING_MODEL,
        durationMs: Date.now() - iniciado,
      },
      "mensagens antigas indexadas para o RAG do histórico",
    )
    return pendentes.length
  } catch (err) {
    log.warn(
      { err, traceId, chatId },
      "falha ao indexar mensagens para o RAG (a conversa segue sem RAG)",
    )
    return 0
  }
}

export interface BuscarParams {
  chatId: string
  userId: string
  pergunta: string
  limite?: number
  traceId?: string
  log: FastifyBaseLogger
}

/**
 * Top-k mensagens antigas relevantes à pergunta nova. Lista vazia quando a
 * feature está desligada, não há nada indexado ou algo falhou — o chat NUNCA
 * cai por causa disso.
 */
export async function buscarTrechosRelevantes(
  params: BuscarParams,
): Promise<TrechoRelevante[]> {
  const { chatId, userId, pergunta, traceId, log } = params
  const limite = params.limite ?? 3
  const texto = pergunta.trim()
  if (!texto) return []

  try {
    const apiKey = await resolverChaveOpenAi(userId)
    if (!apiKey) {
      log.debug(
        { traceId, chatId },
        "RAG do histórico desligado — sem chave OpenAI disponível",
      )
      return []
    }

    const [vetor] = await gerarEmbeddings([truncar(texto)], apiKey)
    if (!vetor) return []

    const { data, error } = await supabase.rpc("match_chat_messages", {
      p_chat_id: chatId,
      p_query_embedding: vetor,
      p_limit: limite,
    })
    if (error) throw new Error(`match_chat_messages falhou: ${error.message}`)

    const ranking = (data ?? []) as Array<{
      message_id: string
      distance: number
    }>
    if (ranking.length === 0) return []

    // O conteúdo vem de getMessages (que já checa ownership do chat) — a RPC
    // devolve só ids, então nada aqui bypassa a checagem de dono.
    const porId = new Map<string, StoredMessage>()
    for (const m of await getMessages(chatId, userId)) porId.set(m.id, m)

    const trechos: TrechoRelevante[] = []
    for (const linha of ranking) {
      const msg = porId.get(String(linha.message_id))
      if (!msg) continue
      const limpo = stripArtifactAppendix(msg.content).trim()
      if (!limpo) continue
      trechos.push({
        messageId: msg.id,
        role: msg.role,
        trecho:
          limpo.length <= RAG_TRECHO_MAX_CHARS
            ? limpo
            : `${limpo.slice(0, RAG_TRECHO_MAX_CHARS)}…`,
        distancia: Number(linha.distance ?? 0),
      })
    }
    return trechos
  } catch (err) {
    log.warn(
      { err, traceId, chatId },
      "busca RAG no histórico falhou (a conversa segue sem os trechos)",
    )
    return []
  }
}

/**
 * Bloco do system prompt com os trechos recuperados. `null` quando não há nada
 * — o caller não precisa checar tamanho.
 */
export function formatarBlocoRag(trechos: TrechoRelevante[]): string | null {
  if (trechos.length === 0) return null
  const linhas = trechos.map(
    (t) => `- [${t.role === "assistant" ? "dexter" : t.role}] ${t.trecho}`,
  )
  return (
    "## Trechos relevantes do histórico antigo\n" +
    "Recuperados por similaridade com a pergunta atual (estão FORA da janela de " +
    "contexto). Use como evidência do que já foi dito nesta conversa; não " +
    "confunda com resultado de tool novo.\n" +
    linhas.join("\n")
  )
}
