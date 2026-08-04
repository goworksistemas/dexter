/**
 * Tools dos conectores:
 *  - Notion: MCP HTTP (mcp.notion.com) com token OAuth MCP do usuário
 *  - Outlook: Microsoft Graph REST com token OAuth clássico
 *  - mcp_stdio: só se MCP_*_COMMAND (debug)
 */
import { config } from "../config.js"
import {
  callNotionMcpTool,
  listNotionMcpTools,
} from "../mcp/http-client.js"
import type { McpCallToolResult } from "../mcp/types.js"
import type { AnthropicTool } from "../systems/tool-types.js"
import {
  callMcpTool,
  listMcpAnthropicTools,
  resolveMcpToolName,
} from "./mcp-bridge.js"
import { executeNotionRest, NOTION_REST_TOOLS } from "./notion-api.js"
import { executeOutlookRest, OUTLOOK_REST_TOOLS } from "./outlook-api.js"
import { notionRuntimeMode, outlookRuntimeMode } from "./registry.js"
import { getConnectorRow } from "./store.js"
import {
  ConnectorNotConnectedError,
  resolveUserConnectorToken,
} from "./tokens.js"
import type { ConnectorId, ConnectorRuntime, ConnectorRuntimeMode } from "./types.js"

const CONNECTOR_LABEL: Record<ConnectorId, string> = {
  notion: "Notion",
  outlook: "Outlook",
}

const REST_LABELS: Record<string, string> = {
  notion__search: "Busca",
  notion__fetch_page: "Ler página",
  notion__query_database: "Consultar database",
  notion__create_page: "Criar página",
  notion__update_page_title: "Atualizar título",
  // MCP remoto (mcp.notion.com) — nomes com hífen preservados pelo sanitize
  "notion__notion-search": "Busca no workspace",
  "notion__notion-fetch": "Ler página/database",
  "notion__notion-query-data-sources": "Consultar databases",
  "notion__notion-query-database-view": "Consultar view",
  "notion__notion-create-pages": "Criar páginas",
  "notion__notion-update-page": "Atualizar página",
  "notion__notion-get-users": "Usuários",
  "notion__notion-get-teams": "Teams",
  outlook__list_messages: "Listar e-mails",
  outlook__get_message: "Ler e-mail",
  outlook__send_mail: "Enviar e-mail",
  outlook__list_calendar_events: "Listar agenda",
  outlook__create_calendar_event: "Criar evento",
  outlook__list_mail_folders: "Pastas de e-mail",
  outlook__move_messages: "Mover e-mails",
  outlook__mark_messages_read: "Marcar lido/não lido",
}

/** Reforço nas descriptions do MCP Notion. */
const NOTION_MCP_DESC_EXTRA: Record<string, string> = {
  "notion-fetch":
    ' ATENÇÃO: id="self" retorna SÓ identidade do workspace/usuário — não lista nem conta páginas/cards. ' +
    "Para schema de database: passe URL ou UUID do database (NÃO prefixe collection:// no UUID do database). " +
    "O retorno traz tags collection://<data_source_id> — use ESSE id (não o database_id) em query/create. " +
    "Para schema de um data source específico, fetch com id=\"collection://<data_source_id>\".",
  "notion-search":
    " Use para achar páginas/databases no workspace. Para contagens em um database, prefira notion-query-data-sources após obter o data_source (collection://) via fetch.",
  "notion-query-data-sources":
    " Preferida para contagens/agregações (SQL/views). O id deve ser o data_source (collection://… do fetch), NÃO o database_id. " +
    "Se receber \"Data source not found\", faça notion-fetch no database e use o collection:// retornado.",
  "notion-query-database-view":
    " Consulta uma view pré-definida de database (filtros/sorts da view).",
  "notion-create-pages":
    " Cria card/página. Fluxo: (1) notion-fetch UMA vez no database → ler schema + collection://data_source_id; " +
    "(2) chamar create com parent={data_source_id:\"<uuid sem collection://>\"} e properties com os nomes EXATOS do schema. " +
    "parent é objeto (não string). Título: sempre a propriedade title do schema (pode não se chamar \"title\"). " +
    "NÃO desista pedindo print se o schema já veio no fetch — chame create.",
  "notion-update-page":
    " Atualiza propriedades/conteúdo de uma página existente. Use page_id do card e nomes de propriedades do schema.",
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

/** Formata UUID com hífens (aceita 32 hex ou UUID já hifenizado). */
export function formatNotionUuid(raw: string): string {
  const hex = raw.replace(/-/g, "").toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return raw.trim()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Extrai UUID de collection://… ou devolve null. */
function parseCollectionUrl(raw: string): string | null {
  const m = /^collection:\/\/([0-9a-f-]{32,36})$/i.exec(raw.trim())
  if (!m?.[1]) return null
  return formatNotionUuid(m[1])
}

/**
 * Normaliza args Notion MCP antes do call.
 * - UUID com/sem hífens
 * - parent string → objeto {database_id|data_source_id}
 * - data_source_id com prefixo collection:// → só o UUID
 */
export function normalizeNotionMcpArgs(
  mcpName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input }

  if (mcpName === "notion-fetch" && typeof out.id === "string") {
    const id = out.id.trim()
    if (id === "self") {
      out.id = "self"
    } else if (/^collection:\/\//i.test(id)) {
      const ds = parseCollectionUrl(id)
      out.id = ds ? `collection://${ds}` : id
    } else if (/^[0-9a-f]{32}$/i.test(id.replace(/-/g, ""))) {
      // Database/page UUID cru — NÃO prefixar collection:// (isso causa Data source not found).
      out.id = formatNotionUuid(id)
    }
    // URLs notion.so / notion.site: deixa como está
  }

  if (mcpName === "notion-create-pages") {
    if (typeof out.parent === "string") {
      const p = out.parent.trim()
      const coll = parseCollectionUrl(p)
      if (coll) {
        out.parent = { type: "data_source_id", data_source_id: coll }
      } else if (/^[0-9a-f]{32}$/i.test(p.replace(/-/g, ""))) {
        out.parent = { type: "database_id", database_id: formatNotionUuid(p) }
      }
    } else if (out.parent && typeof out.parent === "object" && !Array.isArray(out.parent)) {
      const parent = { ...(out.parent as Record<string, unknown>) }
      for (const key of ["data_source_id", "database_id", "page_id"] as const) {
        const v = parent[key]
        if (typeof v !== "string") continue
        const coll = parseCollectionUrl(v)
        if (coll && key === "data_source_id") {
          parent[key] = coll
        } else if (/^[0-9a-f]{32}$/i.test(v.replace(/-/g, ""))) {
          parent[key] = formatNotionUuid(v)
        }
      }
      out.parent = parent
    }
  }

  // query-data-sources: vários formatos de param (data_source_url / data_sources / ids)
  for (const key of Object.keys(out)) {
    const v = out[key]
    if (typeof v === "string" && /^collection:\/\//i.test(v)) {
      const coll = parseCollectionUrl(v)
      if (coll) out[key] = `collection://${coll}`
    } else if (Array.isArray(v)) {
      out[key] = v.map((item) => {
        if (typeof item === "string" && /^collection:\/\//i.test(item)) {
          const coll = parseCollectionUrl(item)
          return coll ? `collection://${coll}` : item
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = { ...(item as Record<string, unknown>) }
          for (const [ik, iv] of Object.entries(obj)) {
            if (typeof iv === "string" && /^collection:\/\//i.test(iv)) {
              const coll = parseCollectionUrl(iv)
              if (coll) obj[ik] = `collection://${coll}`
            } else if (
              typeof iv === "string" &&
              (ik.includes("data_source") || ik.endsWith("_id")) &&
              /^[0-9a-f]{32}$/i.test(iv.replace(/-/g, ""))
            ) {
              obj[ik] = formatNotionUuid(iv)
            }
          }
          return obj
        }
        return item
      })
    }
  }

  return out
}

/**
 * Preserva o JSON Schema MCP (anyOf/items/object).
 * Achatar para {type,description} quebrava notion-create-pages (parent virava string).
 */
function mcpToolToAnthropic(
  connectorId: ConnectorId,
  tool: { name: string; description?: string; inputSchema?: unknown },
): AnthropicTool {
  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} }

  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {}

  const required = Array.isArray(schema.required)
    ? (schema.required.filter((x) => typeof x === "string") as string[])
    : undefined

  const label = CONNECTOR_LABEL[connectorId]
  const extra =
    connectorId === "notion"
      ? (NOTION_MCP_DESC_EXTRA[tool.name] ?? "")
      : ""

  const input_schema: AnthropicTool["input_schema"] = {
    type: "object",
    properties,
    ...(required?.length ? { required } : {}),
  }
  if (typeof schema.additionalProperties === "boolean") {
    input_schema.additionalProperties = schema.additionalProperties
  }

  return {
    name: `${connectorId}__${sanitizeName(tool.name)}`,
    description: `[${label}] ${tool.description ?? tool.name}${extra}`,
    input_schema,
  }
}

/** Cache de schemas Notion MCP (independente do user; auth muda por call). */
let notionToolsCache: { tools: AnthropicTool[]; names: Map<string, string>; at: number } | null =
  null
const TOOLS_TTL_MS = 10 * 60_000

async function listNotionHttpAnthropicTools(
  accessToken: string,
): Promise<{ tools: AnthropicTool[]; names: Map<string, string> }> {
  if (notionToolsCache && Date.now() - notionToolsCache.at < TOOLS_TTL_MS) {
    return {
      tools: notionToolsCache.tools,
      names: notionToolsCache.names,
    }
  }
  const mcpTools = await listNotionMcpTools(accessToken)
  const names = new Map<string, string>()
  const tools: AnthropicTool[] = []
  for (const t of mcpTools) {
    const mapped = mcpToolToAnthropic("notion", t)
    tools.push(mapped)
    names.set(sanitizeName(t.name), t.name)
    names.set(t.name, t.name)
  }
  notionToolsCache = { tools, names, at: Date.now() }
  return { tools, names }
}

/** Invalida cache de tools (testes / rotação de schema Notion). */
export function clearNotionToolsCache(): void {
  notionToolsCache = null
}

export function isConnectorToolName(name: string): boolean {
  return name.startsWith("notion__") || name.startsWith("outlook__")
}

export function parseConnectorToolName(
  name: string,
): { id: ConnectorId; fn: string } | null {
  if (name.startsWith("notion__")) {
    return { id: "notion", fn: name.slice("notion__".length) }
  }
  if (name.startsWith("outlook__")) {
    return { id: "outlook", fn: name.slice("outlook__".length) }
  }
  return null
}

async function resolveNotionModeForUser(
  userId: string | undefined,
): Promise<ConnectorRuntimeMode> {
  const base = notionRuntimeMode()
  if (base === "mcp_stdio") return "mcp_stdio"
  if (!userId) return "mcp"
  const row = await getConnectorRow(userId, "notion")
  if (row?.meta?.flow === "mcp_oauth") return "mcp"
  // Fallback workspace token (API) ou legado sem flow → REST.
  if (
    config.NOTION_ALLOW_WORKSPACE_TOKEN === true &&
    typeof config.NOTION_TOKEN === "string" &&
    config.NOTION_TOKEN.trim()
  ) {
    return "rest"
  }
  if (row?.access_token) return "mcp"
  return base
}

export async function buildConnectorTools(
  runtime: ConnectorRuntime,
  opts?: { userId?: string },
): Promise<AnthropicTool[]> {
  const tools: AnthropicTool[] = []
  if (runtime.active.has("notion")) {
    const mode = await resolveNotionModeForUser(opts?.userId)
    if (mode === "mcp_stdio") {
      tools.push(...(await listMcpAnthropicTools("notion")))
    } else if (mode === "mcp" && opts?.userId) {
      try {
        const token = await resolveUserConnectorToken(opts.userId, "notion")
        const listed = await listNotionHttpAnthropicTools(token)
        tools.push(...listed.tools)
      } catch {
        // Sem token: não expõe tools (active deveria impedir, mas evita crash).
      }
    } else if (mode === "rest") {
      tools.push(...NOTION_REST_TOOLS)
    }
  }
  if (runtime.active.has("outlook")) {
    const mode = outlookRuntimeMode()
    if (mode === "mcp_stdio") {
      tools.push(...(await listMcpAnthropicTools("outlook")))
    } else if (mode === "rest") {
      tools.push(...OUTLOOK_REST_TOOLS)
    }
  }
  return tools
}

export function describeConnectorTool(name: string): {
  slug?: string
  fn?: string
  systemLabel?: string
  toolLabel?: string
  label: string
} {
  const parsed = parseConnectorToolName(name)
  if (!parsed) return { label: name }
  const systemLabel = CONNECTOR_LABEL[parsed.id]
  const toolLabel =
    REST_LABELS[name] ??
    parsed.fn
      .replace(/^notion[-_]/, "")
      .replace(/[-_]/g, " ")
      .trim()
  return {
    slug: parsed.id,
    fn: parsed.fn,
    systemLabel,
    toolLabel,
    label: `Consultando ${systemLabel} · ${toolLabel}`,
  }
}

function contentBlockText(c: {
  type?: string
  text?: string
  [k: string]: unknown
}): string | null {
  if (typeof c.text === "string" && c.text.length > 0) return c.text
  if (c.type === "resource" && c.resource && typeof c.resource === "object") {
    const r = c.resource as Record<string, unknown>
    if (typeof r.text === "string" && r.text.length > 0) return r.text
    if (typeof r.blob === "string" && r.blob.length > 0) return r.blob
    try {
      return JSON.stringify(r)
    } catch {
      return null
    }
  }
  return null
}

function parseMcpToolResult(result: McpCallToolResult): unknown {
  if (result.isError) {
    const text = (result.content ?? [])
      .map((c) => contentBlockText(c) ?? JSON.stringify(c))
      .join("\n")
    throw new Error(text || "MCP tools/call retornou erro")
  }

  // structuredContent (MCP 2025+) — não descartar
  if (result.structuredContent != null) {
    const texts = (result.content ?? [])
      .map((c) => contentBlockText(c))
      .filter((t): t is string => typeof t === "string" && t.length > 0)
    if (texts.length === 0) return result.structuredContent
    return {
      structured: result.structuredContent,
      text: texts.length === 1 ? tryParseJson(texts[0]!) : texts.join("\n"),
    }
  }

  if (Array.isArray(result.content)) {
    const texts = result.content
      .map((c) => contentBlockText(c))
      .filter((t): t is string => typeof t === "string" && t.length > 0)

    if (texts.length === 0) {
      throw new Error(
        "Notion MCP retornou resposta vazia para este id. " +
          "Confira se o UUID é de página/database acessível à conexão; " +
          "não use collection:// com o database_id (só com data_source_id do fetch). " +
          "Se persistir: reconecte o Notion em Conexões e compartilhe a base com a integração.",
      )
    }
    if (texts.length === 1) return tryParseJson(texts[0]!)
    return texts.join("\n")
  }

  throw new Error("Notion MCP retornou resultado sem content/structuredContent")
}

function tryParseJson(text: string): unknown {
  const t = text.trim()
  if (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  ) {
    try {
      return JSON.parse(t) as unknown
    } catch {
      /* markdown/json híbrido — devolve texto cru */
    }
  }
  return text
}

export async function executeConnectorTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { userId: string; email: string; runtime: ConnectorRuntime },
): Promise<{
  ok: boolean
  slug?: string
  fn?: string
  result?: unknown
  error?: string
}> {
  const parsed = parseConnectorToolName(name)
  if (!parsed) {
    return { ok: false, error: `tool de conector desconhecida: ${name}` }
  }
  const { id, fn } = parsed
  if (!ctx.runtime.active.has(id)) {
    const status = ctx.runtime.statuses.find((s) => s.id === id)
    if (status && !status.connected) {
      return {
        ok: false,
        slug: id,
        fn,
        error: `Conector "${id}" não conectado. Peça ao usuário para abrir Conexões e autorizar a própria conta.`,
      }
    }
    return {
      ok: false,
      slug: id,
      fn,
      error: `conector "${id}" desligado ou não configurado para este usuário`,
    }
  }

  try {
    const mode =
      id === "notion"
        ? await resolveNotionModeForUser(ctx.userId)
        : outlookRuntimeMode()

    if (id === "notion" && mode === "mcp") {
      const accessToken = await resolveUserConnectorToken(ctx.userId, "notion")
      const listed = await listNotionHttpAnthropicTools(accessToken)
      const mcpName = listed.names.get(fn)
      if (!mcpName) throw new Error(`tool Notion MCP não encontrada: ${fn}`)
      const args = normalizeNotionMcpArgs(mcpName, input)
      const raw = await callNotionMcpTool(accessToken, mcpName, args)
      return { ok: true, slug: id, fn, result: parseMcpToolResult(raw) }
    }

    if (mode === "mcp_stdio") {
      const mcpName = await resolveMcpToolName(id, fn)
      const result = await callMcpTool(id, mcpName, input)
      return { ok: true, slug: id, fn, result }
    }

    if (mode === "rest") {
      const accessToken = await resolveUserConnectorToken(ctx.userId, id)
      const result =
        id === "notion"
          ? await executeNotionRest(fn, input, accessToken)
          : await executeOutlookRest(fn, input, accessToken)
      return { ok: true, slug: id, fn, result }
    }

    return {
      ok: false,
      slug: id,
      fn,
      error:
        id === "outlook"
          ? `Outlook sem runtime — configure MICROSOFT_* no Infisical`
          : `conector "${id}" sem runtime`,
    }
  } catch (err) {
    if (err instanceof ConnectorNotConnectedError) {
      return { ok: false, slug: id, fn, error: err.message }
    }
    return {
      ok: false,
      slug: id,
      fn,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
