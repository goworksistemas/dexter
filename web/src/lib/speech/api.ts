import { getAccessToken } from "@/lib/supabase/auth"

export async function transcribeAudioBlob(
  blob: Blob,
  opts?: { language?: string; signal?: AbortSignal },
): Promise<string> {
  const token = await getAccessToken()
  const mimeType = blob.type || "audio/webm"

  // multipart/form-data: o Blob vai cru, sem base64 — que inflava o payload
  // ~33% e travava a thread principal convertendo o áudio acumulado.
  // Os campos vêm ANTES do arquivo: o servidor lê o multipart em stream.
  const form = new FormData()
  form.append("mimeType", mimeType)
  form.append("language", opts?.language ?? "pt")
  form.append("file", blob, "audio")

  const response = await fetch("/api/transcribe", {
    method: "POST",
    // Sem Content-Type manual: o browser gera o boundary do multipart.
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
    signal: opts?.signal,
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string
    } | null
    throw new Error(
      body?.message || `Transcrição falhou (HTTP ${response.status}).`,
    )
  }

  const data = (await response.json()) as { text?: string }
  const text = (data.text ?? "").trim()
  if (!text) throw new Error("Nenhuma fala reconhecida.")
  return text
}
