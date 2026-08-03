/**
 * Ponte entre o manifesto de RPCs e o tool-use do Claude.
 *
 * SEGURANÇA (o ponto mais importante):
 *  - As tools expostas ao LLM NÃO têm `p_email`. O backend injeta o email do
 *    usuário AUTENTICADO em toda chamada — o modelo nunca escolhe de quem é o dado.
 *  - Duplo gate: (1) o sistema tem que estar no mapa de acesso do usuário
 *    (preflight/whoami); (2) a função tem que estar no manifesto (allowlist).
 *    Além disso a própria RPC tem gate no banco (defesa em profundidade).
 */
import { SYSTEM_TOOLS } from "./manifest.js"
import { callSystemRpc } from "./client.js"
import { canAccess, type SystemAccess } from "./access.js"

export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
}

/** nome da tool = `<slug>__<fn>` (o modelo vê isto; o backend traduz de volta). */
function toolName(slug: string, fn: string): string {
  return `${slug}__${fn}`
}

function parseToolName(name: string): { slug: string; fn: string } | null {
  const i = name.indexOf("__")
  if (i < 0) return null
  return { slug: name.slice(0, i), fn: name.slice(i + 2) }
}

/** Monta a lista de tools do Claude só para os sistemas que o usuário acessa. */
export function buildTools(access: SystemAccess[]): AnthropicTool[] {
  const tools: AnthropicTool[] = []
  for (const a of access) {
    for (const t of SYSTEM_TOOLS[a.slug] ?? []) {
      const properties: Record<string, { type: string; description: string }> = {}
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
  return tools
}

export interface ToolExecution {
  ok: boolean
  slug?: string
  fn?: string
  result?: unknown
  error?: string
}

/** Executa uma tool call do Claude: gate de acesso + injeta p_email + chama a RPC. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { email: string; access: SystemAccess[] }
): Promise<ToolExecution> {
  const parsed = parseToolName(name)
  if (!parsed) return { ok: false, error: `tool desconhecida: ${name}` }
  const { slug, fn } = parsed

  // Gate 1: o usuário precisa ter acesso ao sistema (preflight/whoami).
  if (!canAccess(ctx.access, slug)) {
    return { ok: false, slug, fn, error: `usuário sem acesso ao sistema "${slug}"` }
  }
  // Gate 2: a função precisa estar no manifesto (allowlist).
  const allowed = (SYSTEM_TOOLS[slug] ?? []).some((t) => t.fn === fn)
  if (!allowed) {
    return { ok: false, slug, fn, error: `função não permitida: ${fn}` }
  }

  // Injeta o email do usuário autenticado — o LLM NUNCA controla isto.
  const args = { ...input, p_email: ctx.email }
  try {
    const result = await callSystemRpc(slug, fn, args)
    return { ok: true, slug, fn, result }
  } catch (err) {
    return { ok: false, slug, fn, error: err instanceof Error ? err.message : String(err) }
  }
}
