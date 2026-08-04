/**
 * Client Anthropic + streaming de chat (usado quando LLM_PROVIDER=anthropic).
 *
 * API confirmada via skill `claude-api` e os .d.ts do SDK (@anthropic-ai/sdk@0.115):
 *   - `client.messages.stream(params, { signal })` → `MessageStream`
 *     (AsyncIterable<MessageStreamEvent>) com `.finalMessage()` (model + usage).
 *   - Deltas de texto: `content_block_delta` com `delta.type === "text_delta"`.
 *
 * O client é criado sob demanda por chave — a chave pode ser a pessoal do
 * usuário (BYOK), a global do admin (banco) ou o env legado (services/llm-keys).
 */
import Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import { responseMaxTokens } from "../llm/models.js"
import { getGlobalKey } from "../services/llm-keys.js"

const clients = new Map<string, Anthropic>()

/** Client para a chave dada (BYOK) ou para a chave global (banco → env). */
export async function getAnthropicClient(apiKey?: string): Promise<Anthropic> {
  const key = apiKey ?? (await getGlobalKey("anthropic"))
  if (!key) {
    throw new Error(
      "Chave da Anthropic ausente. Cadastre no painel admin (aba Modelos) ou nas suas Configurações.",
    )
  }
  let client = clients.get(key)
  if (!client) {
    client = new Anthropic({ apiKey: key })
    clients.set(key, client)
    if (clients.size > 200) {
      const oldest = clients.keys().next().value
      if (oldest) clients.delete(oldest)
    }
  }
  return client
}

export interface AnthropicStreamOptions {
  model?: string
  systemPrompt: string
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  signal?: AbortSignal
  /** Chave a usar (BYOK/global). Sem ela, resolve a global. */
  apiKey?: string
}

export interface AnthropicStreamHandle {
  textDeltas: AsyncIterable<string>
  finalMessage: () => Promise<Anthropic.Message>
}

/** Inicia o streaming de uma resposta na Anthropic. */
export function streamChatAnthropic(opts: AnthropicStreamOptions): AnthropicStreamHandle {
  const model = opts.model ?? config.ANTHROPIC_MODEL // fallback legado; preferir catálogo admin

  const streamPromise = getAnthropicClient(opts.apiKey).then((client) =>
    client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? responseMaxTokens(model),
        system: opts.systemPrompt,
        messages: opts.messages,
      },
      { signal: opts.signal },
    ),
  )

  async function* textDeltas(): AsyncGenerator<string> {
    const stream = await streamPromise
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text
      }
    }
  }

  return {
    textDeltas: textDeltas(),
    finalMessage: async () => (await streamPromise).finalMessage(),
  }
}
