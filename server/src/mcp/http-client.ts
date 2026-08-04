/**
 * Cliente MCP Streamable HTTP (Notion MCP remoto).
 * Usa o SDK oficial + Bearer do usuário.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { McpCallToolResult, McpTool } from "./types.js"

const NOTION_MCP_BASE = "https://mcp.notion.com"
const USER_AGENT = "Dexter-AgentCore-MCP/1.0"

export async function withNotionMcpClient<T>(
  accessToken: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const token = accessToken.trim()
  if (!token) throw new Error("Token Notion MCP ausente")

  let lastErr: unknown
  for (const useSse of [false, true]) {
    const client = new Client(
      { name: "dexter-agentcore", version: "0.1.0" },
      { capabilities: {} },
    )
    const headers = {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    }
    const transport = useSse
      ? new SSEClientTransport(new URL(`${NOTION_MCP_BASE}/sse`), {
          requestInit: { headers },
        })
      : new StreamableHTTPClientTransport(new URL(`${NOTION_MCP_BASE}/mcp`), {
          requestInit: { headers },
        })
    try {
      await client.connect(transport)
      try {
        return await fn(client)
      } finally {
        await client.close().catch(() => undefined)
      }
    } catch (err) {
      lastErr = err
      await client.close().catch(() => undefined)
      if (!useSse) continue
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Notion MCP: falha ao conectar — ${String(lastErr)}`)
}

export async function listNotionMcpTools(
  accessToken: string,
): Promise<McpTool[]> {
  return withNotionMcpClient(accessToken, async (client) => {
    const result = await client.listTools()
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpTool["inputSchema"],
    }))
  })
}

export async function callNotionMcpTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallToolResult> {
  return withNotionMcpClient(accessToken, async (client) => {
    const result = await client.callTool({ name, arguments: args })
    return result as McpCallToolResult
  })
}

export async function fetchNotionWorkspaceLabel(
  accessToken: string,
): Promise<{ workspace_id?: string; workspace_name?: string } | null> {
  try {
    const result = await callNotionMcpTool(accessToken, "notion-fetch", {
      id: "self",
    })
    const text = (result.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
    if (!text) return null
    const parsed = JSON.parse(text) as {
      self?: { workspace?: { id?: string; name?: string } }
    }
    const ws = parsed.self?.workspace
    if (!ws) return null
    return {
      workspace_id: typeof ws.id === "string" ? ws.id : undefined,
      workspace_name: typeof ws.name === "string" ? ws.name : undefined,
    }
  } catch {
    return null
  }
}
