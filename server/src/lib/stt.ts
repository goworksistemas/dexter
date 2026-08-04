/**
 * Transcrição de áudio via endpoint OpenAI-compatible
 * (`POST /v1/audio/transcriptions`) — OpenAI Whisper / gpt-4o-transcribe
 * ou server dedicado (Ollama, Faster-Whisper proxy, etc.).
 */
import { config } from "../config.js"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export class SttError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = "SttError"
    this.statusCode = statusCode
  }
}

function sttBaseUrl(): string {
  const raw = config.STT_BASE_URL?.replace(/\/$/, "")
  return raw || "https://api.openai.com"
}

function sttApiKey(): string | undefined {
  if (config.STT_API_KEY?.trim()) return config.STT_API_KEY.trim()
  const base = sttBaseUrl()
  if (base.includes("openai.com")) return config.OPENAI_API_KEY
  // Server dedicado (ex. ollama.gowork.com.br) — mesma chave de acesso do Ollama.
  return process.env.OLLAMA_API_KEY || config.OPENAI_API_KEY
}

export function sttConfigured(): boolean {
  return Boolean(sttApiKey() || !sttBaseUrl().includes("openai.com"))
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

export async function transcribeAudio(input: {
  bytes: Buffer
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

  const apiKey = sttApiKey()
  const base = sttBaseUrl()
  if (!apiKey && base.includes("openai.com")) {
    throw new SttError(
      "STT não configurado. Cadastre OPENAI_API_KEY ou STT_API_KEY / STT_BASE_URL no Infisical.",
      503,
    )
  }

  const mime = input.mimeType || "audio/webm"
  const ext = extensionForMime(mime)
  const form = new FormData()
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: mime }),
    `audio.${ext}`,
  )
  form.append("model", config.STT_MODEL)
  form.append("language", input.language?.trim() || "pt")
  form.append("response_format", "json")

  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET
  }

  const url = `${base}/v1/audio/transcriptions`
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: form,
    signal: input.signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new SttError(
      `STT HTTP ${res.status}: ${body.slice(0, 240) || res.statusText}`,
      res.status >= 400 && res.status < 500 ? res.status : 502,
    )
  }

  const json = (await res.json()) as { text?: string }
  const text = (json.text ?? "").trim()
  if (!text) {
    throw new SttError("Nenhuma fala reconhecida no áudio.", 422)
  }
  return { text, model: config.STT_MODEL }
}
