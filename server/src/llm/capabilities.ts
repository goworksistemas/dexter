/**
 * Capacidades e roteamento.
 * Catálogo: preferir campos da API (models.ts). Aqui ficam helpers de
 * roteamento (Images API vs chat) e gate quando a API não informa caps.
 */
import type { Provider } from "./models.js"

export interface ModelCapabilities {
  /** Analisa imagens enviadas pelo usuário. */
  vision: boolean
  /** Lê arquivos (PDF e similares) anexados. */
  files: boolean
  /** Gera imagens a partir de texto. */
  imageGeneration: boolean
}

export const CAPABILITY_TRAITS = {
  vision: "Visão",
  files: "Arquivos",
  imageGeneration: "Gerar imagem",
} as const

export function emptyCapabilities(): ModelCapabilities {
  return { vision: false, files: false, imageGeneration: false }
}

/** OpenAI: chat com visão vs modelos só de imagem. */
export function isOpenAiImageModel(id: string): boolean {
  const lower = id.toLowerCase()
  return (
    lower.startsWith("dall-e") ||
    lower.startsWith("gpt-image") ||
    lower.includes("gpt-image")
  )
}

export function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase()
  if (
    /embedding|whisper|tts|davinci|babbage|ada|moderation|realtime|transcribe|audio|search/.test(
      lower,
    )
  ) {
    return false
  }
  if (isOpenAiImageModel(id)) return false
  return /^(gpt-|o[1-9]|chatgpt-|ft:)/.test(lower)
}

export function isOpenAiCatalogModel(id: string): boolean {
  return isOpenAiChatModel(id) || isOpenAiImageModel(id)
}

/** Gemini Nano Banana / gemini-*-image / Imagen. */
export function isGeminiImageModel(id: string): boolean {
  const lower = id.toLowerCase().replace(/^models\//, "")
  return (
    lower.includes("imagen") ||
    lower.includes("image-generation") ||
    lower.includes("imagegeneration") ||
    /gemini-[\w.-]*image/.test(lower)
  )
}

/** Modelo deve usar o pipeline de geração de imagem (não o chat com tools). */
export function isImageGenerationModel(
  provider: Provider,
  apiModel: string,
): boolean {
  if (provider === "openai") return isOpenAiImageModel(apiModel)
  if (provider === "gemini") return isGeminiImageModel(apiModel)
  return false
}

/**
 * Gate de anexo quando o catálogo não tem caps da API (ex.: OpenAI chat).
 * Só libera se for chat OpenAI (não modelo de imagem).
 */
export function modelAllowsVision(
  provider: Provider,
  apiModel: string,
  caps: ModelCapabilities,
): boolean {
  if (caps.vision) return true
  if (provider === "openai" && !isOpenAiImageModel(apiModel)) return true
  return false
}

export function modelAllowsFiles(
  provider: Provider,
  apiModel: string,
  caps: ModelCapabilities,
): boolean {
  if (caps.files) return true
  if (provider === "openai" && !isOpenAiImageModel(apiModel)) return true
  return false
}

export function capabilityTraits(caps: ModelCapabilities): string[] {
  const out: string[] = []
  if (caps.vision) out.push(CAPABILITY_TRAITS.vision)
  if (caps.files) out.push(CAPABILITY_TRAITS.files)
  if (caps.imageGeneration) out.push(CAPABILITY_TRAITS.imageGeneration)
  return out
}
