/**
 * Eventos de progresso do loop agêntico — o que o Dexter está fazendo AGORA.
 *
 * São emitidos no SSE (`event: progress`) em paralelo aos `text-delta`, para a
 * UI poder abrir o indicador de "processando" e mostrar a timeline real
 * (tool → sistema → duração → resumo do retorno).
 *
 * PRIVACIDADE: nada de payload cru aqui. Args e resultados vão RESUMIDOS e
 * truncados (`MAX_RESUMO`). O SQL em si aparece porque é read-only e o dado é
 * do próprio usuário — mas `p_email` (injetado pelo backend) nunca é exposto.
 */

/** Limite de caracteres de qualquer resumo enviado ao front. */
export const MAX_RESUMO = 300

export type AgentProgressEvent =
  /** Fase atual sem tool associada (ex.: "Pensando", "Gerando resposta"). */
  | { type: "status"; text: string; step?: number }
  /** Raciocínio exposto pelo modelo (só quando o provider realmente envia). */
  | { type: "thinking"; text: string }
  | {
      type: "tool_call_start"
      /** id do bloco tool_use — pareia com o tool_call_end. */
      id: string
      step: number
      tool: string
      system?: string
      system_label?: string
      tool_label?: string
      /** Texto pronto para a UI (ex.: "Consultando PipeGo · Consulta SQL"). */
      label: string
      args_summary?: string
    }
  | {
      type: "tool_call_end"
      id: string
      step: number
      tool: string
      status: "ok" | "error"
      duration_ms: number
      /** Nº de linhas/itens quando dá para inferir do retorno. */
      rows?: number
      summary: string
    }

/**
 * Passo já concluído, como a UI mostra no "Ver detalhes" de uma resposta
 * antiga. Mesmo vocabulário dos eventos ao vivo (tool_call_start + _end
 * fundidos), reconstruído a partir da auditoria em agent_tool_calls.
 */
export interface AgentStep {
  id: string
  step: number
  tool: string
  system?: string
  system_label?: string
  tool_label?: string
  label: string
  args_summary?: string
  status: "ok" | "error"
  duration_ms?: number
  rows?: number
  summary: string
  created_at?: string
}

/** Corta a string preservando o começo e sinalizando o corte. */
export function truncar(texto: string, max = MAX_RESUMO): string {
  const limpo = texto.replace(/\s+/g, " ").trim()
  if (limpo.length <= max) return limpo
  return `${limpo.slice(0, max - 1)}…`
}

function valorCurto(valor: unknown, max = 120): string {
  if (valor === null || valor === undefined) return ""
  if (typeof valor === "string") return truncar(valor, max)
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor)
  try {
    return truncar(JSON.stringify(valor), max)
  } catch {
    return ""
  }
}

/**
 * Resumo dos argumentos da tool. `p_sql` vem primeiro e quase inteiro (é o que
 * explica a consulta); os demais viram `chave=valor`. `p_email` é omitido.
 */
export function resumirArgs(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const entradas = Object.entries(input as Record<string, unknown>).filter(
    ([chave, valor]) =>
      chave !== "p_email" && valor !== null && valor !== undefined && valor !== "",
  )
  if (entradas.length === 0) return undefined

  const sql = entradas.find(([chave]) => chave === "p_sql")
  const resto = entradas.filter(([chave]) => chave !== "p_sql")

  const partes: string[] = []
  if (sql) partes.push(valorCurto(sql[1], MAX_RESUMO))
  for (const [chave, valor] of resto) {
    const v = valorCurto(valor)
    if (v) partes.push(`${chave.replace(/^p_/, "")}=${v}`)
  }
  const resumo = truncar(partes.join(" · "))
  return resumo.length > 0 ? resumo : undefined
}

/** Tenta inferir quantas linhas/itens o retorno trouxe. */
export function contarLinhas(output: unknown): number | undefined {
  if (Array.isArray(output)) return output.length
  if (!output || typeof output !== "object") return undefined
  const obj = output as Record<string, unknown>

  for (const chave of [
    "total_encontrado",
    "total_retornado",
    "total",
    "qtd",
    "count",
  ]) {
    const valor = obj[chave]
    if (typeof valor === "number" && Number.isFinite(valor)) return valor
  }
  for (const valor of Object.values(obj)) {
    if (Array.isArray(valor)) continue
  }
  for (const valor of Object.values(obj)) {
    if (Array.isArray(valor)) return valor.length
  }
  return undefined
}

/** Resumo humano do retorno da tool (ou da mensagem de erro). */
export function resumirResultado(params: {
  ok: boolean
  output?: unknown
  error?: string
}): { summary: string; rows?: number } {
  if (!params.ok) {
    return { summary: truncar(params.error ?? "falhou") }
  }

  const output = params.output
  if (output === null || output === undefined) {
    return { summary: "sem retorno" }
  }

  if (typeof output === "object" && !Array.isArray(output)) {
    const erro = (output as Record<string, unknown>).erro
    if (typeof erro === "string" && erro.length > 0) {
      return { summary: truncar(`erro do banco: ${erro}`) }
    }
  }

  const rows = contarLinhas(output)
  if (rows !== undefined) {
    const plural = rows === 1 ? "linha" : "linhas"
    return { summary: `${rows} ${plural}`, rows }
  }

  if (typeof output === "object") {
    const chaves = Object.keys(output as Record<string, unknown>)
    if (chaves.length > 0) {
      return { summary: truncar(`campos: ${chaves.slice(0, 8).join(", ")}`) }
    }
  }
  return { summary: truncar(valorCurto(output, MAX_RESUMO)) }
}

/** Mensagem de erro guardada na auditoria (`output = { error }` quando falha). */
function erroDaAuditoria(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined
  const valor = (output as Record<string, unknown>).error
  return typeof valor === "string" ? valor : undefined
}

/**
 * Reconstrói um passo (resumido/truncado) a partir de uma linha de auditoria.
 * `descrever` vem de `systems/tools.ts` — injetado para manter este módulo sem
 * dependência do manifesto.
 */
export function stepFromToolCall(
  rec: {
    id: string
    tool_name: string
    input: unknown
    output: unknown
    status: "ok" | "error"
    duration_ms: number | null
    created_at: string
  },
  step: number,
  descrever: (tool: string) => {
    slug?: string
    systemLabel?: string
    toolLabel?: string
    label: string
  },
): AgentStep {
  const descricao = descrever(rec.tool_name)
  const ok = rec.status === "ok"
  const resumo = resumirResultado({
    ok,
    output: rec.output,
    error: erroDaAuditoria(rec.output),
  })
  const args = resumirArgs(rec.input)
  return {
    id: rec.id,
    step,
    tool: rec.tool_name,
    ...(descricao.slug ? { system: descricao.slug } : {}),
    ...(descricao.systemLabel ? { system_label: descricao.systemLabel } : {}),
    ...(descricao.toolLabel ? { tool_label: descricao.toolLabel } : {}),
    label: descricao.label,
    ...(args ? { args_summary: args } : {}),
    status: rec.status,
    ...(rec.duration_ms !== null ? { duration_ms: rec.duration_ms } : {}),
    ...(resumo.rows !== undefined ? { rows: resumo.rows } : {}),
    summary: resumo.summary,
    created_at: rec.created_at,
  }
}
