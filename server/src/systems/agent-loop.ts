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
 *
 * As funções puras do loop (truncamento, emenda da continuação, anti-loop)
 * vivem em `agent-loop-helpers.ts` — é o que os testes cobrem.
 */
import type Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import { getAnthropicClient, toAnthropicSystemBlocks } from "../lib/anthropic.js"
import { erroSanitizado } from "../lib/erro-modelo.js"
import { responseMaxTokens } from "../llm/models.js"
import type { GuardaOrcamento } from "../services/run-budget.js"
import type { SystemPromptParts } from "../llm/system-prompt.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import { buildTools, describeTool, executeTool, type AnthropicTool } from "./tools.js"
import {
  emendarContinuacao,
  isToolResultVazio,
  respostaIncompleta,
  toolCallFingerprint,
  truncarToolResultContent,
} from "./agent-loop-helpers.js"
import {
  isMultiAgentToolName,
  MULTI_AGENT_MAX_SPAWNS_PER_RUN,
} from "./multi-agent.js"
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
  /** Orçamento mensal do usuário estourou no meio do run (item 4.4). */
  | "budget"

export interface AgentLoopOptions {
  model: string
  /** String (sem cache) ou blocos estático/dinâmico (com prompt caching). */
  systemPrompt: string | SystemPromptParts
  messages: Anthropic.MessageParam[]
  access: SystemAccess[]
  /** Conectores Notion/Outlook ativos para este usuário. */
  connectors?: ConnectorRuntime
  userId: string
  email: string
  /** Projeto do chat — habilita/roteia a tool project__read_file. */
  projectId?: string
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
  /** Chave Anthropic a usar (BYOK/global). Sem ela, resolve a global. */
  apiKey?: string
  /** Usuário autorizou multi-agentes (opt-in). */
  multiAgentEnabled?: boolean
  /**
   * Guarda do orçamento mensal (services/run-budget.ts). Consultada a cada
   * `aCadaSteps` tool calls; ausente = usuário sem teto configurado.
   */
  budgetGuard?: GuardaOrcamento
}

export interface AgentLoopResult {
  model: string
  /** Tokens de entrada NÃO cacheados (o que a Anthropic cobra a preço cheio). */
  inputTokens: number
  outputTokens: number
  /**
   * Tokens gravados no cache de prompt (1,25× o preço de input) e lidos dele
   * (0,10×). Só a Anthropic tem prompt caching — nos demais providers ficam
   * indefinidos e o custo cai no cálculo simples input/output.
   */
  cacheWriteTokens?: number
  cacheReadTokens?: number
  /** Por que o loop encerrou — para log (sem payload sensível). */
  endReason: AgentLoopEndReason
  /** Quantas tools foram executadas neste run. */
  steps: number
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

const PROMPT_FINAL_ORCAMENTO =
  "O orçamento mensal de uso deste usuário foi atingido durante esta resposta. " +
  "NÃO chame mais tools. Com o que já coletou acima, escreva AGORA a resposta " +
  "final em português, completa até onde os dados permitem, e deixe explícito " +
  "o que ficou sem apurar. NÃO invente o que não veio nas tools."

/** Aviso determinístico — não depende de o modelo lembrar de mencionar. */
const AVISO_ORCAMENTO =
  "\n\n_Orçamento mensal de uso atingido: encerrei esta resposta com o que já " +
  "havia consultado. Fale com um administrador para ampliar o limite._"

const PROMPT_FECHAR_RESPOSTA =
  "Você narrou intenção ou parou sem fechar. " +
  "Com o que as tools acima já retornaram, escreva AGORA a resposta final COMPLETA " +
  "e DETALHADA em português (fatos + escopo + conclusão acionável). " +
  "NÃO chame mais tools. NÃO invente. Não repita preâmbulos " +
  "('deixa eu puxar' / 'vou buscar' / 'um momento')."

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
    projectId: opts.projectId,
    multiAgentEnabled: opts.multiAgentEnabled,
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
  // Breakpoint de cache no ÚLTIMO item: cacheia TODAS as definições de tools
  // (elas abrem o prompt e são idênticas entre turnos do mesmo usuário). Cópia
  // rasa porque o objeto pode vir de um cache de tools de conector.
  const ultimaTool = apiTools[apiTools.length - 1]
  if (ultimaTool && typeof ultimaTool === "object") {
    apiTools[apiTools.length - 1] = {
      ...(ultimaTool as Record<string, unknown>),
      cache_control: { type: "ephemeral" },
    }
  }
  const systemBlocks = toAnthropicSystemBlocks(opts.systemPrompt)
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
  let cacheWriteTokens = 0
  let cacheReadTokens = 0
  let lastModel = opts.model
  let step = 0
  let ultimoStatus = ""
  /** Todo o texto já entregue ao front nesta requisição (base da emenda). */
  let textoEmitido = ""
  let endReason: AgentLoopEndReason = "ok"
  /** Conta falhas/vazios da mesma tool+args — corta loop Notion refetch. */
  const toolFailCounts = new Map<string, number>()
  let spawnCount = 0
  /** Orçamento mensal estourou no meio deste run (item 4.4). */
  let orcamentoEstourado = false

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
        throw erroSanitizado("Tempo máximo desta resposta esgotado.")
      }
      if (tentativa > 0) status("Continuando a resposta")

      const remainingMs = Math.max(5_000, runDeadline - Date.now())
      const callMs = Math.min(callTimeoutMs, remainingMs)
      const callSignal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(callMs)
          : undefined
      const signal = combineSignals(opts.signal, callSignal)

      const stream = (await getAnthropicClient(opts.apiKey)).messages.stream(
        {
          model: opts.model,
          max_tokens: maxTokens,
          system: systemBlocks,
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
          throw erroSanitizado("Tempo máximo desta resposta esgotado.")
        }

        final = await stream.finalMessage()
      } catch (err) {
        if (abortado()) {
          endReason = "aborted"
          throw err
        }
        if (estourado() || (err instanceof Error && /timeout|AbortError/i.test(err.name + err.message))) {
          endReason = "timeout"
          throw erroSanitizado("Tempo máximo desta resposta esgotado.")
        }
        endReason = "api_error"
        throw erroSanitizado(mensagemApiError(err))
      }

      // Com prompt caching, `input_tokens` conta SÓ o que não veio do cache.
      // Os três contadores ficam SEPARADOS porque cada um tem preço diferente
      // (write 1,25× · read 0,10× do input) — somar tudo em inputTokens
      // inflava o custo do cache read em 10×. A ponderação é feita em
      // services/model-pricing.ts.
      inputTokens += final.usage.input_tokens
      cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0
      cacheReadTokens += final.usage.cache_read_input_tokens ?? 0
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
      throw erroSanitizado("O modelo não retornou mensagem.")
    }
    return final
  }

  async function sintetizarFinal(
    motivo: "max_steps" | "timeout" | "budget",
  ): Promise<void> {
    status(
      motivo === "timeout"
        ? "Fechando a resposta (tempo esgotado)"
        : motivo === "budget"
          ? "Fechando a resposta (orçamento mensal atingido)"
          : "Consolidando o que já coletei",
    )
    try {
      await streamTurn({
        allowTools: false,
        extraUser:
          motivo === "budget" ? PROMPT_FINAL_ORCAMENTO : PROMPT_FINAL_FORCADO,
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
        } else if (
          isMultiAgentToolName(tu.name) &&
          spawnCount >= MULTI_AGENT_MAX_SPAWNS_PER_RUN
        ) {
          exec = {
            ok: false,
            slug: "dexter",
            fn: "spawn_subagent",
            error: `Limite de ${MULTI_AGENT_MAX_SPAWNS_PER_RUN} sub-agentes por resposta.`,
          }
        } else {
          if (isMultiAgentToolName(tu.name)) spawnCount += 1
          exec = await executeTool(
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>,
            {
              userId: opts.userId,
              email: opts.email,
              access: opts.access,
              connectors: opts.connectors,
              signal: opts.signal,
              projectId: opts.projectId,
              multiAgentEnabled: opts.multiAgentEnabled,
              model: opts.model,
              apiKey: opts.apiKey,
              onProgress: progress,
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

        // Orçamento mensal: a cada N tool calls, custo acumulado do run × o que
        // resta do teto do mês. Estourou → para de consultar e vai fechar.
        if (opts.budgetGuard && step % opts.budgetGuard.aCadaSteps === 0) {
          orcamentoEstourado = await opts.budgetGuard.estourou({
            inputTokens,
            outputTokens,
            cacheWriteTokens,
            cacheReadTokens,
          })
          if (orcamentoEstourado) break
        }
      }

      // Tools pedidas mas não executadas (bateu maxSteps ou o orçamento no
      // meio do lote) — a API exige um tool_result para cada tool_use.
      for (const tu of toolUses.slice(toolResults.length)) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: orcamentoEstourado
            ? "Orçamento mensal de uso atingido — esta tool não foi executada."
            : "Limite de consultas desta resposta atingido — esta tool não foi executada.",
          is_error: true,
        })
      }

      messages.push({ role: "user", content: toolResults })

      if (orcamentoEstourado) {
        await sintetizarFinal("budget")
        emitirTexto(AVISO_ORCAMENTO)
        break
      }

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
      budget:
        "Orçamento mensal de uso atingido e não consegui redigir o texto final. Fale com um administrador para ampliar o limite.",
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
    cacheWriteTokens,
    cacheReadTokens,
    endReason,
    steps: step,
  }
}
