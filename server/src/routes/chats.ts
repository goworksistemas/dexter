/**
 * GET /api/chats, GET /api/chats/:id/messages, GET /api/chats/:id/tail,
 * PATCH /api/chats/:id, DELETE /api/chats/:id —
 * dados e mutações de conversas. Ownership obrigatório (anti-IDOR).
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { NotFoundError, resolveUser } from "../services/auth.js"
import { parseBulkChatsBody } from "../services/chat-bulk.js"
import {
  bulkChatsAction,
  deleteChat,
  getChatTail,
  getChatToolCalls,
  getMessagesPage,
  listChats,
  renameChat,
  setChatModel,
  setChatProject,
  TAIL_MAX_LIMIT,
  truncateAfterLastUserMessage,
  truncateFromMessageId,
  truncateMessages,
} from "../services/chat-store.js"
import { stepFromToolCall, type AgentStep } from "../systems/progress.js"
import { describeTool } from "../systems/tools.js"

const TITLE_MIN = 1
const TITLE_MAX = 120

const patchBodySchema = z
  .object({
    title: z.string().optional(),
    projectId: z.union([z.string().uuid(), z.null()]).optional(),
    /** id do modelo (catálogo /api/models) — pina o modelo desta conversa. */
    model: z.string().min(1).max(120).optional(),
  })
  .refine(
    (b) =>
      b.title !== undefined ||
      b.projectId !== undefined ||
      b.model !== undefined,
    { message: "Informe title, projectId e/ou model." },
  )

function badRequest(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { statusCode: number }).statusCode = 400
  return err
}

export default async function chatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/chats", async (request) => {
    const { userId } = await resolveUser(request)
    return listChats(userId)
  })

  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; before?: string }
  }>("/api/chats/:id/messages", async (request) => {
    const { userId } = await resolveUser(request)
    const limitRaw = request.query.limit
    const limit = limitRaw !== undefined ? Number(limitRaw) : 40
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw badRequest("limit deve ser um inteiro entre 1 e 100.")
    }
    const before = request.query.before
    if (before !== undefined && !z.string().uuid().safeParse(before).success) {
      throw badRequest("before deve ser um UUID de mensagem.")
    }
    return getMessagesPage(request.params.id, userId, {
      limit,
      ...(before ? { before } : {}),
    })
  })

  /**
   * Cauda da conversa: últimas N mensagens + `hasMore` (existe histórico
   * antes). Endpoint leve para o front reconciliar ids depois de um run ou
   * descobrir se a conversa é nova, sem recarregar o histórico inteiro.
   */
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string }
  }>("/api/chats/:id/tail", async (request) => {
    const { userId } = await resolveUser(request)
    const limitRaw = request.query.limit
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw)
      if (!Number.isFinite(limit) || limit < 1 || limit > TAIL_MAX_LIMIT) {
        throw badRequest(
          `limit deve ser um inteiro entre 1 e ${TAIL_MAX_LIMIT}.`,
        )
      }
      return getChatTail(request.params.id, userId, { limit })
    }
    return getChatTail(request.params.id, userId)
  })

  /**
   * Passos (tool calls) já executados na conversa, agrupados pela mensagem do
   * assistente que os originou — alimenta o "Ver detalhes" das respostas
   * antigas. Args e resultados vão resumidos/truncados (ver systems/progress).
   */
  app.get<{ Params: { id: string } }>("/api/chats/:id/steps", async (request) => {
    const { userId } = await resolveUser(request)
    const toolCalls = await getChatToolCalls(request.params.id, userId)

    const porMensagem = new Map<string, AgentStep[]>()
    for (const rec of toolCalls) {
      // Chamadas antigas (antes do message_id) não têm resposta associada.
      if (!rec.message_id) continue
      const lista = porMensagem.get(rec.message_id) ?? []
      lista.push(stepFromToolCall(rec, lista.length + 1, describeTool))
      porMensagem.set(rec.message_id, lista)
    }

    return [...porMensagem.entries()].map(([messageId, steps]) => ({
      messageId,
      steps,
    }))
  })

  app.patch<{ Params: { id: string } }>("/api/chats/:id", async (request) => {
    const { userId } = await resolveUser(request)
    const parsed = patchBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Body inválido.")
    }

    let updated =
      parsed.data.projectId !== undefined
        ? await setChatProject(request.params.id, userId, parsed.data.projectId)
        : null

    if (parsed.data.title !== undefined) {
      const title = parsed.data.title.trim()
      if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
        throw badRequest(
          `title deve ter entre ${TITLE_MIN} e ${TITLE_MAX} caracteres.`,
        )
      }
      updated = await renameChat(request.params.id, userId, title)
    }

    if (parsed.data.model !== undefined) {
      updated = await setChatModel(request.params.id, userId, parsed.data.model)
    }

    if (!updated) {
      throw new NotFoundError("Conversa não encontrada.")
    }
    return updated
  })

  app.delete<{ Params: { id: string } }>("/api/chats/:id", async (request, reply) => {
    const { userId } = await resolveUser(request)
    const ok = await deleteChat(request.params.id, userId)
    if (!ok) {
      throw new NotFoundError("Conversa não encontrada.")
    }
    return reply.code(204).send()
  })

  /**
   * Ações em massa na lista de conversas:
   * `{ ids: uuid[] (1..100), action: "archive" | "unarchive" | "delete" |
   * "move", projectId?: uuid | null }` — projectId obrigatório (uuid ou null)
   * só em "move".
   *
   * Ownership: só age nas conversas do PRÓPRIO usuário. Ids de outros
   * usuários, inexistentes ou já excluídos são ignorados em silêncio (não
   * 403) — idempotente e sem vazar existência de chats alheios; `affected`
   * na resposta diz quantas linhas mudaram de verdade.
   *
   * "delete" é soft delete: a conversa some da lista, mas mensagens e custos
   * ficam no banco para a central de custo do admin (migration 0035).
   */
  app.post("/api/chats/bulk", async (request) => {
    const { userId } = await resolveUser(request)
    const parsed = parseBulkChatsBody(request.body)
    if (!parsed.ok) {
      throw badRequest(parsed.error)
    }
    const affected = await bulkChatsAction(userId, parsed.value)
    return { affected }
  })

  const truncateBodySchema = z
    .object({
      keepCount: z.number().int().min(0).optional(),
      deleteFromMessageId: z.string().uuid().optional(),
      /**
       * Retry: apaga tudo DEPOIS da última mensagem do usuário, desde que o
       * texto dela seja este (proteção contra apagar o turno errado quando o
       * turno atual nunca foi persistido). Não depende de id — a bolha de
       * erro na UI costuma ter id local, sem linha no banco.
       */
      afterLastUserText: z.string().min(1).optional(),
    })
    .refine(
      (b) =>
        b.keepCount !== undefined ||
        b.deleteFromMessageId !== undefined ||
        b.afterLastUserText !== undefined,
      {
        message:
          "Informe keepCount, deleteFromMessageId ou afterLastUserText.",
      },
    )

  /** Truncar histórico (edit/regenerate/retry) — por contagem, a partir de
   * um id, ou depois da última mensagem do usuário (retry). */
  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/truncate",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      const parsed = truncateBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues[0]?.message ?? "Body inválido.",
        )
      }
      let ok: boolean
      if (parsed.data.deleteFromMessageId) {
        ok = await truncateFromMessageId(
          request.params.id,
          userId,
          parsed.data.deleteFromMessageId,
        )
      } else if (parsed.data.afterLastUserText !== undefined) {
        ok = await truncateAfterLastUserMessage(
          request.params.id,
          userId,
          parsed.data.afterLastUserText,
        )
      } else {
        ok = await truncateMessages(
          request.params.id,
          userId,
          parsed.data.keepCount ?? 0,
        )
      }
      if (!ok) {
        throw new NotFoundError("Conversa ou mensagem não encontrada.")
      }
      return reply.code(204).send()
    },
  )
}
