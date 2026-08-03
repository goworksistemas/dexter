import type { ArtifactKind, DetectedArtifactBlock } from "./types"

const FENCE_RE =
  /```(html|htm|markdown|md|xhtml)[ \t]*\n([\s\S]*?)```/gi

const OPEN_FENCE_RE = /```(html|htm|markdown|md|xhtml)[ \t]*\n/gi

const SUBSTANTIAL_CHARS = 120

function normalizeKind(lang: string): ArtifactKind {
  const l = lang.toLowerCase()
  if (l === "html" || l === "htm" || l === "xhtml") return "html"
  return "markdown"
}

/** Hash curto e estável (não criptográfico) para source_key. */
export function hashContent(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export function sourceKeyFor(kind: ArtifactKind, content: string): string {
  return `${kind}:${hashContent(content.trim())}`
}

function titleFromContent(kind: ArtifactKind, content: string): string {
  const trimmed = content.trim()
  if (kind === "html") {
    const m = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (m?.[1]?.trim()) return m[1].trim().slice(0, 80)
    const h1 = trimmed.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    if (h1?.[1]?.trim()) return h1[1].trim().slice(0, 80)
    return "Artefato HTML"
  }
  const heading = trimmed.match(/^#{1,3}\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim().slice(0, 80)
  const first = trimmed.split(/\r?\n/).find((l) => l.trim())
  return (first?.trim() || "Artefato Markdown").slice(0, 80)
}

function buildBlock(
  language: string,
  rawContent: string,
  blockIndex: number,
  truncated: boolean,
): DetectedArtifactBlock | null {
  const content = rawContent.replace(/\n$/, "")
  if (!content.trim()) return null
  const kind = normalizeKind(language)
  return {
    kind,
    language: language.toLowerCase(),
    content,
    blockIndex,
    sourceKey: sourceKeyFor(kind, content),
    title: titleFromContent(kind, content),
    substantial: content.trim().length >= SUBSTANTIAL_CHARS,
    truncated,
  }
}

/**
 * Extrai blocos ```html / ```md / ```markdown do texto do assistente.
 * Um fence de artefato aberto e nunca fechado no fim do texto também é
 * devolvido, marcado com `truncated` — o painel avisa o usuário em vez de
 * simplesmente ignorar a resposta cortada.
 */
export function detectArtifactBlocks(text: string): DetectedArtifactBlock[] {
  const out: DetectedArtifactBlock[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(FENCE_RE.source, FENCE_RE.flags)
  let blockIndex = 0
  let consumedUntil = 0
  while ((match = re.exec(text)) !== null) {
    const block = buildBlock(match[1] ?? "markdown", match[2] ?? "", blockIndex, false)
    if (block) out.push(block)
    blockIndex++
    consumedUntil = match.index + match[0].length
  }

  const openRe = new RegExp(OPEN_FENCE_RE.source, OPEN_FENCE_RE.flags)
  openRe.lastIndex = consumedUntil
  const open = openRe.exec(text)
  if (open) {
    const rest = text.slice(open.index + open[0].length)
    if (!rest.includes("```")) {
      const block = buildBlock(open[1] ?? "markdown", rest, blockIndex, true)
      if (block) out.push(block)
    }
  }

  return out
}
