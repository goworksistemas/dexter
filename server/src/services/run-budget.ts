/**
 * Orçamento mensal do usuário DENTRO do run (item 4.4).
 *
 * Até aqui o teto de `profiles.usage_budget_usd` era checado só no INÍCIO do
 * request (provider-credit.ts). Um run de 28 tool calls com modelo caro podia
 * começar dentro do orçamento e terminar muito acima dele — o estouro só
 * aparecia na requisição seguinte.
 *
 * A guarda abaixo é consultada pelos dois agent loops a cada
 * `STEPS_ENTRE_CHECAGENS` tool calls: estima o custo acumulado do run com os
 * tokens já contabilizados (mesmo cálculo de `model-pricing.ts`, com a
 * ponderação de cache) e compara com o que sobra do orçamento do mês.
 * Estourou → o loop encerra graciosamente (última chamada SEM tools).
 *
 * O gasto do mês fica em cache de 30s: o hot path não pode pagar duas queries
 * a cada 5 steps.
 */
import { supabase } from "../lib/supabase.js"
import { computeMessageCostUsd } from "./model-pricing.js"

/** Tool calls entre duas checagens de orçamento. */
export const STEPS_ENTRE_CHECAGENS = 5

/** TTL do cache do gasto do mês (por usuário). */
const CACHE_TTL_MS = 30_000

const cacheGasto = new Map<string, { at: number; usd: number }>()

function inicioDoMesUtc(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

/**
 * Gasto do usuário no mês corrente (soma de `agent_messages.cost_usd` dos
 * chats dele). Erro de leitura devolve 0 — bloquear o chat por falha de
 * consulta de custo seria pior que deixar passar.
 */
export async function gastoDoMesUsd(
  userId: string,
  opts: { ignorarCache?: boolean } = {},
): Promise<number> {
  const hit = cacheGasto.get(userId)
  if (!opts.ignorarCache && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.usd
  }

  const since = inicioDoMesUtc()
  const { data: chats } = await supabase
    .from("agent_chats")
    .select("id")
    .eq("user_id", userId)
  const chatIds = (chats ?? []).map((c) => String(c.id))
  if (chatIds.length === 0) {
    cacheGasto.set(userId, { at: Date.now(), usd: 0 })
    return 0
  }

  const { data: rows, error } = await supabase
    .from("agent_messages")
    .select("cost_usd")
    .in("chat_id", chatIds)
    .gte("created_at", since)
  if (error) return hit?.usd ?? 0

  let soma = 0
  for (const row of rows ?? []) soma += Number(row.cost_usd ?? 0)
  cacheGasto.set(userId, { at: Date.now(), usd: soma })
  return soma
}

/** Invalida o cache do gasto (usado quando um run acabou de gravar custo). */
export function invalidarCacheDeGasto(userId?: string): void {
  if (userId) cacheGasto.delete(userId)
  else cacheGasto.clear()
}

/** Teto mensal do usuário em USD, ou null quando não há teto configurado. */
export async function orcamentoMensalUsd(
  userId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("usage_budget_usd")
    .eq("id", userId)
    .maybeSingle()
  if (error || !data) return null
  const bruto = data.usage_budget_usd
  if (bruto == null) return null
  const valor = Number(bruto)
  return Number.isFinite(valor) && valor > 0 ? valor : null
}

/** Quanto ainda cabe no orçamento do mês. `null` = sem teto configurado. */
export async function orcamentoRestanteUsd(
  userId: string,
): Promise<number | null> {
  const teto = await orcamentoMensalUsd(userId)
  if (teto == null) return null
  return teto - (await gastoDoMesUsd(userId))
}

/** Tokens acumulados do run até o momento da checagem. */
export interface UsoDoRun {
  inputTokens: number
  outputTokens: number
  /** Só Anthropic (prompt caching) — pesam 1,25× e 0,10× o input. */
  cacheWriteTokens?: number
  cacheReadTokens?: number
}

export interface GuardaOrcamento {
  /** De quantas em quantas tool calls o loop deve chamar `estourou`. */
  readonly aCadaSteps: number
  /** true = o custo deste run já consumiu o que restava do orçamento do mês. */
  estourou(uso: UsoDoRun): Promise<boolean>
}

/**
 * Cria a guarda para este run. Devolve `null` quando o usuário não tem teto
 * mensal — assim o loop nem chama a checagem (custo zero no caminho comum).
 * Nunca lança.
 */
export async function criarGuardaOrcamento(params: {
  userId: string
  /** id de catálogo do modelo (provider:modelo) — base do preço. */
  modelId: string
}): Promise<GuardaOrcamento | null> {
  const teto = await orcamentoMensalUsd(params.userId).catch(() => null)
  if (teto == null) return null

  return {
    aCadaSteps: STEPS_ENTRE_CHECAGENS,
    async estourou(uso: UsoDoRun): Promise<boolean> {
      try {
        const custoRun =
          (await computeMessageCostUsd(
            params.modelId,
            uso.inputTokens,
            uso.outputTokens,
            {
              cacheWriteTokens: uso.cacheWriteTokens,
              cacheReadTokens: uso.cacheReadTokens,
            },
          )) ?? 0
        // Sem preço cadastrado para o modelo o custo volta 0: nesse caso não há
        // como afirmar estouro, e derrubar o run seria arbitrário.
        if (custoRun <= 0) return false
        const gasto = await gastoDoMesUsd(params.userId)
        return gasto + custoRun >= teto
      } catch {
        return false
      }
    },
  }
}
