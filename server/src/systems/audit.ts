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

function montarLinha(rec: ToolCallAudit): Record<string, unknown> {
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
  return row
}

/** Insere um registro de auditoria (best-effort — não derruba o chat se falhar). */
export async function auditToolCall(rec: ToolCallAudit): Promise<void> {
  const { error } = await supabase.from("agent_tool_calls").insert(montarLinha(rec))
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[audit] falha ao gravar agent_tool_calls:", error.message)
  }
}

/**
 * Insere todos os passos de um run em UM único INSERT — a auditoria não pode
 * custar uma ida ao banco por tool call antes de fechar a resposta.
 * `created_at` vai explícito e crescente: o `now()` do default é igual para
 * toda a transação e o "Ver detalhes" ordena os passos por esse campo.
 */
export async function auditToolCalls(recs: ToolCallAudit[]): Promise<void> {
  if (recs.length === 0) return
  const base = Date.now()
  const rows = recs.map((rec, i) => ({
    ...montarLinha(rec),
    created_at: new Date(base + i).toISOString(),
  }))

  const { error } = await supabase.from("agent_tool_calls").insert(rows)
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[audit] falha ao gravar agent_tool_calls:", error.message)
  }
}
