/**
 * One-shot: sobe data:image embutidos em agent_messages para o bucket chat-images.
 * Uso: infisical run --env=prod --path=/ -- node scripts/migrate-chat-images.mjs
 */
import { createClient } from "@supabase/supabase-js"
import { randomUUID } from "node:crypto"

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes")
  process.exit(1)
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const DATA_RE =
  /!\[([^\]]*)\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)\)/gi

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim())
  if (!m) return null
  const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64")
  return { mime: m[1].toLowerCase(), bytes }
}

function ext(mime) {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  return "png"
}

const { data: chats, error: chatsErr } = await supabase
  .from("agent_chats")
  .select("id, user_id")
if (chatsErr) throw chatsErr

const chatUser = new Map((chats ?? []).map((c) => [c.id, c.user_id]))

const { data: msgs, error } = await supabase
  .from("agent_messages")
  .select("id, chat_id, content")
  .like("content", "%data:image/%")

if (error) throw error

console.log(`mensagens com data:image: ${(msgs ?? []).length}`)

let updated = 0
for (const msg of msgs ?? []) {
  const userId = chatUser.get(msg.chat_id)
  if (!userId) continue
  let next = msg.content
  const matches = [...msg.content.matchAll(new RegExp(DATA_RE.source, "gi"))]
  for (const match of matches) {
    const full = match[0]
    const alt = match[1] ?? "imagem"
    const dataUrl = match[2].replace(/\s+/g, "")
    const parsed = parseDataUrl(dataUrl)
    if (!parsed) continue
    const path = `${userId}/${msg.chat_id}/${randomUUID()}.${ext(parsed.mime)}`
    const { error: upErr } = await supabase.storage
      .from("chat-images")
      .upload(path, parsed.bytes, { contentType: parsed.mime, upsert: false })
    if (upErr) {
      console.error(`upload fail ${msg.id}: ${upErr.message}`)
      continue
    }
    const pub = supabase.storage.from("chat-images").getPublicUrl(path).data
      .publicUrl
    next = next.split(full).join(`![${alt}](${pub})`)
  }
  if (next === msg.content) continue
  const { error: updErr } = await supabase
    .from("agent_messages")
    .update({ content: next })
    .eq("id", msg.id)
  if (updErr) {
    console.error(`update fail ${msg.id}: ${updErr.message}`)
    continue
  }
  updated++
  console.log(`ok ${msg.id}`)
}

console.log(`migradas: ${updated}`)
