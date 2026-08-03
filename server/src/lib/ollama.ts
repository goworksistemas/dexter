/**
 * Client do modelo self-hosted da GoWork (Ollama) — usado quando
 * LLM_PROVIDER=ollama. Fala com `${OLLAMA_BASE_URL}/api/chat` em streaming.
 *
 * Formato do Ollama /api/chat (stream:true): resposta em NDJSON, uma linha
 * JSON por chunk:
 *   {"model":"...","message":{"role":"assistant","content":"..."},"done":false}
 *   ...
 *   {"model":"...","done":true,"prompt_eval_count":N,"eval_count":M}
 * (referência: node HTTP do fluxo de projeção que já usa qwen2.5:7b).
 *
 * Sem chave de API — o endpoint é protegido por rede/host.
 */
import { config } from "../config.js"

export interface OllamaMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface OllamaStreamOptions {
  model?: string
  systemPrompt: string
  /** Histórico (user/assistant) — o system entra separado, no topo. */
  messages: OllamaMessage[]
  signal?: AbortSignal
}

export interface OllamaStreamResult {
  model: string
  inputTokens?: number
  outputTokens?: number
}

export interface OllamaStreamHandle {
  textDeltas: AsyncIterable<string>
  result: () => Promise<OllamaStreamResult>
}

interface OllamaChunk {
  model?: string
  message?: { role?: string; content?: string }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}

/** Inicia o streaming de uma resposta no Ollama self-hosted. */
export function streamChatOllama(opts: OllamaStreamOptions): OllamaStreamHandle {
  const model = opts.model ?? config.OLLAMA_MODEL
  let resolveResult: (r: OllamaStreamResult) => void
  const resultPromise = new Promise<OllamaStreamResult>((resolve) => {
    resolveResult = resolve
  })

  async function* textDeltas(): AsyncGenerator<string> {
    try {
      // Autenticação opcional do endpoint self-hosted (só enviada se existir):
      //  - OLLAMA_API_KEY        → Authorization: Bearer <key>
      //  - CF_ACCESS_CLIENT_ID/SECRET → Cloudflare Access (service token)
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (process.env.OLLAMA_API_KEY) {
        headers["Authorization"] = `Bearer ${process.env.OLLAMA_API_KEY}`
      }
      if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
        headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET
      }

      const res = await fetch(`${config.OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers,
        signal: opts.signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: "system", content: opts.systemPrompt },
            ...opts.messages,
          ],
          options: { num_ctx: config.OLLAMA_NUM_CTX },
        }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`Ollama respondeu ${res.status} ${res.statusText}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let usage: OllamaStreamResult = { model }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // NDJSON: processa cada linha completa; guarda o resto no buffer.
        let nl: number
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue

          let chunk: OllamaChunk
          try {
            chunk = JSON.parse(line) as OllamaChunk
          } catch {
            continue // linha parcial/ruído — ignora
          }

          const piece = chunk.message?.content
          if (piece) yield piece

          if (chunk.done) {
            usage = {
              model: chunk.model ?? model,
              inputTokens: chunk.prompt_eval_count,
              outputTokens: chunk.eval_count,
            }
          }
        }
      }

      resolveResult(usage)
    } catch (err) {
      // Resolve o result (parcial) para NÃO deixar a promise rejeitada sem
      // observador quando o chamador aborta o for-await no erro — isso viraria
      // unhandledRejection e derrubaria o processo. O erro sobe pelo iterador
      // (a rota captura e emite SSE `error`), sem matar o servidor.
      resolveResult({ model })
      throw err
    }
  }

  return {
    textDeltas: textDeltas(),
    result: () => resultPromise,
  }
}
