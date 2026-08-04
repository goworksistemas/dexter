/**
 * Loop agêntico de tool-use do Dexter (Anthropic).
 *
 * O Claude recebe as tools (RPCs read-only dos sistemas que o usuário acessa).
 * Quando ele decide chamar uma, o backend executa (injetando o email do
 * usuário autenticado), devolve o resultado como `tool_result`, e o loop
 * continua até o Claude produzir a resposta final em texto. Texto é streamado
 * a cada passo. Cada tool call é devolvida para auditoria (agent_tool_calls).
 *
 * Respostas longas: `max_tokens` vem do registry de modelos (llm/models.ts) —
 * em Opus/Sonnet 5 esse teto cobre thinking + texto, então um valor baixo corta
 * a resposta no meio. Se o turno ainda terminar em `stop_reason: "max_tokens"`,
 * o loop pede a continuação e emenda no texto já streamado, sem regenerar.
 *
 * Limites e saída graciosa:
 * - `maxSteps` / `maxRounds`: ao estourar, faz UMA chamada final SEM tools
 *   pedindo conclusão com o que já coletou (não some sem texto).
 * - Timeouts por chamada e por run inteiro.
 * - Tool results grandes são truncados antes de voltar ao modelo.
 */
import Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import { responseMaxTokens } from "../llm/models.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import { buildTools, describeTool, executeTool, type AnthropicTool } from "./tools.js"
import {
  resumirArgs,
  resumirResultado,
  truncar,
  type AgentProgressEvent,
} from "./progress.js"
import type { SystemAccess } from "./access.js"

export interface ToolCallRecord {
  toolName: string
  slug?: string
  fn?: string
  input: unknown
  ok: boolean
  output: unknown
  error?: string
  durationMs: number
}

export type AgentLoopEndReason =
  | "ok"
  | "max_steps"
  | "timeout"
  | "api_error"
  | "aborted"
  | "empty"

export interface AgentLoopOptions {
  model: string
  systemPrompt: string
  messages: Anthropic.MessageParam[]
  access: SystemAccess[]
  /** Conectores Notion/Outlook ativos para este usuário. */
  connectors?: ConnectorRuntime
  userId: string
  email: string
  signal?: AbortSignal
  /** chamado a cada delta de texto (para o SSE). */
  onTextDelta: (text: string) => void
  /** chamado após cada tool call (para auditoria). */
  onToolCall: (rec: ToolCallRecord) => void
  /** progresso legível do loop (fase atual, tools, duração) — para a UI. */
  onProgress?: (evt: AgentProgressEvent) => void
  /** limite de rodadas modelo↔tools (default: config). */
  maxRounds?: number
  /** limite total de tool calls (default: config). */
  maxSteps?: number
}

export interface AgentLoopResult {
  model: string
  inputTokens: number
  outputTokens: number
  /** Por que o loop encerrou — para log (sem payload sensível). */
  endReason: AgentLoopEndReason
  /** Quantas tools foram executadas neste run. */
  steps: number
}

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  return client
}

/** Quantas vezes um mesmo turno pode ser emendado após bater o `max_tokens`. */
const MAX_CONTINUACOES = 3

/** Quanto do início da continuação é bufferizado antes de emitir (limpeza). */
const CABECALHO_CONTINUACAO_CHARS = 200

const PROMPT_CONTINUACAO =
  "Sua mensagem anterior foi cortada pelo limite de tokens no meio do conteúdo. " +
  "Continue exatamente do ponto onde parou: não repita nada do que já foi escrito, " +
  "não escreva preâmbulo nem explicação, não reabra blocos de código (```) que já " +
  "estão abertos. Emende direto o restante."

const PROMPT_FINAL_FORCADO =
  "Você atingiu o limite de consultas/ferramentas nesta resposta. " +
  "Com o que já coletou nas tools acima, escreva AGORA a resposta final COMPLETA " +
  "e DETALHADA ao usuário em português: fatos com números/campos reais, vínculos, " +
  "interpretação e recomendação se couber. Use tabelas markdown quando houver dados. " +
  "NÃO chame mais tools. NÃO invente o que não veio nas tools. " +
  "Se faltar dado crítico, diga exatamente o que falta e o que já apurou."

const PROMPT_FECHAR_RESPOSTA =
  "Você narrou intenção ou parou sem fechar. " +
  "Com o que as tools acima já retornaram, escreva AGORA a resposta final COMPLETA " +
  "e DETALHADA em português (fatos + escopo + conclusão acionável). " +
  "NÃO chame mais tools. NÃO invente. Não repita preâmbulos " +
  "('deixa eu puxar' / 'vou buscar' / 'um momento')."

/** Texto que parece intenção/preâmbulo sem conclusão — comum após tools. */
function respostaIncompleta(texto: string, teveTools: boolean): boolean {
  if (!teveTools) return false
  const t = texto.trim()
  if (!t) return true
  const narracao =
    /^(deixa eu|vou (puxar|buscar|consultar|verificar|olhar|checar)|um momento|aguarde|já (volto|pego)|ok[,!]?\s*(vou|deixa))/i.test(
      t,
    ) ||
    /(deixa eu puxar|números certos|vou (consultar|buscar|puxar|verificar)|já busco|em seguida (vou|busco)|agora (vou|busco))/i.test(
      t,
    )
  if (narracao && t.length < 700) return true
  if (/(\.{3}|…)\s*$/.test(t) && t.length < 280 && !/\b\d+\b/.test(t)) {
    return true
  }
  // Narrativa de progresso entre tools sem dossiê/tabela/números densos.
  if (
    teveTools &&
    t.length < 400 &&
    /^(encontrei|pronto|aqui está|vou |agora )/i.test(t) &&
    !/\|.+\|/.test(t) &&
    (t.match(/\b\d+\b/g)?.length ?? 0) < 2
  ) {
    return true
  }
  return false
}

/** Há um bloco ``` aberto e não fechado no texto já emitido? */
function fenceAberto(texto: string): boolean {
  const fences = texto.match(/^```/gm)
  return (fences?.length ?? 0) % 2 === 1
}

/** Remove repetição do fim do texto anterior no começo da continuação. */
function removerSobreposicao(cabecalho: string, anterior: string): string {
  const max = Math.min(400, anterior.length, cabecalho.length)
  for (let n = max; n >= 24; n--) {
    if (cabecalho.startsWith(anterior.slice(anterior.length - n))) {
      return cabecalho.slice(n)
    }
  }
  return cabecalho
}

/**
 * Limpa o início da continuação para emendar sem costura visível: tira
 * preâmbulo ("Continuando:"), fence reaberto e trecho repetido. A quebra de
 * linha inicial só é removida se o texto anterior já terminava em linha nova —
 * senão ela é justamente o que faltava para fechar a linha cortada.
 */
function emendarContinuacao(cabecalho: string, anterior: string): string {
  let out = cabecalho
  if (anterior.endsWith("\n")) out = out.replace(/^[\r\n\t ]+/, "")
  out = out.replace(
    /^(?:continuando|continuação|continuo|seguindo|segue)\b[^\n]{0,60}\r?\n+/i,
    "",
  )
  if (fenceAberto(anterior)) out = out.replace(/^```[\w-]*[ \t]*\r?\n/, "")
  return removerSobreposicao(out, anterior)
}

/** Fingerprint estável de tool+args para anti-loop. */
function toolCallFingerprint(name: string, input: unknown): string {
  try {
    return `${name}::${JSON.stringify(input ?? {})}`
  } catch {
    return `${name}::?`
  }
}

/** Resultado sem conteúdo útil (modelo refetcha em loop). */
function isToolResultVazio(result: unknown): boolean {
  if (result === null || result === undefined) return true
  if (typeof result === "string") return result.trim().length < 8
  if (Array.isArray(result)) return result.length === 0
  if (typeof result === "object") {
    const keys = Object.keys(result as object)
    if (keys.length === 0) return true
    // MCP cru sem texto útil
    const r = result as { content?: unknown; structuredContent?: unknown }
    if (
      "content" in r &&
      Array.isArray(r.content) &&
      r.content.length === 0 &&
      r.structuredContent == null
    ) {
      return true
    }
  }
  return false
}

/** Trunca tool_result grande para não estourar a janela de contexto.
 *  Preserva totais agregados (GoDash) quando existirem.
 *  NUNCA colapsa JSON genérico (ex.: Notion MCP) em `{}` — isso apagava
 *  schema/markdown de notion-fetch e fazia o agent loop refetchar sem progresso. */
function truncarToolResultContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content

  const rodape = (omitidos: number) =>
    `\n\n[…resultado truncado (${omitidos} chars omitidos); use o trecho acima — não refetch o mesmo id]`

  try {
    const parsed = JSON.parse(content) as unknown

    // Texto Notion (markdown/schema) chega como JSON string.
    if (typeof parsed === "string") {
      const budget = Math.max(500, maxChars - 120)
      if (parsed.length <= budget) return content
      return JSON.stringify(parsed.slice(0, budget) + rodape(parsed.length - budget))
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const aggregateKeys = [
        "total_encontrado",
        "total_retornado",
        "total",
        "count",
        "aviso",
        "erro",
        "filtros",
        "limite_aplicado",
      ] as const
      const hasAggregate = aggregateKeys.some((k) => k in obj)

      // Só o caminho GoDash (listas com total_*): preserva agregados.
      if (hasAggregate) {
        const preserved: Record<string, unknown> = {}
        for (const key of aggregateKeys) {
          if (key in obj) preserved[key] = obj[key]
        }
        const linhas = obj.linhas ?? obj.itens
        if (Array.isArray(linhas) && linhas.length <= 5) {
          preserved[Array.isArray(obj.linhas) ? "linhas" : "itens"] = linhas
        }
        const header = JSON.stringify(preserved, null, 2)
        if (header.length < maxChars) {
          return (
            header +
            "\n\n[…lista/demais campos truncados; use total_encontrado/total_retornado/count acima como total autoritativo]"
          )
        }
      }
    }
  } catch {
    /* não-JSON */
  }

  return content.slice(0, maxChars) + rodape(content.length - maxChars)
}

function mensagemApiError(err: unknown): string {
  if (!(err instanceof Error)) return "Erro desconhecido na API do modelo."
  const msg = err.message || "Erro na API do modelo."
  // Mensagens comuns da Anthropic — deixa legível sem vazar internals.
  if (/overloaded|529/i.test(msg)) {
    return "O modelo está sobrecarregado agora. Tente novamente em instantes."
  }
  if (/rate.?limit|429/i.test(msg)) {
    return "Limite de requisições atingido. Aguarde um momento e tente novamente."
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(msg)) {
    return "A chamada ao modelo demorou demais e foi interrompida."
  }
  if (/context.?length|too many tokens|maximum context/i.test(msg)) {
    return "O contexto desta conversa ficou grande demais após as consultas. Tente novamente com um pedido mais focado."
  }
  return msg.length > 280 ? `${msg.slice(0, 279)}…` : msg
}

function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const ativos = signals.filter((s): s is AbortSignal => !!s)
  if (ativos.length === 0) return undefined
  if (ativos.length === 1) return ativos[0]
  if (typeof AbortSignal.any === "function") return AbortSignal.any(ativos)
  // Fallback Node antigo: só o primeiro.
  return ativos[0]
}

/** Roda o loop de tool-use com streaming. */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const tools: AnthropicTool[] = await buildTools({
    access: opts.access,
    connectors: opts.connectors,
    userId: opts.userId,
  })
  // Tool server-side da Anthropic: a busca roda na API deles (com citações),
  // não passa pelo executeTool local. Blocos vêm como server_tool_use.
  const apiTools: unknown[] = [...tools]
  if (config.WEB_SEARCH_ENABLED) {
    apiTools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: config.WEB_SEARCH_MAX_USES,
    })
  }
  const messages: Anthropic.MessageParam[] = [...opts.messages]
  const maxRounds = opts.maxRounds ?? config.AGENT_MAX_ROUNDS
  const maxSteps = opts.maxSteps ?? config.AGENT_MAX_STEPS
  const maxTokens = responseMaxTokens(opts.model)
  const toolResultMax = config.AGENT_TOOL_RESULT_MAX_CHARS
  const callTimeoutMs = config.AGENT_CALL_TIMEOUT_MS
  const runTimeoutMs = config.AGENT_RUN_TIMEOUT_MS
  const runDeadline = Date.now() + runTimeoutMs

  let inputTokens = 0
  let outputTokens = 0
  let lastModel = opts.model
  let step = 0
  let ultimoStatus = ""
  /** Todo o texto já entregue ao front nesta requisição (base da emenda). */
  let textoEmitido = ""
  let endReason: AgentLoopEndReason = "ok"
  /** Conta falhas/vazios da mesma tool+args — corta loop Notion refetch. */
  const toolFailCounts = new Map<string, number>()

  const progress = (evt: AgentProgressEvent): void => opts.onProgress?.(evt)
  const status = (text: string): void => {
    if (text === ultimoStatus) return
    ultimoStatus = text
    progress({ type: "status", text, ...(step > 0 ? { step } : {}) })
  }

  const emitirTexto = (texto: string): void => {
    textoEmitido += texto
    opts.onTextDelta(texto)
  }

  const estourado = (): boolean => Date.now() >= runDeadline
  const abortado = (): boolean => !!opts.signal?.aborted

  /**
   * Um turno de streaming (com ou sem tools). Continua automaticamente se
   * `stop_reason === max_tokens` e não houver tool_use pendente.
   */
  async function streamTurn(params: {
    allowTools: boolean
    /** Mensagem user extra (continuação forçada / síntese final). */
    extraUser?: string
  }): Promise<Anthropic.Message> {
    if (params.extraUser) {
      messages.push({ role: "user", content: params.extraUser })
    }

    let final: Anthropic.Message | null = null

    for (let tentativa = 0; tentativa <= MAX_CONTINUACOES; tentativa++) {
      if (abortado()) {
        endReason = "aborted"
        throw new DOMException("Run abortado", "AbortError")
      }
      if (estourado()) {
        endReason = "timeout"
        throw new Error("Tempo máximo desta resposta esgotado.")
      }
      if (tentativa > 0) status("Continuando a resposta")

      const remainingMs = Math.max(5_000, runDeadline - Date.now())
      const callMs = Math.min(callTimeoutMs, remainingMs)
      const callSignal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(callMs)
          : undefined
      const signal = combineSignals(opts.signal, callSignal)

      const stream = getClient().messages.stream(
        {
          model: opts.model,
          max_tokens: maxTokens,
          system: opts.systemPrompt,
          messages,
          ...(params.allowTools && apiTools.length > 0
            ? { tools: apiTools as Anthropic.Messages.ToolUnion[] }
            : {}),
        },
        signal ? { signal } : undefined,
      )

      // Nas continuações, o início é bufferizado para tirar preâmbulo/fence
      // duplicado antes de chegar ao front. No 1º turno vai direto.
      let cabecalho: string | null = tentativa > 0 ? "" : null
      const emitirDelta = (texto: string): void => {
        if (cabecalho !== null) {
          cabecalho += texto
          if (cabecalho.length < CABECALHO_CONTINUACAO_CHARS) return
          const limpo = emendarContinuacao(cabecalho, textoEmitido)
          cabecalho = null
          if (!limpo) return
          emitirTexto(limpo)
          return
        }
        emitirTexto(texto)
      }

      try {
        for await (const event of stream) {
          if (abortado() || estourado()) break
          if (event.type === "content_block_delta") {
            const delta = event.delta as {
              type: string
              text?: string
              thinking?: string
            }
            if (delta.type === "text_delta" && delta.text) {
              status(tentativa > 0 ? "Continuando a resposta" : "Gerando resposta")
              emitirDelta(delta.text)
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              progress({ type: "thinking", text: truncar(delta.thinking) })
            }
            continue
          }
          if (event.type === "content_block_start") {
            const block = event.content_block as { type: string; name?: string }
            if (block.type === "tool_use" && block.name) {
              const { systemLabel, slug } = describeTool(block.name)
              status(`Preparando consulta em ${systemLabel ?? slug ?? "sistema"}`)
            } else if (block.type === "server_tool_use") {
              status("Buscando na internet")
            } else if (block.type === "web_search_tool_result") {
              status("Lendo resultados da web")
            }
          }
        }

        if (cabecalho !== null) {
          const limpo = emendarContinuacao(cabecalho, textoEmitido)
          if (limpo) emitirTexto(limpo)
        }

        if (abortado()) {
          endReason = "aborted"
          throw new DOMException("Run abortado", "AbortError")
        }
        if (estourado()) {
          endReason = "timeout"
          throw new Error("Tempo máximo desta resposta esgotado.")
        }

        final = await stream.finalMessage()
      } catch (err) {
        if (abortado()) {
          endReason = "aborted"
          throw err
        }
        if (estourado() || (err instanceof Error && /timeout|AbortError/i.test(err.name + err.message))) {
          endReason = "timeout"
          throw new Error("Tempo máximo desta resposta esgotado.")
        }
        endReason = "api_error"
        throw new Error(mensagemApiError(err))
      }

      inputTokens += final.usage.input_tokens
      outputTokens += final.usage.output_tokens
      lastModel = final.model

      const temToolUse = final.content.some((c) => c.type === "tool_use")
      if (final.stop_reason !== "max_tokens" || temToolUse) break

      // Corte por tamanho sem tool_use → emenda.
      messages.push({ role: "assistant", content: final.content })
      messages.push({ role: "user", content: PROMPT_CONTINUACAO })
    }

    if (!final) {
      endReason = "api_error"
      throw new Error("O modelo não retornou mensagem.")
    }
    return final
  }

  async function sintetizarFinal(motivo: "max_steps" | "timeout"): Promise<void> {
    status(
      motivo === "timeout"
        ? "Fechando a resposta (tempo esgotado)"
        : "Consolidando o que já coletei",
    )
    try {
      await streamTurn({
        allowTools: false,
        extraUser: PROMPT_FINAL_FORCADO,
      })
      endReason = motivo
    } catch (err) {
      if (endReason === "aborted") throw err
      // Se a síntese falhar, ainda entregamos algo útil abaixo.
      if (endReason === "ok" || endReason === "empty") endReason = motivo
    }
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (abortado()) {
        endReason = "aborted"
        break
      }
      if (estourado()) {
        await sintetizarFinal("timeout")
        break
      }

      const allowTools = step < maxSteps && apiTools.length > 0
      status(
        round === 0
          ? "Pensando"
          : step > 0
            ? "Interpretando os dados"
            : "Pensando",
      )

      const final = await streamTurn({ allowTools })

      // Busca web server-side pode pausar o turno no meio (pause_turn):
      // devolve o conteúdo como está e continua na próxima rodada.
      if (final.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: final.content })
        continue
      }

      const toolUses = final.content.filter(
        (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
      )

      if (toolUses.length === 0) {
        if (respostaIncompleta(textoEmitido, step > 0)) {
          status("Fechando a resposta")
          try {
            await streamTurn({
              allowTools: false,
              extraUser: PROMPT_FECHAR_RESPOSTA,
            })
            endReason = textoEmitido.trim() ? "ok" : "empty"
          } catch (err) {
            if (abortado()) throw err
            endReason = textoEmitido.trim() ? "ok" : "empty"
          }
          break
        }
        endReason = textoEmitido.trim() ? "ok" : "empty"
        break
      }

      // Sem tools permitidas mas o modelo pediu tool_use — força texto.
      if (!allowTools) {
        messages.push({ role: "assistant", content: final.content })
        await sintetizarFinal("max_steps")
        break
      }

      messages.push({ role: "assistant", content: final.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        if (step >= maxSteps) break

        const started = Date.now()
        const descricao = describeTool(tu.name)
        const argsSummary = resumirArgs(tu.input)
        step += 1
        ultimoStatus = descricao.label
        progress({
          type: "tool_call_start",
          id: tu.id,
          step,
          tool: tu.name,
          ...(descricao.slug ? { system: descricao.slug } : {}),
          ...(descricao.systemLabel ? { system_label: descricao.systemLabel } : {}),
          ...(descricao.toolLabel ? { tool_label: descricao.toolLabel } : {}),
          label: descricao.label,
          ...(argsSummary ? { args_summary: argsSummary } : {}),
        })

        const fp = toolCallFingerprint(tu.name, tu.input)
        const falhasPrevias = toolFailCounts.get(fp) ?? 0

        let exec: Awaited<ReturnType<typeof executeTool>>
        if (falhasPrevias >= 2) {
          exec = {
            ok: false,
            slug: descricao.slug,
            fn: descricao.fn,
            error:
              `Anti-loop: a tool ${tu.name} com os mesmos argumentos já falhou/voltou vazia ${falhasPrevias}x. ` +
              "NÃO refetch o mesmo id. Informe o erro técnico ao usuário (permissão Notion, data_source_id errado, ou schema indisponível) e pare.",
          }
        } else {
          exec = await executeTool(
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>,
            {
              userId: opts.userId,
              email: opts.email,
              access: opts.access,
              connectors: opts.connectors,
            },
          )
          if (!exec.ok || isToolResultVazio(exec.result)) {
            toolFailCounts.set(fp, falhasPrevias + 1)
            if (exec.ok && isToolResultVazio(exec.result)) {
              exec = {
                ok: false,
                slug: exec.slug,
                fn: exec.fn,
                error:
                  "Resposta vazia da tool (sem schema/conteúdo útil). " +
                  "Não repita a mesma chamada. Se for Notion: confira o id (database vs collection:// data_source) " +
                  "ou peça ao usuário para reconectar o Notion e garantir acesso à base.",
              }
            }
          }
        }

        const durationMs = Date.now() - started
        const resumo = resumirResultado({
          ok: exec.ok,
          output: exec.result,
          error: exec.error,
        })
        progress({
          type: "tool_call_end",
          id: tu.id,
          step,
          tool: tu.name,
          status: exec.ok ? "ok" : "error",
          duration_ms: durationMs,
          ...(resumo.rows !== undefined ? { rows: resumo.rows } : {}),
          summary: resumo.summary,
        })

        opts.onToolCall({
          toolName: tu.name,
          slug: exec.slug,
          fn: exec.fn,
          input: tu.input,
          ok: exec.ok,
          output: exec.ok ? exec.result : undefined,
          error: exec.ok ? undefined : exec.error,
          durationMs,
        })

        const raw = exec.ok
          ? JSON.stringify(exec.result ?? null)
          : `Erro ao consultar: ${exec.error}`
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: truncarToolResultContent(raw, toolResultMax),
          is_error: !exec.ok,
        })
      }

      // Tools pedidas mas não executadas (bateu maxSteps no meio do lote).
      for (const tu of toolUses.slice(toolResults.length)) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content:
            "Limite de consultas desta resposta atingido — esta tool não foi executada.",
          is_error: true,
        })
      }

      messages.push({ role: "user", content: toolResults })

      // Última rodada ou teto de steps → síntese obrigatória sem tools.
      if (step >= maxSteps || round >= maxRounds - 1) {
        await sintetizarFinal("max_steps")
        break
      }
    }
  } catch (err) {
    if (abortado()) {
      endReason = "aborted"
      throw err
    }
    // streamTurn já pode ter setado timeout/api_error antes do throw.
    if (endReason === "ok") endReason = "api_error"

    const msgErro = mensagemApiError(err)
    const msgTimeout =
      "Esta resposta demorou demais e foi interrompida. Toque em **Tentar novamente** ou refine o pedido."
    const eTimeout =
      endReason === ("timeout" as AgentLoopEndReason) ||
      /demorou demais|tempo máximo/i.test(msgErro)

    if (eTimeout) endReason = "timeout"

    if (!textoEmitido.trim()) {
      status("Erro")
      emitirTexto(eTimeout ? msgTimeout : `Não consegui concluir a resposta: ${msgErro}`)
    } else {
      emitirTexto(`\n\n_Interrompido: ${msgErro}_`)
    }
  }

  if (!textoEmitido.trim()) {
    const fallbackPorMotivo: Record<AgentLoopEndReason, string> = {
      max_steps:
        "Atingi o limite de consultas nesta resposta e não consegui redigir o texto final. Toque em **Tentar novamente**.",
      timeout: "Tempo esgotado sem texto gerado. Toque em **Tentar novamente**.",
      api_error:
        "Não obtive texto do modelo nesta rodada. Toque em **Tentar novamente**.",
      aborted: "Geração cancelada.",
      empty:
        "Não obtive texto do modelo nesta rodada. Toque em **Tentar novamente**.",
      ok: "Não obtive texto do modelo nesta rodada. Toque em **Tentar novamente**.",
    }
    emitirTexto(fallbackPorMotivo[endReason])
    if (endReason === "ok") endReason = "empty"
  }

  return {
    model: lastModel,
    inputTokens,
    outputTokens,
    endReason,
    steps: step,
  }
}
