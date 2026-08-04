/**
 * Client Anthropic + streaming de chat (usado quando LLM_PROVIDER=anthropic).
 *
 * API confirmada via skill `claude-api` e os .d.ts do SDK (@anthropic-ai/sdk@0.115):
 *   - `client.messages.stream(params, { signal })` → `MessageStream`
 *     (AsyncIterable<MessageStreamEvent>) com `.finalMessage()` (model + usage).
 *   - Deltas de texto: `content_block_delta` com `delta.type === "text_delta"`.
 *
 * O client é criado sob demanda (lazy) — assim, em LLM_PROVIDER=ollama o
 * backend sobe sem exigir ANTHROPIC_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import { responseMaxTokens } from "../llm/models.js"

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY ausente (LLM_PROVIDER=anthropic)")
    }
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  }
  return client
}

export interface AnthropicStreamOptions {
  model?: string
  systemPrompt: string
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  signal?: AbortSignal
}

export interface AnthropicStreamHandle {
  textDeltas: AsyncIterable<string>
  finalMessage: () => Promise<Anthropic.Message>
}

/** Inicia o streaming de uma resposta na Anthropic. */
export function streamChatAnthropic(opts: AnthropicStreamOptions): AnthropicStreamHandle {
  const model = opts.model ?? config.ANTHROPIC_MODEL // fallback legado; preferir catálogo admin
  const stream = getClient().messages.stream(
    {
      model,
      max_tokens: opts.maxTokens ?? responseMaxTokens(model),
      system: opts.systemPrompt,
      messages: opts.messages,
    },
    { signal: opts.signal }
  )

  async function* textDeltas(): AsyncGenerator<string> {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text
      }
    }
  }

  return {
    textDeltas: textDeltas(),
    finalMessage: () => stream.finalMessage(),
  }
}
