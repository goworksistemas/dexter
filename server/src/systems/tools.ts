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
  },
): Promise<ToolExecution> {
  if (isWebToolName(name)) {
    return executeWebTool(name, input)
  }
  if (isConnectorToolName(name)) {
    if (!ctx.connectors) {
      return { ok: false, error: "conectores não resolvidos nesta sessão" }
    }
    return executeConnectorTool(name, input, {
      userId: ctx.userId,
      email: ctx.email,
      runtime: ctx.connectors,
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
    const result = await callSystemRpc(slug, fn, args)
    return { ok: true, slug, fn, result }
  } catch (err) {
    return { ok: false, slug, fn, error: err instanceof Error ? err.message : String(err) }
  }
}
