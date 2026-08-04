/**
 * Ponte entre o manifesto de RPCs / conectores e o tool-use do Claude.
 *
 * SEGURANÇA (o ponto mais importante):
 *  - As tools expostas ao LLM NÃO têm `p_email`. O backend injeta o email do
 *    usuário AUTENTICADO em toda chamada — o modelo nunca escolhe de quem é o dado.
 *  - Duplo gate: (1) o sistema tem que estar no mapa de acesso do usuário
 *    (preflight/whoami); (2) a função tem que estar no manifesto (allowlist).
 *    Além disso a própria RPC tem gate no banco (defesa em profundidade).
 *  - Conectores Notion/Outlook: gated por preferência do usuário + secrets Infisical.
 */
import {
  buildConnectorTools,
  describeConnectorTool,
  executeConnectorTool,
  isConnectorToolName,
} from "../connectors/tools.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import { SYSTEM_TOOLS } from "./manifest.js"
import { callSystemRpc } from "./client.js"
import { SYSTEMS } from "./registry.js"
import { canAccess, type SystemAccess } from "./access.js"
import type { AnthropicTool } from "./tool-types.js"
import {
  buildWebTools,
  describeWebTool,
  executeWebTool,
  isWebToolName,
} from "./web-search.js"
import { KB_CATEGORIES, searchKbDocs } from "../services/kb-store.js"

export type { AnthropicTool } from "./tool-types.js"

/** nome da tool = `<slug>__<fn>` (o modelo vê isto; o backend traduz de volta). */
function toolName(slug: string, fn: string): string {
  return `${slug}__${fn}`
}

function parseToolName(name: string): { slug: string; fn: string } | null {
  const i = name.indexOf("__")
  if (i < 0) return null
  return { slug: name.slice(0, i), fn: name.slice(i + 2) }
}

/** Base de conhecimento interna — tool global (todo usuário autenticado). */
const KB_TOOL_PREFIX = "kb__"

function isKbToolName(name: string): boolean {
  return name.startsWith(KB_TOOL_PREFIX)
}

function buildKbTools(): AnthropicTool[] {
  return [
    {
      name: "kb__buscar",
      description:
        "[Base de conhecimento GoWork] Consulta a base de conhecimento INTERNA e curada sobre a GoWork: " +
        "a empresa (o que faz, unidades, modelo de negócio), os sistemas internos (NetworkGo, PipeGo, GoDash…), " +
        "projetos e iniciativas em andamento, times/pessoas e responsabilidades, e o glossário de siglas e termos " +
        "usados no dia a dia. Use SEMPRE que a pergunta envolver contexto da empresa, o significado de um termo/sigla " +
        "interna, quem cuida do quê, ou o objetivo de um projeto — antes de dizer que não sabe. " +
        "Sem `termo`, devolve o ÍNDICE dos documentos disponíveis (slug, título, categoria) para você escolher o que ler. " +
        "É contexto e direção, não dado vivo: números, status e listas atuais continuam vindo das tools dos sistemas.",
      input_schema: {
        type: "object",
        properties: {
          termo: {
            type: "string",
            description:
              "Texto a buscar em título, slug e conteúdo dos documentos (ex.: 'NetworkGo', 'OS', 'metas 2026'). " +
              "Omita para receber só o índice da base.",
          },
          categoria: {
            type: "string",
            description: `Filtro opcional de categoria: ${KB_CATEGORIES.join(" | ")}.`,
          },
        },
        required: [],
      },
    },
  ]
}

function describeKbTool(name: string): ToolDescription {
  return {
    slug: "kb",
    fn: name.slice(KB_TOOL_PREFIX.length),
    systemLabel: "Base de conhecimento",
    toolLabel: "Busca interna",
    label: "Consultando a base de conhecimento GoWork",
  }
}

/** Resultado como texto estruturado — mais legível para o modelo que JSON cru. */
async function executeKbTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const fn = name.slice(KB_TOOL_PREFIX.length)
  if (fn !== "buscar") {
    return { ok: false, slug: "kb", fn, error: `função kb desconhecida: ${fn}` }
  }
  try {
    const termo = input.termo != null ? String(input.termo) : undefined
    const categoria = input.categoria != null ? String(input.categoria) : undefined
    const res = await searchKbDocs(termo, categoria)

    const linhas: string[] = []
    linhas.push(
      `Base de conhecimento GoWork — ${
        res.termo ? `busca: "${res.termo}"` : "índice"
      }${res.categoria ? ` (categoria: ${res.categoria})` : ""}`,
    )
    linhas.push(`Documentos habilitados no filtro: ${res.total_disponivel}`)

    for (const doc of res.documentos) {
      linhas.push("")
      linhas.push(`### ${doc.title} [${doc.slug} · ${doc.categoria}]`)
      linhas.push(doc.conteudo)
    }

    if (res.indice.length > 0) {
      linhas.push("")
      linhas.push(
        res.documentos.length > 0
          ? "Outros documentos da base (chame kb__buscar com o slug para ler):"
          : "Documentos disponíveis (chame kb__buscar com o slug ou um termo para ler):",
      )
      const mostrados = new Set(res.documentos.map((d) => d.slug))
      for (const item of res.indice) {
        if (res.documentos.length > 0 && mostrados.has(item.slug)) continue
        linhas.push(`- ${item.slug} — ${item.title} (${item.category})`)
      }
    }

    linhas.push("")
    linhas.push(res.dica)
    return { ok: true, slug: "kb", fn, result: linhas.join("\n") }
  } catch (err) {
    return {
      ok: false,
      slug: "kb",
      fn,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface BuildToolsOptions {
  access: SystemAccess[]
  connectors?: ConnectorRuntime
  userId?: string
}

/** Monta a lista de tools do Claude (sistemas GoWork + conectores ativos). */
export async function buildTools(
  accessOrOpts: SystemAccess[] | BuildToolsOptions,
  connectors?: ConnectorRuntime,
): Promise<AnthropicTool[]> {
  const access = Array.isArray(accessOrOpts)
    ? accessOrOpts
    : accessOrOpts.access
  const runtime = Array.isArray(accessOrOpts)
    ? connectors
    : accessOrOpts.connectors
  const userId = Array.isArray(accessOrOpts)
    ? undefined
    : accessOrOpts.userId

  const tools: AnthropicTool[] = []
  for (const a of access) {
    for (const t of SYSTEM_TOOLS[a.slug] ?? []) {
      const properties: Record<string, { type: string; description: string }> =
        {}
      for (const p of t.params) {
        properties[p.name] = { type: p.type, description: p.description }
      }
      tools.push({
        name: toolName(a.slug, t.fn),
        description: `[${a.label}] ${t.description}`,
        input_schema: {
          type: "object",
          properties,
          required: t.params.filter((p) => p.required).map((p) => p.name),
        },
      })
    }
  }

  if (runtime) {
    tools.push(...(await buildConnectorTools(runtime, { userId })))
  }
  tools.push(...(await buildWebTools()))
  tools.push(...buildKbTools())
  return tools
}

export interface ToolDescription {
  slug?: string
  fn?: string
  systemLabel?: string
  toolLabel?: string
  /** Frase pronta para a UI, ex.: "Consultando PipeGo · Consulta SQL". */
  label: string
}

/** Traduz o nome técnico da tool em rótulos legíveis (para o progresso na UI). */
export function describeTool(name: string): ToolDescription {
  if (isWebToolName(name)) {
    return describeWebTool(name)
  }
  if (isKbToolName(name)) {
    return describeKbTool(name)
  }
  if (isConnectorToolName(name)) {
    return describeConnectorTool(name)
  }
  const parsed = parseToolName(name)
  if (!parsed) return { label: name }
  const { slug, fn } = parsed
  const systemLabel = SYSTEMS.find((s) => s.slug === slug)?.label
  const toolLabel = (SYSTEM_TOOLS[slug] ?? []).find((t) => t.fn === fn)?.label
  const alvo = systemLabel ?? slug
  return {
    slug,
    fn,
    systemLabel,
    toolLabel,
    label: toolLabel ? `Consultando ${alvo} · ${toolLabel}` : `Consultando ${alvo}`,
  }
}

export interface ToolExecution {
  ok: boolean
  slug?: string
  fn?: string
  result?: unknown
  error?: string
}

/** Executa uma tool call: sistemas GoWork ou conectores Notion/Outlook. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: {
    userId: string
    email: string
    access: SystemAccess[]
    connectors?: ConnectorRuntime
    /** Cancelamento do run (cliente desconectou / Parar). */
    signal?: AbortSignal
  },
): Promise<ToolExecution> {
  if (isWebToolName(name)) {
    return executeWebTool(name, input, ctx.signal)
  }
  if (isKbToolName(name)) {
    return executeKbTool(name, input)
  }
  if (isConnectorToolName(name)) {
    if (!ctx.connectors) {
      return { ok: false, error: "conectores não resolvidos nesta sessão" }
    }
    return executeConnectorTool(name, input, {
      userId: ctx.userId,
      email: ctx.email,
      runtime: ctx.connectors,
      signal: ctx.signal,
    })
  }

  const parsed = parseToolName(name)
  if (!parsed) return { ok: false, error: `tool desconhecida: ${name}` }
  const { slug, fn } = parsed

  if (!canAccess(ctx.access, slug)) {
    return { ok: false, slug, fn, error: `usuário sem acesso ao sistema "${slug}"` }
  }
  const allowed = (SYSTEM_TOOLS[slug] ?? []).some((t) => t.fn === fn)
  if (!allowed) {
    return { ok: false, slug, fn, error: `função não permitida: ${fn}` }
  }

  const args = { ...input, p_email: ctx.email }
  try {
    const result = await callSystemRpc(slug, fn, args, { signal: ctx.signal })
    return { ok: true, slug, fn, result }
  } catch (err) {
    return { ok: false, slug, fn, error: err instanceof Error ? err.message : String(err) }
  }
}
