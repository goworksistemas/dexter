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

/**
 * Versão degradada do bloco de artefatos: só o índice (título/kind/versão), sem
 * conteúdo. Usada pelo gerente de orçamento de contexto (services/context-budget)
 * quando o payload não cabe na janela do modelo — o artefato costuma ser o
 * maior bloco isolado do prompt. O modelo continua sabendo que ele existe, mas
 * é instruído a NÃO reescrever às cegas.
 */
export function formatArtifactsTitlesBlock(
  artifacts: ArtifactWire[],
): string | null {
  const selected = selectArtifactsForContext(artifacts)
  if (selected.length === 0) return null

  const lista = selected
    .map(
      (a) =>
        `- ${a.title} (${a.kind}, v${a.version}${a.is_truncated ? ", INCOMPLETO" : ""})`,
    )
    .join("\n")

  return (
    "## Artefatos da conversa (índice — conteúdo omitido)\n" +
    "O conteúdo dos artefatos abaixo NÃO coube no contexto desta resposta.\n" +
    lista +
    "\n\nSe o pedido do usuário for editar/completar um deles, diga que o " +
    "documento ficou grande demais para caber junto com o resto da conversa e " +
    "peça um recorte (a seção específica). NÃO recrie o artefato do zero e NÃO " +
    "invente o conteúdo que você não está vendo."
  )
}

export function formatArtifactsSystemBlock(
  artifacts: ArtifactWire[],
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
