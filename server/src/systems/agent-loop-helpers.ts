/**
 * Funções puras do loop agêntico (systems/agent-loop.ts).
 *
 * Ficam num módulo separado porque são a parte crítica e testável do loop:
 * truncamento de tool_result, emenda das continuações de `max_tokens` e
 * heurísticas de anti-loop. Sem dependências (config, SDK, rede) — o
 * agent-loop passa tudo o que varia por parâmetro.
 */

/** Texto que parece intenção/preâmbulo sem conclusão — comum após tools. */
export function respostaIncompleta(texto: string, teveTools: boolean): boolean {
  if (!teveTools) return false
  const t = texto.trim()
  if (!t) return true
  const narracao =
    /^(deixa eu|vou (puxar|buscar|consultar|verificar|olhar|checar)|um momento|aguarde|já (volto|pego)|ok[,!]?\s*(vou|deixa))/i.test(
      t,
    ) ||
    /(deixa eu puxar|números certos|vou (consultar|buscar|puxar|verificar)|já busco|em seguida (vou|busco)|agora (vou|busco))/i.test(
      t,
    )
  if (narracao && t.length < 700) return true
  if (/(\.{3}|…)\s*$/.test(t) && t.length < 280 && !/\b\d+\b/.test(t)) {
    return true
  }
  // Narrativa de progresso entre tools sem dossiê/tabela/números densos.
  if (
    teveTools &&
    t.length < 400 &&
    /^(encontrei|pronto|aqui está|vou |agora )/i.test(t) &&
    !/\|.+\|/.test(t) &&
    (t.match(/\b\d+\b/g)?.length ?? 0) < 2
  ) {
    return true
  }
  return false
}

/** Há um bloco ``` aberto e não fechado no texto já emitido? */
export function fenceAberto(texto: string): boolean {
  const fences = texto.match(/^```/gm)
  return (fences?.length ?? 0) % 2 === 1
}

/** Remove repetição do fim do texto anterior no começo da continuação. */
export function removerSobreposicao(cabecalho: string, anterior: string): string {
  const max = Math.min(400, anterior.length, cabecalho.length)
  for (let n = max; n >= 24; n--) {
    if (cabecalho.startsWith(anterior.slice(anterior.length - n))) {
      return cabecalho.slice(n)
    }
  }
  return cabecalho
}

/**
 * Limpa o início da continuação para emendar sem costura visível: tira
 * preâmbulo ("Continuando:"), fence reaberto e trecho repetido. A quebra de
 * linha inicial só é removida se o texto anterior já terminava em linha nova —
 * senão ela é justamente o que faltava para fechar a linha cortada.
 */
export function emendarContinuacao(cabecalho: string, anterior: string): string {
  let out = cabecalho
  if (anterior.endsWith("\n")) out = out.replace(/^[\r\n\t ]+/, "")
  out = out.replace(
    /^(?:continuando|continuação|continuo|seguindo|segue)\b[^\n]{0,60}\r?\n+/i,
    "",
  )
  if (fenceAberto(anterior)) out = out.replace(/^```[\w-]*[ \t]*\r?\n/, "")
  return removerSobreposicao(out, anterior)
}

/** Fingerprint estável de tool+args para anti-loop. */
export function toolCallFingerprint(name: string, input: unknown): string {
  try {
    return `${name}::${JSON.stringify(input ?? {})}`
  } catch {
    return `${name}::?`
  }
}

/** Resultado sem conteúdo útil (modelo refetcha em loop). */
export function isToolResultVazio(result: unknown): boolean {
  if (result === null || result === undefined) return true
  if (typeof result === "string") return result.trim().length < 8
  if (Array.isArray(result)) return result.length === 0
  if (typeof result === "object") {
    const keys = Object.keys(result as object)
    if (keys.length === 0) return true
    // MCP cru sem texto útil
    const r = result as { content?: unknown; structuredContent?: unknown }
    if (
      "content" in r &&
      Array.isArray(r.content) &&
      r.content.length === 0 &&
      r.structuredContent == null
    ) {
      return true
    }
  }
  return false
}

/** Trunca tool_result grande para não estourar a janela de contexto.
 *  Preserva totais agregados (GoDash) quando existirem.
 *  NUNCA colapsa JSON genérico (ex.: Notion MCP) em `{}` — isso apagava
 *  schema/markdown de notion-fetch e fazia o agent loop refetchar sem progresso. */
export function truncarToolResultContent(
  content: string,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content

  const rodape = (omitidos: number) =>
    `\n\n[…resultado truncado (${omitidos} chars omitidos); use o trecho acima — não refetch o mesmo id]`

  try {
    const parsed = JSON.parse(content) as unknown

    // Texto Notion (markdown/schema) chega como JSON string.
    if (typeof parsed === "string") {
      const budget = Math.max(500, maxChars - 120)
      if (parsed.length <= budget) return content
      return JSON.stringify(parsed.slice(0, budget) + rodape(parsed.length - budget))
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const aggregateKeys = [
        "total_encontrado",
        "total_retornado",
        "total",
        "count",
        "aviso",
        "erro",
        "filtros",
        "limite_aplicado",
      ] as const
      const hasAggregate = aggregateKeys.some((k) => k in obj)

      // Só o caminho GoDash (listas com total_*): preserva agregados.
      if (hasAggregate) {
        const preserved: Record<string, unknown> = {}
        for (const key of aggregateKeys) {
          if (key in obj) preserved[key] = obj[key]
        }
        const linhas = obj.linhas ?? obj.itens
        if (Array.isArray(linhas) && linhas.length <= 5) {
          preserved[Array.isArray(obj.linhas) ? "linhas" : "itens"] = linhas
        }
        const header = JSON.stringify(preserved, null, 2)
        if (header.length < maxChars) {
          return (
            header +
            "\n\n[…lista/demais campos truncados; use total_encontrado/total_retornado/count acima como total autoritativo]"
          )
        }
      }
    }
  } catch {
    /* não-JSON */
  }

  return content.slice(0, maxChars) + rodape(content.length - maxChars)
}
