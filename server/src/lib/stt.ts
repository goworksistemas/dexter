/**
 * Transcrição de áudio via endpoint OpenAI-compatible
 * (`POST /v1/audio/transcriptions`) — OpenAI Whisper / gpt-4o-transcribe
 * ou server dedicado (Ollama, Faster-Whisper proxy, etc.).
 */
import { config } from "../config.js"
import { getGlobalKey } from "../services/llm-keys.js"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
/** Provider pendurado não pode prender o request (e o Buffer) para sempre. */
const STT_TIMEOUT_MS = 60_000

/** Vocabulário do domínio — sem isso o modelo "corrige" nomes próprios
 * (NetworkGo → network go, Dexter → dester, etc.). */
const STT_PROMPT =
  "Ditado em português brasileiro para o Dexter, assistente interno da GoWork. " +
  "Termos comuns: GoWork, Dexter, NetworkGo, PipeGo, GoDash, MensureGo, CheckGo, " +
  "SupplyGo, QRápido, Notion, Outlook, Supabase, chamado, ordem de serviço, OS."

export class SttError extends Error {
  statusCode: number
  /** Detalhe cru do provider (org id, deployment, billing) — só para log. */
  detail?: string

  constructor(message: string, statusCode = 502, detail?: string) {
    super(message)
    this.name = "SttError"
    this.statusCode = statusCode
    this.detail = detail
  }
}

/** Mensagem fixa por faixa de status — o corpo do provider fica no log. */
function mensagemPorStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Serviço de transcrição recusou a credencial."
  }
  if (status === 413) return "Áudio grande demais para o serviço de transcrição."
  if (status === 429) {
    return "Serviço de transcrição ocupado. Tente novamente em instantes."
  }
  if (status >= 400 && status < 500) {
    return "Áudio rejeitado pelo serviço de transcrição."
  }
  return "Serviço de transcrição indisponível."
}

function sttBaseUrl(): string {
  const raw = config.STT_BASE_URL?.replace(/\/$/, "")
  return raw || "https://api.openai.com"
}

async function sttApiKey(): Promise<string | undefined> {
  if (config.STT_API_KEY?.trim()) return config.STT_API_KEY.trim()
  const base = sttBaseUrl()
  if (base.includes("openai.com")) return getGlobalKey("openai")
  // Server dedicado (ex. ollama.gowork.com.br) — mesma chave de acesso do Ollama.
  return process.env.OLLAMA_API_KEY || (await getGlobalKey("openai"))
}

export async function sttConfigured(): Promise<boolean> {
  return Boolean((await sttApiKey()) || !sttBaseUrl().includes("openai.com"))
}

function extensionForMime(mime: string): string {
  const m = mime.toLowerCase().split(";")[0]?.trim() ?? ""
  if (m.includes("webm")) return "webm"
  if (m.includes("mp4") || m.includes("m4a")) return "mp4"
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3"
  if (m.includes("wav")) return "wav"
  if (m.includes("ogg")) return "ogg"
  if (m.includes("flac")) return "flac"
  return "webm"
}

/** POST no provider com deadline próprio (+ cancelamento do request, se vier).
 * Sem isso um provider pendurado prendia o request e o Buffer de até 25 MB. */
async function postTranscription(
  url: string,
  headers: Record<string, string>,
  form: FormData,
  externo?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(STT_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: form,
      signal: externo ? AbortSignal.any([timeout, externo]) : timeout,
    })
  } catch (err) {
    if (timeout.aborted) {
      throw new SttError(
        "Serviço de transcrição não respondeu no tempo limite.",
        504,
      )
    }
    if (externo?.aborted) {
      throw new SttError("Transcrição cancelada.", 499)
    }
    throw new SttError(
      "Serviço de transcrição indisponível.",
      502,
      err instanceof Error ? err.message : String(err),
    )
  }
}

export async function transcribeAudio(input: {
  /** Áudio cru (vem do multipart, sem passar por base64). */
  bytes: Uint8Array
  mimeType: string
  language?: string
  signal?: AbortSignal
}): Promise<{ text: string; model: string }> {
  if (!input.bytes.length) {
    throw new SttError("Áudio vazio.", 400)
  }
  if (input.bytes.length > MAX_AUDIO_BYTES) {
    throw new SttError("Áudio maior que 25 MB.", 413)
  }

  const apiKey = await sttApiKey()
  const base = sttBaseUrl()
  if (!apiKey && base.includes("openai.com")) {
    throw new SttError(
      "STT não configurado. Cadastre a chave da OpenAI no painel admin ou configure STT_API_KEY / STT_BASE_URL.",
      503,
    )
  }

  const mime = input.mimeType || "audio/webm"
  const ext = extensionForMime(mime)
  const form = new FormData()
  // O buffer entra direto no Blob — sem cópia intermediária de até 25 MB.
  // O cast só resolve o ArrayBufferLike vs ArrayBuffer do TS: o áudio vem do
  // multipart, nunca de SharedArrayBuffer.
  const view = input.bytes as Uint8Array<ArrayBuffer>
  form.append("file", new Blob([view], { type: mime }), `audio.${ext}`)
  form.append("model", config.STT_MODEL)
  form.append("language", input.language?.trim() || "pt")
  form.append("response_format", "json")
  form.append("prompt", STT_PROMPT)
  form.append("temperature", "0")

  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET
  }

  const url = `${base}/v1/audio/transcriptions`
  const res = await postTranscription(url, headers, form, input.signal)

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const detail = `STT HTTP ${res.status}: ${body.slice(0, 240) || res.statusText}`
    // eslint-disable-next-line no-console
    console.error(`[stt] ${detail}`)
    throw new SttError(
      mensagemPorStatus(res.status),
      res.status >= 400 && res.status < 500 ? res.status : 502,
      detail,
    )
  }

  const json = (await res.json()) as { text?: string }
  const text = (json.text ?? "").trim()
  if (!text) {
    throw new SttError("Nenhuma fala reconhecida no áudio.", 422)
  }
  return { text, model: config.STT_MODEL }
}
