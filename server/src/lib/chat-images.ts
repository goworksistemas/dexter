/**
 * Persiste imagem gerada no Storage e devolve URL pública (leve no histórico).
 * Também migra data URLs antigas embutidas em `agent_messages.content`.
 */
import { randomUUID } from "node:crypto"

import { supabase } from "./supabase.js"

const BUCKET = "chat-images"

const DATA_IMAGE_IN_MD =
  /!\[([^\]]*)\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)\)/gi

function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim())
  if (!m?.[1] || !m[2]) return null
  try {
    const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64")
    if (bytes.length === 0) return null
    return { mime: m[1].toLowerCase(), bytes }
  } catch {
    return null
  }
}

function extFromMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  return "png"
}

/**
 * Se `imageUrl` for data URL, sobe ao bucket e retorna a URL pública.
 * Se já for http(s) ou o upload falhar, devolve o valor original.
 */
export async function persistChatImageUrl(opts: {
  userId: string
  chatId: string
  imageUrl: string
}): Promise<string> {
  if (!opts.imageUrl.startsWith("data:image/")) return opts.imageUrl

  const parsed = parseDataUrl(opts.imageUrl)
  if (!parsed) return opts.imageUrl

  const id = randomUUID()
  const ext = extFromMime(parsed.mime)
  const path = `${opts.userId}/${opts.chatId}/${id}.${ext}`

  const { error } = await supabase.storage.from(BUCKET).upload(path, parsed.bytes, {
    contentType: parsed.mime,
    upsert: false,
  })
  if (error) {
    console.error(`persistChatImageUrl: ${error.message}`)
    return opts.imageUrl
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl || opts.imageUrl
}

export function contentHasDataImage(content: string): boolean {
  return content.includes("data:image/")
}

/**
 * Troca `![...](data:image...)` por URL pública e persiste o content no DB.
 * Idempotente — mensagens já migradas passam direto.
 */
export async function migrateMessageDataImages(opts: {
  userId: string
  chatId: string
  messageId: string
  content: string
}): Promise<string> {
  if (!contentHasDataImage(opts.content)) return opts.content

  const matches = [...opts.content.matchAll(new RegExp(DATA_IMAGE_IN_MD.source, "gi"))]
  if (matches.length === 0) return opts.content

  let next = opts.content
  for (const match of matches) {
    const full = match[0]!
    const alt = match[1] ?? "imagem"
    const dataUrl = (match[2] ?? "").replace(/\s+/g, "")
    if (!dataUrl.startsWith("data:image/")) continue
    const url = await persistChatImageUrl({
      userId: opts.userId,
      chatId: opts.chatId,
      imageUrl: dataUrl,
    })
    if (url.startsWith("data:")) continue
    next = next.split(full).join(`![${alt}](${url})`)
  }

  if (next === opts.content) return opts.content

  const { error } = await supabase
    .from("agent_messages")
    .update({ content: next })
    .eq("id", opts.messageId)

  if (error) {
    console.error(`migrateMessageDataImages update: ${error.message}`)
    // Ainda devolve o content leve na resposta desta request.
  }
  return next
}
