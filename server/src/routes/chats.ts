/**
 * GET /api/chats, GET /api/chats/:id/messages,
 * PATCH /api/chats/:id, DELETE /api/chats/:id —
 * dados e mutações de conversas. Ownership obrigatório (anti-IDOR).
 */
import type { FastifyInstance } from "fastify"

import { NotFoundError, resolveUser } from "../services/auth.js"
import {
  deleteChat,
  getMessages,
  listChats,
  renameChat,
} from "../services/chat-store.js"

const TITLE_MIN = 1
const TITLE_MAX = 120

export default async function chatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/chats", async (request) => {
    const { userId } = await resolveUser(request)
    return listChats(userId)
  })

  app.get<{ Params: { id: string } }>("/api/chats/:id/messages", async (request) => {
    const { userId } = await resolveUser(request)
    return getMessages(request.params.id, userId)
  })

  app.patch<{ Params: { id: string }; Body: { title?: unknown } }>(
    "/api/chats/:id",
    async (request) => {
      const { userId } = await resolveUser(request)
      const raw = request.body?.title
      if (typeof raw !== "string") {
        const err = new Error("Campo title é obrigatório (string).")
        ;(err as Error & { statusCode: number }).statusCode = 400
        throw err
      }
      const title = raw.trim()
      if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
        const err = new Error(
          `title deve ter entre ${TITLE_MIN} e ${TITLE_MAX} caracteres.`,
        )
        ;(err as Error & { statusCode: number }).statusCode = 400
        throw err
      }

      const updated = await renameChat(request.params.id, userId, title)
      if (!updated) {
        throw new NotFoundError("Conversa não encontrada.")
      }
      return updated
    },
  )

  app.delete<{ Params: { id: string } }>("/api/chats/:id", async (request, reply) => {
    const { userId } = await resolveUser(request)
    const ok = await deleteChat(request.params.id, userId)
    if (!ok) {
      throw new NotFoundError("Conversa não encontrada.")
    }
    return reply.code(204).send()
  })
}
