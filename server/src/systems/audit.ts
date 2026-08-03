/**
 * Auditoria das tool calls do Dexter (LGPD). Grava toda chamada de RPC a um
 * sistema em agent_tool_calls (projeto agentcore) — quem, o quê, entrada/saída.
 */
import { supabase } from "../lib/supabase.js"

export interface ToolCallAudit {
  chatId: string
  userId: string
  /** id da mensagem do assistente que originou a chamada (liga os passos à resposta). */
  messageId?: string
  toolName: string
  input: unknown
  output: unknown
  status: "ok" | "error"
  durationMs: number
  traceId?: string
}

/** Insere um registro de auditoria (best-effort — não derruba o chat se falhar). */
export async function auditToolCall(rec: ToolCallAudit): Promise<void> {
  const row: Record<string, unknown> = {
    chat_id: rec.chatId,
    user_id: rec.userId,
    tool_name: rec.toolName,
    input: rec.input ?? null,
    output: rec.output ?? null,
    status: rec.status,
    duration_ms: rec.durationMs,
  }
  if (rec.messageId) row.message_id = rec.messageId
  if (rec.traceId) row.trace_id = rec.traceId

  const { error } = await supabase.from("agent_tool_calls").insert(row)
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[audit] falha ao gravar agent_tool_calls:", error.message)
  }
}
