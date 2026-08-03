/**
 * LLM Router do AgentCore — camada única de acesso a modelos.
 * Recebe provider + model (resolvidos do registry a partir da escolha da UI)
 * e despacha para o client certo, com uma interface uniforme (textDeltas +
 * result). É aqui que evoluem fallback / cache semântico (ver AGENTCORE_SPEC).
 */
import { streamChatAnthropic } from "../lib/anthropic.js"
import { streamChatOllama } from "../lib/ollama.js"
import type { Provider } from "./models.js"

export interface LlmMessage {
  role: "user" | "assistant"
  content: string
}

export interface LlmResult {
  model: string
  inputTokens?: number
  outputTokens?: number
}

export interface LlmStreamHandle {
  textDeltas: AsyncIterable<string>
  result: () => Promise<LlmResult>
}

export interface LlmStreamOptions {
  provider: Provider
  model: string
  systemPrompt: string
  messages: LlmMessage[]
  signal?: AbortSignal
}

/** Inicia o streaming de chat no provider/modelo escolhidos. */
export function streamChat(opts: LlmStreamOptions): LlmStreamHandle {
  if (opts.provider === "ollama") {
    const h = streamChatOllama({
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      signal: opts.signal,
    })
    return { textDeltas: h.textDeltas, result: h.result }
  }

  const h = streamChatAnthropic({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    messages: opts.messages,
    signal: opts.signal,
  })
  return {
    textDeltas: h.textDeltas,
    result: async () => {
      const m = await h.finalMessage()
      return {
        model: m.model,
        inputTokens: m.usage.input_tokens,
        outputTokens: m.usage.output_tokens,
      }
    },
  }
}
