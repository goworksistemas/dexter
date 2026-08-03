/**
 * Renderizador de markdown minimalista, SEM dependências externas.
 *
 * Por quê isto existe em vez de `@assistant-ui/react-markdown`: o pipeline
 * reativo do assistant-ui instalado (useAuiState/useSyncExternalStore) está
 * quebrado nesta versão — ver `@/lib/runtime/use-thread-state` — então
 * `MarkdownTextPrimitive` (que só lê o texto via esse mesmo contexto reativo
 * quebrado, não aceita o texto por prop) nunca atualizaria durante o
 * streaming. E `react-markdown` (o parser por trás dele) é uma dependência
 * TRANSITIVA — só existe aninhada dentro de `@assistant-ui/react-markdown`,
 * não é resolvível a partir do nosso código sem instalar pacotes, o que é
 * proibido neste projeto.
 *
 * Cobre o essencial do que respostas de LLM costumam usar: parágrafos,
 * **negrito**, *itálico*, `código inline`, blocos ```código```, listas com
 * "- "/"1. " e [links](url). NÃO é um parser CommonMark completo — é um
 * meio-termo pragmático dado o ambiente disponível.
 */
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** Aplica formatação inline (negrito, itálico, código, links) a uma linha. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g
  const parts = text.split(pattern).filter((part) => part.length > 0)

  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 text-[0.85em] text-card-foreground"
        >
          {part.slice(1, -1)}
        </code>
      )
    }

    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (linkMatch) {
      return (
        <a
          key={key}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {linkMatch[1]}
        </a>
      )
    }

    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    ) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }

    return <span key={key}>{part}</span>
  })
}

const MARCADOR_NAO_ORDENADO = /^[-*]\s+/
const MARCADOR_ORDENADO = /^\d+\.\s+/

/** Renderiza uma sequência de linhas de lista (todas com o mesmo marcador). */
function renderLista(linhas: string[], ordenada: boolean, key: string): ReactNode {
  const marcador = ordenada ? MARCADOR_ORDENADO : MARCADOR_NAO_ORDENADO
  const Tag = ordenada ? "ol" : "ul"
  return (
    <Tag
      key={key}
      className={cn(
        "my-2 space-y-0.5 pl-5",
        ordenada ? "list-decimal" : "list-disc"
      )}
    >
      {linhas.map((l, i) => (
        <li key={i}>{renderInline(l.trim().replace(marcador, ""), `${key}-${i}`)}</li>
      ))}
    </Tag>
  )
}

/** Renderiza uma sequência de linhas de parágrafo (quebras simples viram <br/>). */
function renderParagrafo(linhas: string[], key: string): ReactNode {
  return (
    <p key={key} className="my-2 first:mt-0 last:mb-0">
      {linhas.map((l, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {renderInline(l, `${key}-${i}`)}
        </span>
      ))}
    </p>
  )
}

/** Renderiza um bloco (parágrafo, lista ou bloco de código).
 *
 * Um bloco pode misturar uma linha de introdução com uma lista logo em
 * seguida (sem linha em branco entre elas — muito comum em respostas de
 * LLM), então segmentamos por "runs" consecutivos do mesmo tipo de linha em
 * vez de exigir uniformidade no bloco inteiro. */
function renderBlock(block: string, key: string): ReactNode {
  const trimmed = block.trim()
  if (!trimmed) return null

  const codeMatch = /^```[^\n]*\n?([\s\S]*?)```$/.exec(trimmed)
  if (codeMatch) {
    return (
      <pre
        key={key}
        className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-[0.85em] text-card-foreground"
      >
        <code>{codeMatch[1].replace(/\n$/, "")}</code>
      </pre>
    )
  }

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0)

  type Segmento = { tipo: "ul" | "ol" | "p"; linhas: string[] }
  const segmentos: Segmento[] = []
  for (const linha of lines) {
    const tipo = MARCADOR_NAO_ORDENADO.test(linha)
      ? "ul"
      : MARCADOR_ORDENADO.test(linha)
        ? "ol"
        : "p"
    const ultimo = segmentos.at(-1)
    if (ultimo && ultimo.tipo === tipo) ultimo.linhas.push(linha)
    else segmentos.push({ tipo, linhas: [linha] })
  }

  return (
    <div key={key}>
      {segmentos.map((seg, i) => {
        const segKey = `${key}-seg${i}`
        if (seg.tipo === "ul") return renderLista(seg.linhas, false, segKey)
        if (seg.tipo === "ol") return renderLista(seg.linhas, true, segKey)
        return renderParagrafo(seg.linhas, segKey)
      })}
    </div>
  )
}

/** Converte um texto em markdown-lite para nós React. */
export function renderMarkdownLite(text: string): ReactNode {
  const blocks = text.split(/\n{2,}/)
  return <>{blocks.map((block, i) => renderBlock(block, `b${i}`))}</>
}
