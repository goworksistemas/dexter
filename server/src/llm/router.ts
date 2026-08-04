/**
 * LLM Router do AgentCore — camada única de acesso a modelos.
 * Recebe provider + model (resolvidos do catálogo admin) e despacha.
 */
import { streamChatAnthropic } from "../lib/anthropic.js"
import { streamChatOllama } from "../lib/ollama.js"
import {
  streamOpenAiCompatible,
  isOpenAiCompatibleProvider,
} from "../lib/openai-compatible.js"
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

/** Inicia o streaming de chat no provider/modelo escolhidos (sem tools). */
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

  if (isOpenAiCompatibleProvider(opts.provider)) {
    let resolveResult: (r: LlmResult) => void
    const resultPromise = new Promise<LlmResult>((resolve) => {
      resolveResult = resolve
    })
    const provider = opts.provider
    async function* textDeltas(): AsyncGenerator<string> {
      const queue: string[] = []
      let done = false
      let error: unknown
      let notify: (() => void) | null = null
      const wake = (): void => {
        notify?.()
        notify = null
      }

      void streamOpenAiCompatible(
        {
          provider,
          model: opts.model,
          messages: [
            { role: "system", content: opts.systemPrompt },
            ...opts.messages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          ],
          allowTools: false,
          signal: opts.signal,
        },
        (t) => {
          queue.push(t)
          wake()
        },
      )
        .then((r) => {
          resolveResult!({
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
          })
          done = true
          wake()
        })
        .catch((err) => {
          error = err
          done = true
          wake()
        })

      while (!done || queue.length) {
        if (queue.length) {
          yield queue.shift()!
          continue
        }
        if (done) break
        await new Promise<void>((r) => {
          notify = r
        })
      }
      if (error) throw error
    }
    return { textDeltas: textDeltas(), result: () => resultPromise }
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
