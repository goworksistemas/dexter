/**
 * Ponte MCP stdio (debug opcional via MCP_*_COMMAND).
 * Produto: Notion = MCP HTTP remoto; Outlook = Graph REST.
 */
import { config } from "../config.js"
import { McpStdioClient } from "../mcp/stdio-client.js"
import type { McpTool } from "../mcp/types.js"
import type { AnthropicTool } from "../systems/tool-types.js"
import { notionMcpSpawn, outlookMcpSpawn } from "./registry.js"
import type { ConnectorId } from "./types.js"

/** Tools Outlook/M365 permitidas via MCP (evita explodir o contexto com 300+). */
const OUTLOOK_MCP_ALLOWLIST = new Set([
  "list-mail-messages",
  "get-mail-message",
  "send-mail",
  "create-draft-email",
  "list-mail-folders",
  "list-calendar-events",
  "get-calendar-view",
  "create-calendar-event",
  "list-events",
  "get-my-profile",
  "list-upcoming-events",
])

type CacheEntry = {
  client: McpStdioClient
  tools: McpTool[]
  loadedAt: number
}

const cache = new Map<ConnectorId, CacheEntry>()
const TOOLS_TTL_MS = 5 * 60_000

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

function toAnthropic(
  connectorId: ConnectorId,
  tool: McpTool,
): AnthropicTool | null {
  if (connectorId === "outlook" && !OUTLOOK_MCP_ALLOWLIST.has(tool.name)) {
    return null
  }
  const schema = (tool.inputSchema ?? {
    type: "object",
    properties: {},
  }) as Record<string, unknown>
  // Preserva JSON Schema MCP (anyOf/items) — não achatar para {type,description}.
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {}

  const required = Array.isArray(schema.required)
    ? (schema.required.filter((x) => typeof x === "string") as string[])
    : undefined

  const label = connectorId === "notion" ? "Notion" : "Outlook"
  return {
    name: `${connectorId}__${sanitizeName(tool.name)}`,
    description: `[${label}] ${tool.description ?? tool.name}`,
    input_schema: {
      type: "object",
      properties,
      ...(required?.length ? { required } : {}),
    },
  }
}

async function getEntry(id: ConnectorId): Promise<CacheEntry> {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.loadedAt < TOOLS_TTL_MS) return hit

  if (hit) {
    await hit.client.close().catch(() => undefined)
    cache.delete(id)
  }

  const spawn = id === "notion" ? notionMcpSpawn() : outlookMcpSpawn()
  if (!spawn) {
    throw new Error(`MCP ${id}: comando não configurado`)
  }

  const client = new McpStdioClient({
    command: spawn.command,
    args: spawn.args,
    env: spawn.env,
    timeoutMs: config.MCP_TOOL_TIMEOUT_MS,
    label: id,
  })

  let tools: McpTool[]
  try {
    tools = await client.listTools()
  } catch (err) {
    // Client nunca entra no cache aqui — sem o close o processo filho stdio
    // fica órfão até o servidor morrer.
    await client.close().catch(() => undefined)
    throw err
  }
  const entry: CacheEntry = { client, tools, loadedAt: Date.now() }
  cache.set(id, entry)
  return entry
}

export async function listMcpAnthropicTools(
  id: ConnectorId,
): Promise<AnthropicTool[]> {
  const entry = await getEntry(id)
  const out: AnthropicTool[] = []
  for (const t of entry.tools) {
    const mapped = toAnthropic(id, t)
    if (mapped) out.push(mapped)
  }
  return out
}

export async function callMcpTool(
  id: ConnectorId,
  mcpToolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (id === "outlook" && !OUTLOOK_MCP_ALLOWLIST.has(mcpToolName)) {
    throw new Error(`tool MCP Outlook não permitida: ${mcpToolName}`)
  }
  const entry = await getEntry(id)
  const result = await entry.client.callTool(mcpToolName, args, signal)
  if (result.isError) {
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n")
    throw new Error(text || `MCP ${id}: tools/call retornou erro`)
  }
  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
    if (texts.length === 1) {
      try {
        return JSON.parse(texts[0]!) as unknown
      } catch {
        return texts[0]
      }
    }
    if (texts.length > 1) return texts.join("\n")
  }
  return result
}

/** Resolve o nome MCP original a partir do sufixo sanitizado. */
export async function resolveMcpToolName(
  id: ConnectorId,
  sanitizedFn: string,
): Promise<string> {
  const entry = await getEntry(id)
  const exact = entry.tools.find((t) => t.name === sanitizedFn)
  if (exact) return exact.name
  const match = entry.tools.find((t) => sanitizeName(t.name) === sanitizedFn)
  if (match) return match.name
  throw new Error(`tool MCP não encontrada: ${id}/${sanitizedFn}`)
}
