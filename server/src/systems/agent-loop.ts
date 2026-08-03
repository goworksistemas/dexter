/**
 * Loop agêntico de tool-use do Dexter (Anthropic).
 *
 * O Claude recebe as tools (RPCs read-only dos sistemas que o usuário acessa).
 * Quando ele decide chamar uma, o backend executa (injetando o email do
 * usuário autenticado), devolve o resultado como `tool_result`, e o loop
 * continua até o Claude produzir a resposta final em texto. Texto é streamado
 * a cada passo. Cada tool call é devolvida para auditoria (agent_tool_calls).
 */
import Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import { buildTools, executeTool, type AnthropicTool } from "./tools.js"
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

export interface AgentLoopOptions {
  model: string
  systemPrompt: string
  messages: Anthropic.MessageParam[]
  access: SystemAccess[]
  email: string
  signal?: AbortSignal
  /** chamado a cada delta de texto (para o SSE). */
  onTextDelta: (text: string) => void
  /** chamado após cada tool call (para auditoria). */
  onToolCall: (rec: ToolCallRecord) => void
  /** limite de rodadas de tool-use (segurança contra loop infinito). */
  maxRounds?: number
}

export interface AgentLoopResult {
  model: string
  inputTokens: number
  outputTokens: number
}

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  return client
}

/** Roda o loop de tool-use com streaming. */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const tools: AnthropicTool[] = buildTools(opts.access)
  const messages: Anthropic.MessageParam[] = [...opts.messages]
  const maxRounds = opts.maxRounds ?? 6
  let inputTokens = 0
  let outputTokens = 0
  let lastModel = opts.model

  for (let round = 0; round < maxRounds; round++) {
    const stream = getClient().messages.stream(
      {
        model: opts.model,
        max_tokens: 4096,
        system: opts.systemPrompt,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      },
      { signal: opts.signal }
    )

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        opts.onTextDelta(event.delta.text)
      }
    }

    const final = await stream.finalMessage()
    inputTokens += final.usage.input_tokens
    outputTokens += final.usage.output_tokens
    lastModel = final.model

    const toolUses = final.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
    )

    // Sem tool_use → resposta final, encerra.
    if (toolUses.length === 0) break

    // Registra a resposta do assistente (com os tool_use) no histórico.
    messages.push({ role: "assistant", content: final.content })

    // Executa cada tool e monta os tool_result.
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const started = Date.now()
      const exec = await executeTool(
        tu.name,
        (tu.input ?? {}) as Record<string, unknown>,
        { email: opts.email, access: opts.access }
      )
      opts.onToolCall({
        toolName: tu.name,
        slug: exec.slug,
        fn: exec.fn,
        input: tu.input,
        ok: exec.ok,
        output: exec.ok ? exec.result : undefined,
        error: exec.ok ? undefined : exec.error,
        durationMs: Date.now() - started,
      })
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: exec.ok
          ? JSON.stringify(exec.result ?? null)
          : `Erro ao consultar: ${exec.error}`,
        is_error: !exec.ok,
      })
    }

    messages.push({ role: "user", content: toolResults })
  }

  return { model: lastModel, inputTokens, outputTokens }
}
