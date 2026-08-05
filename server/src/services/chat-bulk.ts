/**
 * Validação do bulk de conversas (POST /api/chats/bulk).
 * Lógica pura, sem Fastify/Supabase — coberta por vitest (chat-bulk.test.ts).
 */
import { z } from "zod"

/** Teto de ids por chamada — acima disso o front deve fatiar o bulk. */
export const BULK_CHATS_MAX_IDS = 100

export type BulkChatAction = "archive" | "unarchive" | "delete" | "move"

export interface BulkChatsRequest {
  action: BulkChatAction
  /** Ids únicos — duplicatas do body são descartadas. */
  ids: string[]
  /** Só em action="move": projeto de destino (null = remover do projeto). */
  projectId: string | null
}

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_CHATS_MAX_IDS),
  action: z.enum(["archive", "unarchive", "delete", "move"]),
  projectId: z.union([z.string().uuid(), z.null()]).optional(),
})

export type BulkChatsParseResult =
  | { ok: true; value: BulkChatsRequest }
  | { ok: false; error: string }

/**
 * Valida e normaliza o body do bulk:
 * - `ids`: 1..BULK_CHATS_MAX_IDS UUIDs (duplicatas removidas após validar);
 * - `projectId` é OBRIGATÓRIO (uuid ou null) quando action="move" e proibido
 *   nas demais ações — pedido ambíguo é erro, não default silencioso.
 */
export function parseBulkChatsBody(body: unknown): BulkChatsParseResult {
  const parsed = bodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : ""
    return {
      ok: false,
      error: issue
        ? `${path}${issue.message}`
        : `Body inválido. Esperado { ids: uuid[] (1..${BULK_CHATS_MAX_IDS}), action, projectId? }.`,
    }
  }

  const { action, projectId } = parsed.data
  if (action === "move" && projectId === undefined) {
    return {
      ok: false,
      error: 'Informe projectId (uuid do projeto ou null) para action "move".',
    }
  }
  if (action !== "move" && projectId !== undefined) {
    return { ok: false, error: 'projectId só é aceito com action "move".' }
  }

  return {
    ok: true,
    value: {
      action,
      ids: [...new Set(parsed.data.ids)],
      projectId: projectId ?? null,
    },
  }
}
