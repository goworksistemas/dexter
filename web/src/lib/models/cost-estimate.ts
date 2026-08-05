/**
 * Estimativa local do custo da PRÓXIMA mensagem.
 *
 * Nada aqui chama o server: usa o texto que está no composer, o histórico que a
 * thread já tem carregado e o preço do modelo que veio em `GET /api/models`.
 * É uma previsão, não faturamento — o valor real depende do tokenizer do
 * provider, do tamanho da resposta e das ferramentas que o agente decidir usar.
 */
import { pricingParts } from "./model-meta"

/**
 * 1 token ≈ 4 caracteres. Mesma heurística do orçamento de contexto do server
 * (`services/context-budget.ts`, `CHARS_POR_TOKEN`), para as duas pontas
 * estimarem igual.
 */
const CHARS_POR_TOKEN = 4

/**
 * Janela deslizante do server (`CONTEXT_WINDOW_MESSAGES`, default 12): a cada
 * turno o AgentCore reenvia as últimas 12 mensagens do banco. Elas são cobradas
 * de novo como entrada, então entram na conta.
 */
const HISTORICO_MAX_MENSAGENS = 12

/**
 * System prompt + catálogo de ferramentas do agente. São ~3.000 tokens fixos em
 * TODA requisição, independentemente do que o usuário digitou; sem esse piso a
 * estimativa de uma pergunta curta ficaria dez vezes menor que a realidade.
 */
const TOKENS_SYSTEM_PROMPT = 3_000

/**
 * Expectativa de resposta: o tamanho não cresce linearmente com a pergunta,
 * então usamos uma base típica de chat (~600 tokens, uns 2–3 parágrafos) que
 * cresce suavemente com o que foi digitado — prompts longos ("escreva um
 * relatório sobre…") tendem a pedir gerações maiores — com teto de 2.048
 * tokens para não inventar precisão que não existe. Quando a conversa já tem
 * respostas com `tokens_out` medido, a média real entra como piso da
 * expectativa (evidência melhor que qualquer heurística).
 */
const TOKENS_SAIDA_BASE = 600
const TOKENS_SAIDA_POR_TOKEN_DIGITADO = 1.5
const TOKENS_SAIDA_TETO = 2_048

/** Uma mensagem já carregada na thread (usuário ou assistente). */
export interface MensagemHistorico {
  texto: string
  /** `tokens_out` real da resposta, quando o payload da mensagem trouxe. */
  tokensOut?: number | null
}

export interface EstimativaCusto {
  /** Custo total previsto em USD: entrada + resposta (a UI converte p/ BRL). */
  usd: number
  /** Parcela da entrada (system + histórico + digitado) em USD. */
  usdEntrada: number
  /** Parcela da resposta esperada em USD. */
  usdSaida: number
  tokensEntrada: number
  tokensSaida: number
  /** Quanto da entrada é histórico reenviado. */
  tokensHistorico: number
  tokensSystem: number
  tokensDigitado: number
  /** true = expectativa de resposta ancorada nas respostas reais desta conversa. */
  saidaMedida: boolean
}

export function estimarTokens(texto: string): number {
  if (!texto) return 0
  return Math.ceil(texto.length / CHARS_POR_TOKEN)
}

/** Imagens em base64 no markdown não são texto cobrado — não podem inflar a conta. */
export function limparTextoParaEstimativa(texto: string): string {
  if (!texto.includes("data:image/")) return texto
  return texto.replace(
    /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi,
    "[imagem]",
  )
}

/**
 * Custo previsto da mensagem que está sendo escrita. `null` quando o modelo não
 * tem preço conhecido (local/grátis) — nesse caso a UI não mostra nada.
 */
export function estimarCustoMensagem(params: {
  /** Texto atual do composer. */
  texto: string
  /** Mensagens da conversa, em ordem cronológica. */
  historico: MensagemHistorico[]
  inputUsdPerMillion?: number | null
  outputUsdPerMillion?: number | null
}): EstimativaCusto | null {
  const { inp, out } = pricingParts({
    inputUsdPerMillion: params.inputUsdPerMillion,
    outputUsdPerMillion: params.outputUsdPerMillion,
  })
  const precoIn = inp != null && Number.isFinite(inp) && inp > 0 ? inp : 0
  const precoOut = out != null && Number.isFinite(out) && out > 0 ? out : 0
  if (precoIn === 0 && precoOut === 0) return null

  const janela = params.historico.slice(-HISTORICO_MAX_MENSAGENS)
  const tokensHistorico = janela.reduce(
    (acc, m) => acc + estimarTokens(limparTextoParaEstimativa(m.texto)),
    0,
  )
  const tokensDigitado = estimarTokens(params.texto.trim())
  const tokensEntrada =
    TOKENS_SYSTEM_PROMPT + tokensHistorico + tokensDigitado

  // Heurística com teto: cresce com a mensagem, sem prometer precisão.
  const saidaHeuristica = Math.min(
    TOKENS_SAIDA_TETO,
    TOKENS_SAIDA_BASE + tokensDigitado * TOKENS_SAIDA_POR_TOKEN_DIGITADO,
  )
  const saidasMedidas = janela
    .map((m) => m.tokensOut)
    .filter((n): n is number => n != null && Number.isFinite(n) && n > 0)
  const saidaMedida = saidasMedidas.length > 0
  const mediaMedida = saidaMedida
    ? saidasMedidas.reduce((a, b) => a + b, 0) / saidasMedidas.length
    : 0
  // A média real da conversa é piso (não teto): se as respostas desta conversa
  // vêm longas, uma pergunta curta não deve derrubar a expectativa.
  const tokensSaida = Math.round(Math.max(mediaMedida, saidaHeuristica))

  const usdEntrada = (tokensEntrada / 1_000_000) * precoIn
  const usdSaida = (tokensSaida / 1_000_000) * precoOut

  return {
    usd: usdEntrada + usdSaida,
    usdEntrada,
    usdSaida,
    tokensEntrada,
    tokensSaida,
    tokensHistorico,
    tokensSystem: TOKENS_SYSTEM_PROMPT,
    tokensDigitado,
    saidaMedida,
  }
}

export {
  CHARS_POR_TOKEN,
  HISTORICO_MAX_MENSAGENS,
  TOKENS_SAIDA_BASE,
  TOKENS_SAIDA_TETO,
  TOKENS_SYSTEM_PROMPT,
}
