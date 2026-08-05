/**
 * Rótulos de UI para metadados de modelos.
 * Preços reais: entrada e saída em USD / 1M tokens (sem média). A UI exibe em
 * BRL (ver `./currency`); o USD segue como base de cálculo.
 */
import { formatBRLPerMillion } from "./currency"
import type { ModelCapabilities, ModelInfo, ModelKeySource } from "./types"

export const KEY_SOURCE_LABEL: Record<Exclude<ModelKeySource, "free">, string> = {
  personal: "Sua API",
  company: "GoWork",
}

export type ModelCostTier = "free" | "low" | "mid" | "high" | "premium"

export function providerShortLabel(
  model: Pick<ModelInfo, "provider" | "providerLabel">,
): string {
  return model.providerLabel?.trim() || model.provider
}

export function keySourceClass(source: ModelKeySource): string {
  if (source === "personal") {
    return "bg-violet-500/15 text-violet-800 dark:text-violet-300"
  }
  if (source === "company") {
    return "bg-slate-500/10 text-slate-700 dark:text-slate-300"
  }
  return ""
}

/** Número exato de tokens (sem arredondar pra "128k"). */
export function formatTokenCount(n?: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null
  return `${Math.floor(n).toLocaleString("pt-BR")} ctx`
}

/** Tokens de forma legível: 1.048.576 → "1M", 65.536 → "66 mil". */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) {
    const mi = Math.round((n / 1_000_000) * 10) / 10
    return `${mi.toLocaleString("pt-BR")}M`
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000).toLocaleString("pt-BR")} mil`
  }
  return Math.floor(n).toLocaleString("pt-BR")
}

/**
 * Só contexto real (input), em linguagem humana. Não usa max out como
 * fallback. Ex.: "contexto 1M tokens · saída até 66 mil".
 */
export function modelContextHint(model: ModelInfo): string | null {
  const ctx = model.inputTokenLimit
  if (ctx == null || !Number.isFinite(ctx) || ctx <= 0) return null
  const base = `contexto ${formatTokensCompact(ctx)} tokens`
  if (model.maxOutputTokens != null && model.maxOutputTokens > 0) {
    return `${base} · saída até ${formatTokensCompact(model.maxOutputTokens)}`
  }
  return base
}

const MES_CURTO = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
] as const

/**
 * Data de lançamento em linguagem de card: "lançado em mar/2026".
 * `null` quando o catálogo não informa (ou a data é inválida) — o card
 * simplesmente omite o trecho, sem inventar.
 */
export function modelReleaseHint(
  model: Pick<ModelInfo, "releasedAt">,
): string | null {
  if (!model.releasedAt) return null
  const t = Date.parse(model.releasedAt)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `lançado em ${MES_CURTO[d.getUTCMonth()]}/${d.getUTCFullYear()}`
}

export function formatUsdPerMillion(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(2)}`
}

type PricingModel = {
  inputUsdPerMillion?: number | null
  outputUsdPerMillion?: number | null
  input_usd_per_million?: number | null
  output_usd_per_million?: number | null
}

export function pricingParts(model: PricingModel): {
  inp: number | null
  out: number | null
} {
  return {
    inp: model.inputUsdPerMillion ?? model.input_usd_per_million ?? null,
    out: model.outputUsdPerMillion ?? model.output_usd_per_million ?? null,
  }
}

/** Tem preço > 0 em entrada ou saída. */
export function modelHasPaidPrice(model: PricingModel): boolean {
  const { inp, out } = pricingParts(model)
  return (inp != null && inp > 0) || (out != null && out > 0)
}

/**
 * Ordenação "mais barato": entrada primeiro (custo dominante), depois saída.
 * Não é média — compara os valores reais.
 */
export function modelCostScore(model: PricingModel): number {
  const { inp, out } = pricingParts(model)
  const inPart = inp != null && Number.isFinite(inp) ? inp : Number.POSITIVE_INFINITY
  const outPart =
    out != null && Number.isFinite(out) ? out : Number.POSITIVE_INFINITY
  if (!Number.isFinite(inPart) && !Number.isFinite(outPart)) return Number.POSITIVE_INFINITY
  // Empacota entrada (peso alto) + saída para um único número comparável.
  const a = Number.isFinite(inPart) ? inPart : 1e9
  const b = Number.isFinite(outPart) ? outPart : 1e9
  return a * 1_000_000 + b
}

export function modelCostTier(model: PricingModel): ModelCostTier {
  const { inp, out } = pricingParts(model)
  if (!modelHasPaidPrice(model)) return "free"
  // Faixa baseada no preço de ENTRADA real (fallback saída).
  const ref =
    inp != null && Number.isFinite(inp) && inp > 0
      ? inp
      : (out ?? 0)
  if (ref < 1) return "low"
  if (ref < 5) return "mid"
  if (ref < 20) return "high"
  return "premium"
}

const COST_TIER_LABEL: Record<ModelCostTier, string> = {
  free: "Grátis",
  low: "Econômico",
  mid: "Moderado",
  high: "Caro",
  premium: "Premium",
}

export function modelCostTierClass(tier: ModelCostTier): string {
  if (tier === "free") {
    return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
  }
  if (tier === "low") {
    return "bg-sky-500/12 text-sky-900 dark:text-sky-200"
  }
  if (tier === "mid") {
    return "bg-amber-500/12 text-amber-900 dark:text-amber-200"
  }
  if (tier === "high") {
    return "bg-orange-500/15 text-orange-900 dark:text-orange-200"
  }
  return "bg-rose-500/15 text-rose-900 dark:text-rose-200"
}

/** Só a cor do texto (preço em destaque no modal). */
export function modelCostTierTextClass(tier: ModelCostTier): string {
  if (tier === "free") return "text-emerald-700 dark:text-emerald-300"
  if (tier === "low") return "text-sky-800 dark:text-sky-300"
  if (tier === "mid") return "text-amber-800 dark:text-amber-300"
  if (tier === "high") return "text-orange-800 dark:text-orange-300"
  return "text-rose-800 dark:text-rose-300"
}

/** Média aritmética (in+out)/2 — null se nenhum preço. */
export function modelAvgCostUsd(model: PricingModel): number | null {
  const { inp, out } = pricingParts(model)
  const vals = [inp, out].filter(
    (n): n is number => n != null && Number.isFinite(n) && n >= 0,
  )
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

/**
 * Tag compacta: média em destaque + in→out.
 * Ex.: "méd $6.25 · $2.50→$10/1M"
 */
export function modelPricingTag(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const { inp, out } = pricingParts(model)
  const avg = modelAvgCostUsd(model)
  const avgLabel = avg != null ? `méd ${formatUsdPerMillion(avg)}` : null
  if (inp != null && out != null) {
    return `${avgLabel} · ${formatUsdPerMillion(inp)}→${formatUsdPerMillion(out)}/1M`
  }
  if (inp != null) return `${avgLabel} · ${formatUsdPerMillion(inp)} in/1M`
  return `${avgLabel} · ${formatUsdPerMillion(out)} out/1M`
}

/** Só o rótulo da média (USD/1M). */
export function modelAvgCostLabel(model: PricingModel): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const avg = modelAvgCostUsd(model)
  return avg != null ? `${formatUsdPerMillion(avg)}/1M méd.` : "—"
}

export function modelCostTierLabel(tier: ModelCostTier): string {
  return COST_TIER_LABEL[tier]
}

export function modelKeySource(model: ModelInfo): ModelKeySource {
  return model.keySource ?? "company"
}

// --- Preço em reais --------------------------------------------------------

/**
 * Tag compacta em BRL com UM valor só (a média entrada/saída).
 * Ex.: "R$ 30,77/milhão". O detalhe entrada/saída vai no tooltip
 * (`modelPricingDetailBrl`).
 */
export function modelPricingTagBrl(
  model: PricingModel,
  rate: number | null | undefined,
): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const avg = modelAvgCostUsd(model)
  if (avg == null) return "—"
  return `${formatBRLPerMillion(avg, rate)}/milhão`
}

/**
 * Valor único em destaque no card do seletor: a média entrada/saída em BRL.
 * Ex.: "R$ 30,77" (o card complementa com "por milhão de tokens").
 */
export function modelPricingHeadlineBrl(
  model: PricingModel,
  rate: number | null | undefined,
): string {
  if (!modelHasPaidPrice(model)) return "Grátis"
  const avg = modelAvgCostUsd(model)
  return avg != null ? formatBRLPerMillion(avg, rate) : "—"
}

/**
 * Detalhe discreto de entrada/saída em BRL, por milhão de tokens.
 * Ex.: "entrada R$ 10,26 · saída R$ 51,29". `null` quando não há preço.
 */
export function modelPricingInOutBrl(
  model: PricingModel,
  rate: number | null | undefined,
): string | null {
  if (!modelHasPaidPrice(model)) return null
  const { inp, out } = pricingParts(model)
  const parts: string[] = []
  if (inp != null) parts.push(`entrada ${formatBRLPerMillion(inp, rate)}`)
  if (out != null) parts.push(`saída ${formatBRLPerMillion(out, rate)}`)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Texto explicativo em BRL (tooltip do preço) — autocontido e sem jargão. */
export function modelPricingDetailBrl(
  model: PricingModel,
  rate: number | null | undefined,
): string {
  if (!modelHasPaidPrice(model)) {
    return "Sem custo por uso (ex.: modelo local)"
  }
  const avg = modelAvgCostUsd(model)
  const tier = COST_TIER_LABEL[modelCostTier(model)]
  const parts: string[] = []
  if (avg != null) parts.push(`média ${formatBRLPerMillion(avg, rate)}`)
  const inOut = modelPricingInOutBrl(model, rate)
  if (inOut) parts.push(inOut)
  return `Preço por milhão de tokens: ${parts.join(" · ")} · ${tier}`
}

// --- Descrição amigável ("o que é" / "quando usar") ------------------------

/** Vocação principal do modelo — vira badge discreto no seletor. */
export type ModelProfile =
  | "raciocinio"
  | "equilibrio"
  | "rapido"
  | "imagem"
  | "local"

export interface ModelFriendlyMeta {
  /** O que o modelo é, em uma linha. */
  descricao: string
  /** Para que serve no dia a dia — inclui o contrapeso (preço/velocidade). */
  quandoUsar: string
  perfil: ModelProfile
}

const PROFILE_LABEL: Record<ModelProfile, string> = {
  raciocinio: "Raciocínio",
  equilibrio: "Equilíbrio",
  rapido: "Rápido",
  imagem: "Imagem",
  local: "Local",
}

export function modelProfileLabel(perfil: ModelProfile): string {
  return PROFILE_LABEL[perfil]
}

export function modelProfileClass(perfil: ModelProfile): string {
  if (perfil === "raciocinio") {
    return "bg-indigo-500/12 text-indigo-900 dark:text-indigo-200"
  }
  if (perfil === "equilibrio") {
    return "bg-teal-500/12 text-teal-900 dark:text-teal-200"
  }
  if (perfil === "rapido") {
    return "bg-lime-500/15 text-lime-900 dark:text-lime-200"
  }
  if (perfil === "imagem") {
    return "bg-fuchsia-500/12 text-fuchsia-900 dark:text-fuchsia-200"
  }
  return "bg-slate-500/12 text-slate-800 dark:text-slate-200"
}

/** O que a função precisa saber do modelo (aceita `ModelInfo` direto). */
type FriendlyInput = {
  id: string
  label?: string
  provider?: string
  description?: string | null
  capabilities?: ModelCapabilities
}

interface FriendlyRule {
  test: (ctx: { alvo: string; model: FriendlyInput }) => boolean
  meta: ModelFriendlyMeta
}

/**
 * Camada curada em pt-BR. As descrições que vêm das APIs dos providers são
 * técnicas e em inglês — aqui casamos por família/padrão de id e escrevemos o
 * que o usuário precisa saber para escolher. Ordem importa: regras específicas
 * (imagem, local) vêm antes das famílias de texto.
 */
const FRIENDLY_RULES: FriendlyRule[] = [
  {
    test: ({ alvo }) => /nano.?banana|flash-image|imagen/.test(alvo),
    meta: {
      descricao:
        "Modelo de imagem do Google: rápido, barato e muito bom em editar a partir de uma referência.",
      quandoUsar:
        "Gerar variações, trocar elementos de uma cena e ajustar uma imagem que você já tem.",
      perfil: "imagem",
    },
  },
  {
    test: ({ alvo }) => /gpt-image|dall.?e/.test(alvo),
    meta: {
      descricao:
        "Modelo de imagem da OpenAI: segue instruções detalhadas e escreve texto legível na imagem.",
      quandoUsar:
        "Peças com texto, ícones e composições com muitos requisitos — mais caro que os alternativos.",
      perfil: "imagem",
    },
  },
  {
    test: ({ model }) => model.capabilities?.imageGeneration === true,
    meta: {
      descricao: "Gera imagens a partir de uma descrição em texto.",
      quandoUsar:
        "Criar mockups e ilustrações — não use para perguntas de texto, ele não conversa.",
      perfil: "imagem",
    },
  },
  {
    test: ({ model }) => model.provider === "ollama",
    meta: {
      descricao:
        "Roda na máquina local: nada sai para a nuvem e não há custo por token.",
      quandoUsar:
        "Testes, dados sensíveis e uso sem internet — a qualidade fica abaixo dos modelos de nuvem.",
      perfil: "local",
    },
  },
  {
    test: ({ alvo }) => /opus/.test(alvo),
    meta: {
      descricao:
        "O modelo mais capaz da Anthropic para análise profunda e raciocínio longo.",
      quandoUsar:
        "Relatórios complexos, investigações com muitas fontes e decisões importantes — mais caro e mais lento.",
      perfil: "raciocinio",
    },
  },
  {
    test: ({ alvo }) => /sonnet/.test(alvo),
    meta: {
      descricao:
        "O equilíbrio da Anthropic: quase a qualidade do Opus por uma fração do preço.",
      quandoUsar:
        "Escolha padrão do dia a dia: código, redação e análise com várias etapas.",
      perfil: "equilibrio",
    },
  },
  {
    test: ({ alvo }) => /haiku/.test(alvo),
    meta: {
      descricao: "O modelo mais leve e rápido da Anthropic.",
      quandoUsar:
        "Perguntas rápidas, resumos e tarefas do dia a dia — quase instantâneo e muito barato.",
      perfil: "rapido",
    },
  },
  {
    test: ({ alvo }) =>
      /(^|[^a-z])o[1-9]([^a-z0-9]|$)/.test(alvo) && /mini|nano/.test(alvo),
    meta: {
      descricao:
        "Versão enxuta do raciocínio da OpenAI: pensa por etapas gastando bem menos.",
      quandoUsar:
        "Lógica e matemática do dia a dia quando o custo pesa mais que o último ponto de precisão.",
      perfil: "equilibrio",
    },
  },
  {
    test: ({ alvo }) => /(^|[^a-z])o[1-9]([^a-z0-9]|$)/.test(alvo),
    meta: {
      descricao:
        "Modelo de raciocínio da OpenAI: pensa em várias etapas antes de responder.",
      quandoUsar:
        "Matemática, lógica e depuração difícil — responde mais devagar e cobra os tokens de raciocínio.",
      perfil: "raciocinio",
    },
  },
  {
    test: ({ alvo }) => /gpt-/.test(alvo) && /mini|nano/.test(alvo),
    meta: {
      descricao: "Versão econômica e rápida da linha GPT.",
      quandoUsar:
        "Classificação, extração de dados, respostas curtas e volume alto de chamadas.",
      perfil: "rapido",
    },
  },
  {
    test: ({ alvo }) => /gpt-[5-9]/.test(alvo),
    meta: {
      descricao:
        "A geração mais recente da OpenAI, forte em código e em seguir instruções longas.",
      quandoUsar:
        "Tarefas longas de código, leitura de documentos e conversas com muito contexto.",
      perfil: "raciocinio",
    },
  },
  {
    test: ({ alvo }) => /gpt-4|gpt-3/.test(alvo),
    meta: {
      descricao:
        "Modelo multimodal da OpenAI, equilibrado entre custo, velocidade e qualidade.",
      quandoUsar:
        "Uso geral: chat, leitura de imagens e PDFs, redação e código do dia a dia.",
      perfil: "equilibrio",
    },
  },
  {
    test: ({ alvo }) => /deepseek/.test(alvo) && /reasoner|r1/.test(alvo),
    meta: {
      descricao:
        "Raciocínio da DeepSeek por um preço muito abaixo dos concorrentes.",
      quandoUsar:
        "Problemas lógicos e matemáticos quando dá para esperar alguns segundos a mais.",
      perfil: "raciocinio",
    },
  },
  {
    test: ({ alvo }) => /deepseek/.test(alvo),
    meta: {
      descricao: "Modelo de uso geral da DeepSeek: barato e competente em código.",
      quandoUsar:
        "Alternativa econômica para código e texto quando o volume é grande.",
      perfil: "equilibrio",
    },
  },
  {
    test: ({ alvo }) => /grok/.test(alvo) && /mini|fast|lite/.test(alvo),
    meta: {
      descricao: "Versão rápida e econômica do Grok, da xAI.",
      quandoUsar: "Respostas curtas e tarefas simples com custo baixo.",
      perfil: "rapido",
    },
  },
  {
    test: ({ alvo }) => /grok/.test(alvo),
    meta: {
      descricao:
        "Modelo da xAI com bom desempenho em raciocínio e conhecimento recente.",
      quandoUsar:
        "Perguntas sobre acontecimentos atuais e análise que exige contexto amplo.",
      perfil: "raciocinio",
    },
  },
  {
    test: ({ alvo }) => /gemini/.test(alvo) && /flash.?lite/.test(alvo),
    meta: {
      descricao: "A opção mais barata e rápida da linha Gemini.",
      quandoUsar:
        "Tarefas simples em grande volume: classificar, extrair campos e resumir.",
      perfil: "rapido",
    },
  },
  {
    test: ({ alvo }) => /gemini/.test(alvo) && /flash/.test(alvo),
    meta: {
      descricao:
        "Rápido e barato, com janela de contexto muito grande para o preço.",
      quandoUsar:
        "Resumir documentos longos e responder o dia a dia sem estourar o custo.",
      perfil: "rapido",
    },
  },
  {
    test: ({ alvo }) => /gemini/.test(alvo) && /pro|ultra/.test(alvo),
    meta: {
      descricao:
        "O Gemini mais capaz: contexto gigante e boa leitura de documentos.",
      quandoUsar:
        "PDFs extensos, comparação de várias fontes e raciocínio mais longo — custa mais.",
      perfil: "raciocinio",
    },
  },
  {
    test: ({ alvo }) => /gemini/.test(alvo),
    meta: {
      descricao: "Modelo do Google com contexto amplo e boa relação custo/qualidade.",
      quandoUsar: "Uso geral, com folga para documentos e conversas longas.",
      perfil: "equilibrio",
    },
  },
]

function fallbackProfile(model: FriendlyInput): ModelProfile {
  if (model.capabilities?.imageGeneration) return "imagem"
  if (model.provider === "ollama") return "local"
  return "equilibrio"
}

/**
 * Descrição amigável + "quando usar" + perfil. Quando nenhum padrão casa,
 * cai na descrição que veio da API do provider (sem "quando usar", para não
 * inventar recomendação sobre um modelo que não conhecemos).
 */
export function modelFriendlyMeta(model: FriendlyInput): ModelFriendlyMeta {
  const alvo = `${model.id} ${model.label ?? ""}`.toLowerCase()
  const rule = FRIENDLY_RULES.find((r) => r.test({ alvo, model }))
  if (rule) return rule.meta
  const apiDesc = model.description?.trim()
  return {
    descricao: apiDesc || "Modelo de linguagem disponível no catálogo.",
    quandoUsar: "",
    perfil: fallbackProfile(model),
  }
}
