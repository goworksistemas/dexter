/**
 * Gerente de orçamento de contexto (item 1.10) e métricas de input (1.11).
 *
 * Antes de chamar o LLM, estima quantos tokens o payload montado vai custar e,
 * se estourar a janela do modelo, DEGRADA o contexto numa ordem fixa em vez de
 * deixar o provider devolver `context_length_exceeded` no meio do run.
 *
 * Ordem de degradação (do que menos dói para o que mais dói):
 *   1. Artefatos do bloco dinâmico caem para só o título (o modelo ainda sabe
 *      que o artefato existe e pode pedir/reescrever; o conteúdo é o maior
 *      bloco isolado do prompt).
 *   2. A janela de histórico encolhe de 2 em 2 mensagens (mínimo 4, sempre
 *      começando por uma mensagem do usuário — exigência da API da Anthropic).
 *   3. Os trechos de RAG saem (são um extra; o resumo rolling ainda cobre o
 *      histórico antigo em visão geral).
 *
 * Módulo PURO de propósito: nada de config, banco ou log aqui dentro — assim os
 * testes cobrem cálculo e degradação sem subir nada. Quem chama passa os
 * limites e registra os cortes no log com o traceId.
 */

/**
 * Aproximação de tokens por caractere. Não é o tokenizer real de nenhum
 * provider — é a heurística clássica (~4 chars/token em texto latino) e serve
 * porque a decisão aqui é "cabe com folga?" e não faturamento. Erra para mais
 * em texto denso de JSON, o que joga a favor (degrada antes de estourar).
 */
export const CHARS_POR_TOKEN = 4

/**
 * Orçamento quando o catálogo não informa `inputTokenLimit` (OpenAI, DeepSeek e
 * xAI não publicam no /models). Conservador de propósito: melhor cortar um
 * pouco cedo do que descobrir o teto com erro do provider no meio do run.
 */
export const LIMITE_INPUT_FALLBACK_TOKENS = 100_000

/** Piso da janela: abaixo disso a conversa perde o fio da meada. */
export const MIN_MENSAGENS_JANELA = 4

/** Mensagens removidas por rodada de encolhimento (1 par user/assistant). */
export const PASSO_ENCOLHIMENTO_JANELA = 2

/**
 * Bloco do system prompt dinâmico. O `tipo` existe para a degradação saber o
 * que pode mexer sem reordenar o prompt (a ordem do array é a ordem final).
 */
export type BlocoDinamico =
  | { tipo: "artefatos"; texto: string; titulos: string }
  | { tipo: "resumo"; texto: string }
  | { tipo: "rag"; texto: string }
  | { tipo: "outro"; texto: string }

export interface MensagemContexto {
  role: "user" | "assistant"
  content: string
}

export interface EntradaContexto {
  /** Bloco estático (cacheável) do system prompt. */
  systemStatic: string
  /** Blocos do system dinâmico, já na ordem em que serão concatenados. */
  blocosDinamicos: BlocoDinamico[]
  /** Histórico já cortado pela janela deslizante (sem a mensagem nova). */
  historico: MensagemContexto[]
  /** Mensagem nova do usuário deste turno. */
  novaMensagem: string
  /** `inputTokenLimit` do catálogo (llm/models.ts). Ausente → fallback. */
  inputTokenLimit?: number | null
  /** Tokens reservados para a RESPOSTA (max_tokens do modelo). */
  margemSaidaTokens: number
}

/**
 * Decomposição estimada do input. `system_dynamic` NÃO inclui resumo nem RAG:
 * eles saem separados justamente porque a pergunta que se quer responder é
 * "para onde está indo o input?".
 */
export interface MetricasInput {
  system_static: number
  system_dynamic: number
  summary: number
  rag: number
  history: number
  total: number
}

export interface CorteContexto {
  acao: "artefatos_para_titulos" | "encolher_janela" | "remover_rag"
  tokensAntes: number
  tokensDepois: number
  detalhe: string
}

export interface ResultadoContexto {
  /** Blocos finais (artefatos já podem ter virado só títulos, RAG pode ter saído). */
  blocosDinamicos: BlocoDinamico[]
  /** Histórico final (possivelmente menor que o de entrada). */
  historico: MensagemContexto[]
  metricas: MetricasInput
  /** Cortes aplicados, na ordem — cada um vira uma linha de log com traceId. */
  cortes: CorteContexto[]
  /** Teto usado (limite do modelo − margem de saída). */
  orcamentoTokens: number
  /** false = mesmo depois de degradar tudo o payload continua acima do teto. */
  dentroDoOrcamento: boolean
}

/** Estimativa de tokens de um texto (ver CHARS_POR_TOKEN). */
export function estimarTokens(texto: string): number {
  if (!texto) return 0
  return Math.ceil(texto.length / CHARS_POR_TOKEN)
}

function somaBlocos(
  blocos: BlocoDinamico[],
  tipos: BlocoDinamico["tipo"][],
): number {
  return blocos
    .filter((b) => tipos.includes(b.tipo))
    .reduce((acc, b) => acc + estimarTokens(b.texto), 0)
}

/** Decomposição do input para o log estruturado (item 1.11). */
export function calcularMetricas(
  entrada: Pick<
    EntradaContexto,
    "systemStatic" | "blocosDinamicos" | "historico" | "novaMensagem"
  >,
): MetricasInput {
  const system_static = estimarTokens(entrada.systemStatic)
  const system_dynamic = somaBlocos(entrada.blocosDinamicos, [
    "outro",
    "artefatos",
  ])
  const summary = somaBlocos(entrada.blocosDinamicos, ["resumo"])
  const rag = somaBlocos(entrada.blocosDinamicos, ["rag"])
  const history =
    entrada.historico.reduce((acc, m) => acc + estimarTokens(m.content), 0) +
    estimarTokens(entrada.novaMensagem)
  return {
    system_static,
    system_dynamic,
    summary,
    rag,
    history,
    total: system_static + system_dynamic + summary + rag + history,
  }
}

/** Teto de input deste turno: limite do modelo (ou fallback) − margem de saída. */
export function orcamentoDeEntrada(
  inputTokenLimit: number | null | undefined,
  margemSaidaTokens: number,
): number {
  const limite =
    typeof inputTokenLimit === "number" && inputTokenLimit > 0
      ? inputTokenLimit
      : LIMITE_INPUT_FALLBACK_TOKENS
  // Nunca devolve <= 0: um modelo com janela minúscula ainda precisa receber
  // alguma coisa (a degradação vai até o piso e para).
  return Math.max(1_000, limite - Math.max(0, margemSaidaTokens))
}

/**
 * Remove um par de mensagens do começo da janela, avançando até a próxima
 * mensagem do usuário. `null` quando não dá para encolher mais (piso).
 */
function encolherJanela(
  mensagens: MensagemContexto[],
): MensagemContexto[] | null {
  if (mensagens.length <= MIN_MENSAGENS_JANELA) return null
  let inicio = PASSO_ENCOLHIMENTO_JANELA
  while (inicio < mensagens.length && mensagens[inicio]!.role !== "user") {
    inicio += 1
  }
  const nova = mensagens.slice(inicio)
  if (nova.length < MIN_MENSAGENS_JANELA) return null
  if (nova.length === mensagens.length) return null
  return nova
}

/**
 * Aplica o orçamento ao contexto montado. Sem estouro, devolve a entrada como
 * está (custo: uma varredura de strings). Com estouro, degrada na ordem
 * documentada no topo do arquivo e devolve os cortes para o log.
 */
export function ajustarContexto(entrada: EntradaContexto): ResultadoContexto {
  const orcamentoTokens = orcamentoDeEntrada(
    entrada.inputTokenLimit,
    entrada.margemSaidaTokens,
  )
  let blocos = [...entrada.blocosDinamicos]
  let historico = [...entrada.historico]
  const cortes: CorteContexto[] = []

  const totalAtual = (): number =>
    calcularMetricas({
      systemStatic: entrada.systemStatic,
      blocosDinamicos: blocos,
      historico,
      novaMensagem: entrada.novaMensagem,
    }).total

  let total = totalAtual()

  // 1. Artefatos completos → só títulos.
  if (total > orcamentoTokens) {
    const idx = blocos.findIndex((b) => b.tipo === "artefatos")
    const alvo = idx >= 0 ? (blocos[idx] as Extract<BlocoDinamico, { tipo: "artefatos" }>) : null
    if (alvo && alvo.titulos.length < alvo.texto.length) {
      const antes = total
      blocos[idx] = { ...alvo, texto: alvo.titulos }
      total = totalAtual()
      cortes.push({
        acao: "artefatos_para_titulos",
        tokensAntes: antes,
        tokensDepois: total,
        detalhe: "conteúdo dos artefatos substituído pelos títulos",
      })
    }
  }

  // 2. Janela encolhe de 2 em 2 até o piso.
  while (total > orcamentoTokens) {
    const menor = encolherJanela(historico)
    if (!menor) break
    const antes = total
    const antesMsgs = historico.length
    historico = menor
    total = totalAtual()
    cortes.push({
      acao: "encolher_janela",
      tokensAntes: antes,
      tokensDepois: total,
      detalhe: `janela ${antesMsgs} → ${historico.length} mensagens`,
    })
  }

  // 3. RAG sai (o resumo rolling permanece).
  if (total > orcamentoTokens && blocos.some((b) => b.tipo === "rag")) {
    const antes = total
    blocos = blocos.filter((b) => b.tipo !== "rag")
    total = totalAtual()
    cortes.push({
      acao: "remover_rag",
      tokensAntes: antes,
      tokensDepois: total,
      detalhe: "trechos do RAG removidos do bloco dinâmico",
    })
  }

  return {
    blocosDinamicos: blocos,
    historico,
    metricas: calcularMetricas({
      systemStatic: entrada.systemStatic,
      blocosDinamicos: blocos,
      historico,
      novaMensagem: entrada.novaMensagem,
    }),
    cortes,
    orcamentoTokens,
    dentroDoOrcamento: total <= orcamentoTokens,
  }
}

/** Texto final do bloco dinâmico (blocos vazios são descartados). */
export function juntarBlocosDinamicos(blocos: BlocoDinamico[]): string {
  return blocos
    .map((b) => b.texto.trim())
    .filter((t) => t.length > 0)
    .join("\n\n")
}
