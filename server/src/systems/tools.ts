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
import {
  PROJECT_FILE_READ_MAX_CHARS,
  readProjectFileText,
} from "../services/project-store.js"
import {
  buildMultiAgentTools,
  describeMultiAgentTool,
  isMultiAgentToolName,
  MULTI_AGENT_TOOL,
  runSubAgent,
} from "./multi-agent.js"

export type { AnthropicTool } from "./tool-types.js"
export { MULTI_AGENT_TOOL, isMultiAgentToolName }

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
        // Sem `required`: todos os parâmetros são opcionais e o validador do
        // Gemini rejeita `required: []` (400 no request inteiro).
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

/** Arquivos do projeto da conversa — tool só existe se o chat tem projeto. */
const PROJECT_TOOL_PREFIX = "project__"

function isProjectToolName(name: string): boolean {
  return name.startsWith(PROJECT_TOOL_PREFIX)
}

function buildProjectTools(): AnthropicTool[] {
  return [
    {
      name: "project__read_file",
      description:
        "[Projeto] Lê o conteúdo de um arquivo de texto anexado ao projeto desta conversa. " +
        "O system prompt traz só o ÍNDICE dos arquivos (nome, tipo, tamanho, file_id) — " +
        "o conteúdo só chega por aqui. Use SEMPRE que a resposta depender do que está " +
        "dentro de um arquivo do projeto, antes de responder. " +
        `Devolve no máximo ${PROJECT_FILE_READ_MAX_CHARS} caracteres por leitura ` +
        "(o corte vem sinalizado no fim do texto). Arquivos binários/PDF não são suportados.",
      input_schema: {
        type: "object",
        properties: {
          file_id: {
            type: "string",
            description:
              "UUID do arquivo, exatamente como aparece em `file_id:` no índice de arquivos do projeto.",
          },
        },
        required: ["file_id"],
      },
    },
  ]
}

function describeProjectTool(name: string): ToolDescription {
  return {
    slug: "project",
    fn: name.slice(PROJECT_TOOL_PREFIX.length),
    systemLabel: "Projeto",
    toolLabel: "Leitura de arquivo",
    label: "Lendo arquivo do projeto",
  }
}

async function executeProjectTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { userId: string; projectId?: string },
): Promise<ToolExecution> {
  const fn = name.slice(PROJECT_TOOL_PREFIX.length)
  if (fn !== "read_file") {
    return {
      ok: false,
      slug: "project",
      fn,
      error: `função de projeto desconhecida: ${fn}`,
    }
  }
  if (!ctx.projectId) {
    return {
      ok: false,
      slug: "project",
      fn,
      error:
        "Esta conversa não está em um projeto — não há arquivos de projeto para ler.",
    }
  }
  const fileId = typeof input.file_id === "string" ? input.file_id.trim() : ""
  if (!fileId) {
    return {
      ok: false,
      slug: "project",
      fn,
      error: "Informe o file_id do arquivo (está no índice de arquivos do projeto).",
    }
  }

  try {
    const arquivo = await readProjectFileText(ctx.projectId, fileId, ctx.userId)
    const cabecalho = `Arquivo do projeto: ${arquivo.name} (${
      arquivo.mimeType ?? "tipo desconhecido"
    }, ${arquivo.sizeBytes} bytes)`
    const rodape = arquivo.truncated
      ? `\n\n[…arquivo truncado em ${PROJECT_FILE_READ_MAX_CHARS} chars; o texto acima é o início do arquivo]`
      : ""
    return {
      ok: true,
      slug: "project",
      fn,
      result: `${cabecalho}\n\n${arquivo.content}${rodape}`,
    }
  } catch (err) {
    return {
      ok: false,
      slug: "project",
      fn,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface BuildToolsOptions {
  access: SystemAccess[]
  connectors?: ConnectorRuntime
  userId?: string
  /** Projeto do chat — habilita a tool project__read_file. */
  projectId?: string
  /** Usuário autorizou multi-agentes nas preferências. */
  multiAgentEnabled?: boolean
}

/** Monta a lista de tools do Claude (sistemas GoWork + conectores ativos). */
export async function buildTools(
  accessOrOpts: SystemAccess[] | BuildToolsOptions,
  connectors?: ConnectorRuntime,
): Promise<AnthropicTool[]> {
  const opts: BuildToolsOptions = Array.isArray(accessOrOpts)
    ? { access: accessOrOpts, connectors }
    : accessOrOpts
  const access = opts.access
  const runtime = opts.connectors
  const userId = opts.userId

  const tools: AnthropicTool[] = []
  for (const a of access) {
    for (const t of SYSTEM_TOOLS[a.slug] ?? []) {
      const properties: Record<string, { type: string; description: string }> =
        {}
      for (const p of t.params) {
        properties[p.name] = { type: p.type, description: p.description }
      }
      // `required` só quando não-vazio: o Gemini (OpenAI-compat) devolve 400
      // para `required: []` em qualquer tool do request.
      const required = t.params.filter((p) => p.required).map((p) => p.name)
      tools.push({
        name: toolName(a.slug, t.fn),
        description: `[${a.label}] ${t.description}`,
        input_schema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      })
    }
  }

  if (runtime) {
    tools.push(...(await buildConnectorTools(runtime, { userId })))
  }
  tools.push(...(await buildWebTools()))
  tools.push(...buildKbTools())
  if (opts.projectId) {
    tools.push(...buildProjectTools())
  }
  if (opts.multiAgentEnabled) {
    tools.push(...buildMultiAgentTools())
  }
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
  if (isMultiAgentToolName(name)) {
    return describeMultiAgentTool(name)
  }
  if (isWebToolName(name)) {
    return describeWebTool(name)
  }
  if (isKbToolName(name)) {
    return describeKbTool(name)
  }
  if (isProjectToolName(name)) {
    return describeProjectTool(name)
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
    /** Projeto do chat — necessário para project__read_file. */
    projectId?: string
    multiAgentEnabled?: boolean
    model?: string
    apiKey?: string
    onProgress?: (evt: import("./progress.js").AgentProgressEvent) => void
  },
): Promise<ToolExecution> {
  if (isMultiAgentToolName(name)) {
    if (!ctx.multiAgentEnabled) {
      return {
        ok: false,
        slug: "dexter",
        fn: "spawn_subagent",
        error:
          "Multi-agentes não habilitado. Ative em Configurações → Multi-agentes.",
      }
    }
    const sub = await runSubAgent({
      objetivo: String(input.objetivo ?? ""),
      contexto:
        input.contexto != null ? String(input.contexto) : undefined,
      model: ctx.model ?? "claude-sonnet-5",
      access: ctx.access,
      connectors: ctx.connectors,
      userId: ctx.userId,
      email: ctx.email,
      projectId: ctx.projectId,
      apiKey: ctx.apiKey,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    })
    if (!sub.ok) {
      return {
        ok: false,
        slug: "dexter",
        fn: "spawn_subagent",
        error: sub.error ?? "sub-agente falhou",
        result: sub.text || undefined,
      }
    }
    return {
      ok: true,
      slug: "dexter",
      fn: "spawn_subagent",
      result: {
        relatorio: sub.text,
        passos_tools: sub.steps,
      },
    }
  }
  if (isWebToolName(name)) {
    return executeWebTool(name, input, ctx.signal)
  }
  if (isKbToolName(name)) {
    return executeKbTool(name, input)
  }
  if (isProjectToolName(name)) {
    return executeProjectTool(name, input, {
      userId: ctx.userId,
      projectId: ctx.projectId,
    })
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
