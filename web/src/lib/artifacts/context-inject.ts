/**
 * Regras de injeção de artefatos no prompt do modelo.
 * Separado da UI: o apêndice NUNCA deve aparecer na bolha do usuário.
 */
import type { ArtifactKind } from "./types"

/** Marcador legado que o store já colou em mensagens do usuário. */
export const ARTIFACT_APPENDIX_MARKER =
  "\n\n---\nArtefatos editados nesta conversa"

/** Teto por artefato no system prompt (chars). Acima disso, resume. */
export const ARTIFACT_INJECT_MAX_CHARS = 20_000

export interface ArtifactForContext {
  id?: string
  kind: ArtifactKind
  title: string
  content: string
  version: number
  is_truncated?: boolean
  updated_at?: string
}

/** Remove o apêndice legado colado no content da mensagem do usuário. */
export function stripArtifactAppendix(content: string): string {
  const idx = content.indexOf(ARTIFACT_APPENDIX_MARKER)
  if (idx < 0) return content
  return content.slice(0, idx).trimEnd()
}

/**
 * Heurística: conteúdo claramente incompleto (fence/HTML cortado).
 * Usado quando `is_truncated` ainda não veio do DB.
 */
export function looksTruncated(kind: ArtifactKind, content: string): boolean {
  const t = content.trim()
  if (!t) return true
  if (kind === "html") {
    if (/<html[\s>]/i.test(t) && !/<\/html>/i.test(t)) return true
    if (/<body[\s>]/i.test(t) && !/<\/body>/i.test(t)) return true
    if (/<[a-z][a-z0-9]*\b[^>]*$/i.test(t)) return true
  }
  // Markdown/HTML cortado no meio de uma tag ou fence.
  if (/```\w*\s*$/.test(t)) return true
  return false
}

/**
 * Uma entrada por `kind` (a mais recente / maior version).
 * Inclui incompletos (marcados) para o modelo poder COMPLETAR em vez de recriar.
 */
export function selectArtifactsForContext(
  artifacts: ArtifactForContext[],
): ArtifactForContext[] {
  const sorted = [...artifacts].sort((a, b) => {
    const av = a.version ?? 0
    const bv = b.version ?? 0
    if (bv !== av) return bv - av
    const at = a.updated_at ? Date.parse(a.updated_at) : 0
    const bt = b.updated_at ? Date.parse(b.updated_at) : 0
    return bt - at
  })

  const byKind = new Map<ArtifactKind, ArtifactForContext>()
  for (const a of sorted) {
    if (byKind.has(a.kind)) continue
    const incomplete =
      Boolean(a.is_truncated) || looksTruncated(a.kind, a.content)
    const content =
      a.content.length > ARTIFACT_INJECT_MAX_CHARS
        ? `${a.content.slice(0, ARTIFACT_INJECT_MAX_CHARS)}\n\n[…conteúdo truncado para o prompt; continue a partir daqui no fence completo]`
        : a.content
    byKind.set(a.kind, { ...a, content, is_truncated: incomplete })
  }
  return [...byKind.values()]
}

const ARTIFACT_EDIT_RULES =
  "## Artefatos da conversa (versão atual — EDITAR, não recriar)\n" +
  "Regras obrigatórias:\n" +
  "1. Já existe artefato do kind abaixo: qualquer pedido (completar, continuar, corrigir, alterar, melhorar) " +
  "deve devolver O MESMO artefato COMPLETO atualizado numa única fence ```html ou ```markdown.\n" +
  "2. NÃO invente um documento novo do zero se o usuário pediu para completar/editar o atual — parta do conteúdo abaixo.\n" +
  "3. NÃO resuma nem omita seções intactas; preserve o que já estava certo e só mude o necessário.\n" +
  "4. Só crie um artefato de outro kind se o usuário pedir explicitamente outro formato/documento.\n" +
  "5. Se o artefato estiver marcado INCOMPLETO, continue a partir dele até fechar HTML/Markdown válidos.\n\n"

/** Bloco de system prompt com os artefatos atuais (já deduplicados). */
export function formatArtifactsSystemBlock(
  artifacts: ArtifactForContext[],
): string | null {
  const selected = selectArtifactsForContext(artifacts)
  if (selected.length === 0) return null

  const body = selected
    .map((a) => {
      const flag = a.is_truncated ? ", INCOMPLETO" : ""
      return `### ${a.title} (${a.kind}, v${a.version}${flag})\n\`\`\`${a.kind}\n${a.content}\n\`\`\``
    })
    .join("\n\n")

  return ARTIFACT_EDIT_RULES + body
}
