/** Tipos mínimos do protocolo MCP (JSON-RPC 2.0). */

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpListToolsResult {
  tools: McpTool[]
}

export interface McpCallToolResult {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>
  structuredContent?: unknown
  isError?: boolean
  [k: string]: unknown
}

export interface McpClientOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Timeout por request JSON-RPC (ms). */
  timeoutMs?: number
  label?: string
}
