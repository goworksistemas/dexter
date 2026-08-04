import { getAccessToken } from "@/lib/supabase/auth"

export async function transcribeAudioBlob(
  blob: Blob,
  opts?: { language?: string; signal?: AbortSignal },
): Promise<string> {
  const token = await getAccessToken()
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const audioBase64 = btoa(binary)

  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || "audio/webm",
      language: opts?.language ?? "pt",
    }),
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
