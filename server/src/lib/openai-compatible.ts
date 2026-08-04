/**
 * Client OpenAI-compatible (Chat Completions streaming).
 * Usado por OpenAI oficial e Gemini (endpoint OpenAI-compat do Google).
 */
import { config } from "../config.js"
import type { Provider } from "../llm/models.js"
import { responseMaxTokens } from "../llm/models.js"
import type { AnthropicTool } from "../systems/tools.js"

export type OcContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | {
      type: "file"
      file: { filename: string; file_data: string }
    }

export interface OcMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null | OcContentPart[]
  tool_calls?: OcToolCall[]
  tool_call_id?: string
  name?: string
}

/** Monta content multimodal OpenAI-compatible a partir de anexos Dexter. */
export function buildOcUserContent(
  text: string,
  attachments?: Array<{
    type: "image" | "document"
    name: string
    mediaType: string
    dataBase64: string
  }>,
): string | OcContentPart[] {
  if (!attachments?.length) return text
  const parts: OcContentPart[] = []
  for (const a of attachments) {
    if (a.type === "image") {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${a.mediaType};base64,${a.dataBase64}`,
        },
      })
    } else {
      parts.push({
        type: "file",
        file: {
          filename: a.name || "documento.pdf",
          file_data: `data:${a.mediaType || "application/pdf"};base64,${a.dataBase64}`,
        },
      })
    }
  }
  if (text.trim()) parts.push({ type: "text", text })
  else parts.push({ type: "text", text: "Analise o(s) anexo(s)." })
  return parts
}

export interface OcToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OcStreamOptions {
  provider: "openai" | "gemini"
  model: string
  messages: OcMessage[]
  tools?: AnthropicTool[]
  allowTools?: boolean
  maxTokens?: number
  signal?: AbortSignal
}

export interface OcStreamResult {
  model: string
  content: string
  toolCalls: OcToolCall[]
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
}

function endpoint(provider: "openai" | "gemini"): {
  url: string
  headers: Record<string, string>
} {
  if (provider === "openai") {
    if (!config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente")
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  }
  if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY ausente")
  return {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    headers: {
      Authorization: `Bearer ${config.GEMINI_API_KEY}`,
      "Content-Type": "application/json",
    },
  }
}

function toOpenAiTools(tools: AnthropicTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

/** GPT-5 / o-series rejeitam `max_tokens`; exigem `max_completion_tokens`. */
function usesMaxCompletionTokens(
  provider: "openai" | "gemini",
  model: string,
): boolean {
  if (provider !== "openai") return false
  const m = model.toLowerCase()
  return /^o[1-9]/.test(m) || m.includes("gpt-5") || m.startsWith("chatgpt-")
}

function applyTokenLimit(
  body: Record<string, unknown>,
  provider: "openai" | "gemini",
  model: string,
  maxTokens: number,
): void {
  if (usesMaxCompletionTokens(provider, model)) {
    body.max_completion_tokens = maxTokens
  } else {
    body.max_tokens = maxTokens
  }
}

/**
 * GPT-5.6 (+ família recente) no Chat Completions: tools só com
 * `reasoning_effort: "none"` (default do modelo é medium e a API rejeita).
 */
function applyReasoningForTools(
  body: Record<string, unknown>,
  provider: "openai" | "gemini",
  model: string,
  hasTools: boolean,
): void {
  if (provider !== "openai" || !hasTools) return
  const m = model.toLowerCase()
  if (/gpt-5\.(4|5|6)/.test(m)) {
    body.reasoning_effort = "none"
  }
}

/**
 * Uma chamada streaming. Emite texto via onTextDelta; devolve tool_calls
 * agregados ao final.
 */
export async function streamOpenAiCompatible(
  opts: OcStreamOptions,
  onTextDelta: (text: string) => void,
): Promise<OcStreamResult> {
  const { url, headers } = endpoint(opts.provider)
  const maxTokens = opts.maxTokens ?? responseMaxTokens(opts.model)
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: opts.messages,
  }
  applyTokenLimit(body, opts.provider, opts.model, maxTokens)
  const hasTools = Boolean(opts.allowTools && opts.tools?.length)
  if (hasTools) {
    body.tools = toOpenAiTools(opts.tools!)
  }
  applyReasoningForTools(body, opts.provider, opts.model, hasTools)

  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "")
    throw new Error(formatProviderHttpError(opts.provider, opts.model, res.status, errText))
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let finishReason: string | undefined
  let model = opts.model
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  const toolMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]") continue
      let json: {
        model?: string
        choices?: Array<{
          finish_reason?: string | null
          delta?: {
            content?: string | null
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      try {
        json = JSON.parse(payload) as typeof json
      } catch {
        continue
      }
      if (json.model) model = json.model
      if (json.usage) {
        inputTokens = json.usage.prompt_tokens
        outputTokens = json.usage.completion_tokens
      }
      const choice = json.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta) continue
      if (delta.content) {
        content += delta.content
        onTextDelta(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0
        const cur = toolMap.get(idx) ?? { id: "", name: "", arguments: "" }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        toolMap.set(idx, cur)
      }
    }
  }

  const toolCalls: OcToolCall[] = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id || `call_${t.name}`,
      type: "function" as const,
      function: { name: t.name, arguments: t.arguments || "{}" },
    }))
    .filter((t) => t.function.name)

  return {
    model,
    content,
    toolCalls,
    finishReason,
    inputTokens,
    outputTokens,
  }
}

export function isOpenAiCompatibleProvider(
  p: Provider,
): p is "openai" | "gemini" {
  return p === "openai" || p === "gemini"
}

function formatProviderHttpError(
  provider: string,
  model: string,
  status: number,
  errText: string,
): string {
  const lower = errText.toLowerCase()
  if (
    status === 404 &&
    (lower.includes("no longer available") ||
      lower.includes("not found") ||
      lower.includes("is not found"))
  ) {
    return (
      `Modelo "${model}" não está mais disponível na ${provider}. ` +
      `Escolha outro modelo no seletor (ex.: Gemini 2.5/3.x Flash).`
    )
  }
  return `${provider} HTTP ${status}: ${errText.slice(0, 240)}`
}
