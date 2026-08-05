/**
 * Loop agêntico OpenAI-compatible (OpenAI + Gemini via endpoint OpenAI).
 * Reutiliza as mesmas tools/executeTool do loop Anthropic.
 */
import { config } from "../config.js"
import {
  buildOcUserContent,
  streamOpenAiCompatible,
  type OcMessage,
  type OcProvider,
  type OcToolCall,
} from "../lib/openai-compatible.js"
import { isImageGenerationModel } from "../llm/capabilities.js"
import { responseMaxTokensFor } from "../llm/models.js"
import type { GuardaOrcamento } from "../services/run-budget.js"
import {
  flattenSystemPrompt,
  type SystemPromptParts,
} from "../llm/system-prompt.js"
import {
  resumirArgs,
  resumirResultado,
  truncar,
  type AgentProgressEvent,
} from "./progress.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import type { SystemAccess } from "./access.js"
import {
  buildTools,
  describeTool,
  executeTool,
} from "./tools.js"
import {
  isMultiAgentToolName,
  MULTI_AGENT_MAX_SPAWNS_PER_RUN,
} from "./multi-agent.js"
import type {
  AgentLoopEndReason,
  AgentLoopResult,
  ToolCallRecord,
} from "./agent-loop.js"

export interface OpenAiAgentLoopOptions {
  provider: OcProvider
  model: string
  /** Blocos aceitos por conveniência: aqui não há cache, então vira string. */
  systemPrompt: string | SystemPromptParts
  /** Histórico user/assistant em texto. */
  messages: Array<{ role: "user" | "assistant"; content: string }>
  /** Anexos da última mensagem do usuário (visão/PDF). */
  attachments?: Array<{
    type: "image" | "document"
    name: string
    mediaType: string
    dataBase64: string
  }>
  access: SystemAccess[]
  connectors?: ConnectorRuntime
  userId: string
  email: string
  /** Projeto do chat — habilita/roteia a tool project__read_file. */
  projectId?: string
  signal?: AbortSignal
  onTextDelta: (text: string) => void
  onToolCall: (rec: ToolCallRecord) => void
  onProgress?: (evt: AgentProgressEvent) => void
  maxRounds?: number
  maxSteps?: number
  /** Chave a usar (BYOK/global). Sem ela, resolve a global (banco → env). */
  apiKey?: string
  multiAgentEnabled?: boolean
  /**
   * Guarda do orçamento mensal (services/run-budget.ts) — mesma semântica do
   * loop Anthropic: checada a cada `aCadaSteps` tool calls.
   */
  budgetGuard?: GuardaOrcamento
}

function truncarToolResult(raw: string, max: number): string {
  if (raw.length <= max) return raw
  return `${raw.slice(0, max)}\n…[truncado ${raw.length - max} chars]`
}

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

export async function runOpenAiAgentLoop(
  opts: OpenAiAgentLoopOptions,
): Promise<AgentLoopResult> {
  if (isImageGenerationModel(opts.provider, opts.model)) {
    throw new Error(
      `Modelo de imagem (${opts.model}) não pode usar o chat OpenAI-compat. Roteie via generateImage*.`,
    )
  }

  const maxRounds = opts.maxRounds ?? config.AGENT_MAX_ROUNDS
  const maxSteps = opts.maxSteps ?? config.AGENT_MAX_STEPS
  const toolResultMax = config.AGENT_TOOL_RESULT_MAX_CHARS
  const tools = await buildTools({
    access: opts.access,
    connectors: opts.connectors,
    userId: opts.userId,
    projectId: opts.projectId,
    multiAgentEnabled: opts.multiAgentEnabled,
  })
  const maxTokens = await responseMaxTokensFor(opts.model)

  const messages: OcMessage[] = [
    { role: "system", content: flattenSystemPrompt(opts.systemPrompt) },
  ]
  opts.messages.forEach((m, i) => {
    const isLast = i === opts.messages.length - 1
    if (
      isLast &&
      m.role === "user" &&
      opts.attachments &&
      opts.attachments.length > 0
    ) {
      messages.push({
        role: "user",
        content: buildOcUserContent(m.content, opts.attachments),
      })
      return
    }
    messages.push({
      role: m.role as "user" | "assistant",
      content: m.content,
    })
  })

  let inputTokens = 0
  let outputTokens = 0
  let lastModel = opts.model
  let step = 0
  let endReason: AgentLoopEndReason = "ok"
  let textoEmitido = ""
  const toolFailCounts = new Map<string, number>()
  let spawnCount = 0
  /** Orçamento mensal estourou no meio deste run (item 4.4). */
  let orcamentoEstourado = false

  const progress = (evt: AgentProgressEvent): void => {
    opts.onProgress?.(evt)
  }
  const status = (text: string): void => {
    progress({ type: "status", text })
  }
  const emitirTexto = (t: string): void => {
    textoEmitido += t
    opts.onTextDelta(t)
  }

  const abortado = (): boolean => Boolean(opts.signal?.aborted)

  async function turn(allowTools: boolean): Promise<{
    content: string
    toolCalls: OcToolCall[]
  }> {
    status(allowTools ? "Pensando" : "Gerando resposta")
    const result = await streamOpenAiCompatible(
      {
        provider: opts.provider,
        model: opts.model,
        messages,
        tools,
        allowTools: allowTools && tools.length > 0,
        maxTokens,
        signal: opts.signal,
        apiKey: opts.apiKey,
      },
      (delta) => {
        status("Gerando resposta")
        emitirTexto(delta)
      },
    )
    lastModel = result.model
    if (result.inputTokens) inputTokens += result.inputTokens
    if (result.outputTokens) outputTokens += result.outputTokens
    return { content: result.content, toolCalls: result.toolCalls }
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (abortado()) {
        endReason = "aborted"
        break
      }

      const allowTools = step < maxSteps && tools.length > 0
      const { content, toolCalls } = await turn(allowTools)

      if (toolCalls.length === 0) {
        endReason = textoEmitido.trim() || content.trim() ? "ok" : "empty"
        break
      }

      // OpenAI exige uma mensagem `tool` para CADA tool_call_id do assistant.
      const respondTool = (tc: OcToolCall, content: string): void => {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content,
        })
      }
      const stubRestantes = (pendentes: OcToolCall[]): void => {
        for (const tc of pendentes) {
          respondTool(
            tc,
            "Limite de consultas desta resposta atingido — esta tool não foi executada.",
          )
        }
      }

      if (!allowTools) {
        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls,
        })
        stubRestantes(toolCalls)
        messages.push({ role: "user", content: PROMPT_FINAL_FORCADO })
        await turn(false)
        endReason = "max_steps"
        break
      }

      messages.push({
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls,
      })

      let respondidas = 0
      for (const tc of toolCalls) {
        if (step >= maxSteps) break
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<
            string,
            unknown
          >
        } catch {
          args = {}
        }

        const started = Date.now()
        const descricao = describeTool(tc.function.name)
        const argsSummary = resumirArgs(args)
        step += 1
        progress({
          type: "tool_call_start",
          id: tc.id,
          step,
          tool: tc.function.name,
          ...(descricao.slug ? { system: descricao.slug } : {}),
          ...(descricao.systemLabel
            ? { system_label: descricao.systemLabel }
            : {}),
          ...(descricao.toolLabel ? { tool_label: descricao.toolLabel } : {}),
          label: descricao.label,
          ...(argsSummary ? { args_summary: argsSummary } : {}),
        })

        const fp = `${tc.function.name}::${tc.function.arguments || "{}"}`
        const falhasPrevias = toolFailCounts.get(fp) ?? 0
        let exec: Awaited<ReturnType<typeof executeTool>>
        if (falhasPrevias >= 2) {
          exec = {
            ok: false,
            slug: descricao.slug,
            fn: descricao.fn,
            error:
              `Anti-loop: ${tc.function.name} com os mesmos args já falhou/vazio ${falhasPrevias}x. ` +
              "Pare e reporte o erro técnico; não refetch o mesmo id.",
          }
        } else if (
          isMultiAgentToolName(tc.function.name) &&
          spawnCount >= MULTI_AGENT_MAX_SPAWNS_PER_RUN
        ) {
          exec = {
            ok: false,
            slug: "dexter",
            fn: "spawn_subagent",
            error: `Limite de ${MULTI_AGENT_MAX_SPAWNS_PER_RUN} sub-agentes por resposta.`,
          }
        } else {
          if (isMultiAgentToolName(tc.function.name)) spawnCount += 1
          exec = await executeTool(tc.function.name, args, {
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
          })
          const vazio =
            exec.ok &&
            (exec.result === null ||
              exec.result === undefined ||
              (typeof exec.result === "string" && exec.result.trim().length < 8) ||
              (typeof exec.result === "object" &&
                !Array.isArray(exec.result) &&
                Object.keys(exec.result as object).length === 0))
          if (!exec.ok || vazio) {
            toolFailCounts.set(fp, falhasPrevias + 1)
            if (vazio) {
              exec = {
                ok: false,
                slug: exec.slug,
                fn: exec.fn,
                error:
                  "Resposta vazia da tool. Não repita a mesma chamada; confira id Notion (database vs collection://).",
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
          id: tc.id,
          step,
          tool: tc.function.name,
          status: exec.ok ? "ok" : "error",
          duration_ms: durationMs,
          ...(resumo.rows !== undefined ? { rows: resumo.rows } : {}),
          summary: resumo.summary,
        })

        opts.onToolCall({
          toolName: tc.function.name,
          slug: exec.slug,
          fn: exec.fn,
          input: args,
          ok: exec.ok,
          output: exec.ok ? exec.result : undefined,
          error: exec.ok ? undefined : exec.error,
          durationMs,
        })

        const raw = exec.ok
          ? JSON.stringify(exec.result ?? null)
          : `Erro ao consultar: ${exec.error}`
        respondTool(tc, truncarToolResult(raw, toolResultMax))
        respondidas += 1

        // Orçamento mensal: custo acumulado do run × o que resta do teto do mês.
        if (opts.budgetGuard && step % opts.budgetGuard.aCadaSteps === 0) {
          orcamentoEstourado = await opts.budgetGuard.estourou({
            inputTokens,
            outputTokens,
          })
          if (orcamentoEstourado) break
        }
      }

      // Tools pedidas no mesmo turno mas não executadas (maxSteps ou orçamento).
      stubRestantes(toolCalls.slice(respondidas))

      if (orcamentoEstourado) {
        messages.push({ role: "user", content: PROMPT_FINAL_ORCAMENTO })
        await turn(false)
        endReason = "budget"
        emitirTexto(AVISO_ORCAMENTO)
        break
      }

      if (step >= maxSteps || round >= maxRounds - 1) {
        messages.push({ role: "user", content: PROMPT_FINAL_FORCADO })
        await turn(false)
        endReason = "max_steps"
        break
      }
    }
  } catch (err) {
    if (abortado()) {
      endReason = "aborted"
      throw err
    }
    endReason = "api_error"
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(truncar(msg, 400))
  }

  return {
    model: lastModel,
    inputTokens,
    outputTokens,
    endReason,
    steps: step,
  }
}
