/**
 * Geração de imagens — OpenAI Images API e Gemini (Nano Banana / *-image).
 * Aceita imagens de referência (edição / image-to-image) quando o modelo suporta.
 * Chave: BYOK do usuário (opts.apiKey) ou global do banco → env (llm-keys).
 */
import { getGlobalKey } from "../services/llm-keys.js"

export interface GenerateImageResult {
  model: string
  /** data URL ou URL remota */
  imageUrl: string
  revisedPrompt?: string
  text?: string
}

export interface ImageReference {
  mediaType: string
  dataBase64: string
  name?: string
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes("png")) return "png"
  if (m.includes("webp")) return "webp"
  if (m.includes("gif")) return "gif"
  return "jpg"
}

export async function generateImageOpenAI(opts: {
  model: string
  prompt: string
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto"
  references?: ImageReference[]
  signal?: AbortSignal
  apiKey?: string
}): Promise<GenerateImageResult> {
  const apiKey = opts.apiKey ?? (await getGlobalKey("openai"))
  if (!apiKey) throw new Error("Chave da OpenAI ausente. Cadastre no painel admin.")

  const model = opts.model
  const refs = (opts.references ?? []).filter((r) =>
    /^image\//i.test(r.mediaType),
  )
  if (refs.length > 0) {
    return editImageOpenAI({
      model,
      prompt: opts.prompt,
      size: opts.size,
      references: refs,
      signal: opts.signal,
      apiKey,
    })
  }

  const isGptImage = /gpt-image/i.test(model)
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n: 1,
  }

  if (isGptImage) {
    body.size = opts.size ?? "auto"
    body.output_format = "png"
  } else {
    body.size = opts.size === "auto" || !opts.size ? "1024x1024" : opts.size
    body.response_format = "b64_json"
  }

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: opts.signal,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    throw friendlyImageError("OpenAI", res.status, errText)
  }

  return parseOpenAiImagesResponse(
    model,
    (await res.json()) as Parameters<typeof parseOpenAiImagesResponse>[1],
  )
}

async function editImageOpenAI(opts: {
  model: string
  prompt: string
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto"
  references: ImageReference[]
  signal?: AbortSignal
  apiKey: string
}): Promise<GenerateImageResult> {
  const model = opts.model
  if (!/gpt-image|dall-e-2/i.test(model)) {
    throw new Error(
      `O modelo ${model} não aceita imagem de referência. Use gpt-image* ou Gemini Nano Banana.`,
    )
  }

  const form = new FormData()
  form.append("model", model)
  form.append("prompt", opts.prompt)
  form.append("n", "1")
  if (/gpt-image/i.test(model)) {
    form.append("size", opts.size ?? "auto")
  } else {
    form.append("size", "1024x1024")
    form.append("response_format", "b64_json")
  }

  for (let i = 0; i < opts.references.length; i++) {
    const ref = opts.references[i]!
    const bytes = Buffer.from(ref.dataBase64, "base64")
    const ext = extFromMime(ref.mediaType)
    const blob = new Blob([new Uint8Array(bytes)], {
      type: ref.mediaType || `image/${ext}`,
    })
    const filename = ref.name?.replace(/[^\w.-]+/g, "_") || `ref-${i}.${ext}`
    // gpt-image aceita image[] ; dall-e-2 um único image
    if (/gpt-image/i.test(model)) {
      form.append("image[]", blob, filename)
    } else {
      form.append("image", blob, filename)
      break
    }
  }

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
    },
    signal: opts.signal,
    body: form,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    throw friendlyImageError("OpenAI", res.status, errText)
  }

  return parseOpenAiImagesResponse(
    model,
    (await res.json()) as Parameters<typeof parseOpenAiImagesResponse>[1],
  )
}

function parseOpenAiImagesResponse(
  model: string,
  json: {
    data?: Array<{
      b64_json?: string
      url?: string
      revised_prompt?: string
    }>
  },
): GenerateImageResult {
  const item = json.data?.[0]
  if (!item) throw new Error("Images API não retornou imagem.")

  if (item.b64_json) {
    return {
      model,
      imageUrl: `data:image/png;base64,${item.b64_json}`,
      revisedPrompt: item.revised_prompt,
    }
  }
  if (item.url) {
    return {
      model,
      imageUrl: item.url,
      revisedPrompt: item.revised_prompt,
    }
  }
  throw new Error("Images API sem b64_json nem url.")
}

/** Gemini image models (Nano Banana / gemini-*-image / imagen). */
export async function generateImageGemini(opts: {
  model: string
  prompt: string
  references?: ImageReference[]
  signal?: AbortSignal
  apiKey?: string
}): Promise<GenerateImageResult> {
  const apiKey = opts.apiKey ?? (await getGlobalKey("gemini"))
  if (!apiKey) throw new Error("Chave do Gemini ausente. Cadastre no painel admin.")

  const model = opts.model.replace(/^models\//, "")
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

  const parts: Array<Record<string, unknown>> = []
  for (const ref of opts.references ?? []) {
    if (!/^image\//i.test(ref.mediaType) || !ref.dataBase64) continue
    parts.push({
      inline_data: {
        mime_type: ref.mediaType,
        data: ref.dataBase64,
      },
    })
  }
  parts.push({ text: opts.prompt })

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    throw friendlyImageError("Gemini", res.status, errText)
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          inlineData?: { mimeType?: string; data?: string }
          inline_data?: { mime_type?: string; data?: string }
        }>
      }
    }>
  }

  const outParts = json.candidates?.[0]?.content?.parts ?? []
  let text = ""
  let imageUrl = ""
  for (const part of outParts) {
    if (part.text) text += (text ? "\n\n" : "") + part.text
    const inline = part.inlineData ?? part.inline_data
    if (inline?.data) {
      const mime =
        ("mimeType" in inline && inline.mimeType) ||
        ("mime_type" in inline && inline.mime_type) ||
        "image/png"
      imageUrl = `data:${mime};base64,${inline.data}`
    }
  }

  if (!imageUrl) {
    throw new Error(
      text
        ? `Gemini não devolveu imagem. Resposta: ${text.slice(0, 200)}`
        : "Gemini não devolveu imagem.",
    )
  }

  return { model, imageUrl, text: text || undefined }
}

function friendlyImageError(
  provider: string,
  status: number,
  body: string,
): Error {
  if (status === 429) {
    return new Error(
      `${provider}: cota/rate limit esgotada (HTTP 429). Confira billing e limites em ${
        provider === "Gemini"
          ? "https://ai.google.dev/gemini-api/docs/rate-limits"
          : "https://platform.openai.com/account/billing"
      }.`,
    )
  }
  if (status === 401 || status === 403) {
    return new Error(
      `${provider}: chave inválida ou sem permissão (HTTP ${status}).`,
    )
  }
  if (/Unhandled generated data mime type/i.test(body)) {
    return new Error(
      `${provider}: endpoint de chat não gera imagem deste modelo. Reinicie o AgentCore para usar o pipeline nativo.`,
    )
  }
  return new Error(
    `${provider} Images HTTP ${status}: ${body.slice(0, 280)}`,
  )
}
