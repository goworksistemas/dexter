/**
 * GET /api/chats, GET /api/chats/:id/messages,
 * PATCH /api/chats/:id, DELETE /api/chats/:id —
 * dados e mutações de conversas. Ownership obrigatório (anti-IDOR).
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { NotFoundError, resolveUser } from "../services/auth.js"
import {
  deleteChat,
  getChatToolCalls,
  getMessages,
  listChats,
  renameChat,
  setChatProject,
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
  })
  .refine(
    (b) => b.title !== undefined || b.projectId !== undefined,
    { message: "Informe title e/ou projectId." },
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

  app.get<{ Params: { id: string } }>("/api/chats/:id/messages", async (request) => {
    const { userId } = await resolveUser(request)
    return getMessages(request.params.id, userId)
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

    // Se só projectId foi enviado, updated já veio de setChatProject
    if (parsed.data.projectId !== undefined && parsed.data.title === undefined) {
      if (!updated) throw new NotFoundError("Conversa não encontrada.")
      return updated
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

  const truncateBodySchema = z.object({
    keepCount: z.number().int().min(0),
  })

  /** Mantém as primeiras N mensagens; apaga o restante (edit/regenerate). */
  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/truncate",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      const parsed = truncateBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues[0]?.message ?? "Body inválido (keepCount).",
        )
      }
      const ok = await truncateMessages(
        request.params.id,
        userId,
        parsed.data.keepCount,
      )
      if (!ok) {
        throw new NotFoundError("Conversa não encontrada.")
      }
      return reply.code(204).send()
    },
  )
}
