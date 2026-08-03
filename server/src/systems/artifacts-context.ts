/**
 * Injeção de artefatos no system prompt (versão atual, dedupe, tamanho limitado).
 * Espelha a lógica de web/src/lib/artifacts/context-inject.ts — manter alinhado.
 */

export const ARTIFACT_APPENDIX_MARKER =
  "\n\n---\nArtefatos editados nesta conversa"

export const ARTIFACT_INJECT_MAX_CHARS = 20_000

export interface ArtifactWire {
  kind: string
  title: string
  content: string
  version: number
  is_truncated?: boolean
}

/** Remove apêndice legado colado no content da mensagem do usuário. */
export function stripArtifactAppendix(content: string): string {
  const idx = content.indexOf(ARTIFACT_APPENDIX_MARKER)
  if (idx < 0) return content
  return content.slice(0, idx).trimEnd()
}

function looksTruncated(kind: string, content: string): boolean {
  const t = content.trim()
  if (!t) return true
  if (kind === "html") {
    if (/<html[\s>]/i.test(t) && !/<\/html>/i.test(t)) return true
    if (/<body[\s>]/i.test(t) && !/<\/body>/i.test(t)) return true
    if (/<[a-z][a-z0-9]*\b[^>]*$/i.test(t)) return true
  }
  if (/```\w*\s*$/.test(t)) return true
  return false
}

export function selectArtifactsForContext(
  artifacts: ArtifactWire[],
): ArtifactWire[] {
  const sorted = [...artifacts].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
  const byKind = new Map<string, ArtifactWire>()
  for (const a of sorted) {
    if (a.is_truncated) continue
    if (looksTruncated(a.kind, a.content)) continue
    if (byKind.has(a.kind)) continue
    const content =
      a.content.length > ARTIFACT_INJECT_MAX_CHARS
        ? `${a.content.slice(0, ARTIFACT_INJECT_MAX_CHARS)}\n\n[…conteúdo truncado para o prompt; peça trechos específicos]`
        : a.content
    byKind.set(a.kind, { ...a, content })
  }
  return [...byKind.values()]
}

export function formatArtifactsSystemBlock(
  artifacts: ArtifactWire[],
): string | null {
  const selected = selectArtifactsForContext(artifacts)
  if (selected.length === 0) return null

  const body = selected
    .map(
      (a) =>
        `### ${a.title} (${a.kind}, v${a.version})\n\`\`\`${a.kind}\n${a.content}\n\`\`\``,
    )
    .join("\n\n")

  return (
    "## Artefatos da conversa (versão atual — use estes, não regenere do zero)\n" +
    "Se o usuário pedir uma alteração pequena (renomear, trocar texto, cor), " +
    "devolva o artefato COMPLETO atualizado numa única fence " +
    "```html / ```markdown — sem resumir e sem omitir seções.\n\n" +
    body
  )
}
