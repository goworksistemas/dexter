/**
 * Compartilhamento de conversas e artefatos.
 *
 * - Colega (chat): invite por e-mail → destinatário cria fork.
 * - Link público: token UUID (anônimo), com aviso de dados internos na UI.
 */
import type { FastifyInstance } from "fastify"
import rateLimit from "@fastify/rate-limit"
import { z } from "zod"

import { NotFoundError, resolveUser } from "../services/auth.js"
import {
  getArtifactShareStatus,
  getChatShareStatus,
  getPublicArtifact,
  getPublicChat,
  publishArtifact,
  publishChat,
  revokeArtifactShare,
  revokeChatShare,
} from "../services/share-store.js"
import {
  forkSharedChat,
  inviteChatShare,
  listChatSharesForOwner,
  listPendingSharesForUser,
  listShareableColleagues,
  revokeUserShare,
} from "../services/share-user-store.js"

const tokenSchema = z.string().uuid()
const inviteBodySchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().email().max(320).optional(),
  })
  .refine((b) => Boolean(b.userId || b.email), {
    message: "Informe userId ou email.",
  })

export default async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/share",
    async (request) => {
      const { userId } = await resolveUser(request)
      return getChatShareStatus(request.params.id, userId)
    },
  )

  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/share",
    async (request) => {
      const { userId } = await resolveUser(request)
      return publishChat(request.params.id, userId)
    },
  )

  app.delete<{ Params: { id: string } }>(
    "/api/chats/:id/share",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      await revokeChatShare(request.params.id, userId)
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/share-users",
    async (request) => {
      const { userId } = await resolveUser(request)
      const shares = await listChatSharesForOwner(request.params.id, userId)
      return { shares }
    },
  )

  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/share-users",
    async (request) => {
      const { userId } = await resolveUser(request)
      const body = inviteBodySchema.parse(request.body)
      const share = await inviteChatShare(request.params.id, userId, {
        userId: body.userId,
        email: body.email,
      })
      return { share }
    },
  )

  app.get("/api/me/colleagues", async (request) => {
    const { userId } = await resolveUser(request)
    const colleagues = await listShareableColleagues(userId)
    return { colleagues }
  })

  app.get("/api/me/chat-shares", async (request) => {
    const { userId } = await resolveUser(request)
    const shares = await listPendingSharesForUser(userId)
    return { shares }
  })

  app.post<{ Params: { shareId: string } }>(
    "/api/me/chat-shares/:shareId/fork",
    async (request) => {
      const { userId } = await resolveUser(request)
      return forkSharedChat(request.params.shareId, userId)
    },
  )

  app.delete<{ Params: { shareId: string } }>(
    "/api/me/chat-shares/:shareId",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      await revokeUserShare(request.params.shareId, userId)
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { id: string } }>(
    "/api/artifacts/:id/share",
    async (request) => {
      const { userId } = await resolveUser(request)
      return getArtifactShareStatus(request.params.id, userId)
    },
  )

  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/share",
    async (request) => {
      const { userId } = await resolveUser(request)
      return publishArtifact(request.params.id, userId)
    },
  )

  app.delete<{ Params: { id: string } }>(
    "/api/artifacts/:id/share",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      await revokeArtifactShare(request.params.id, userId)
      return reply.code(204).send()
    },
  )

  await app.register(
    async (publicApp) => {
      await publicApp.register(rateLimit, {
        max: 40,
        timeWindow: "1 minute",
      })

      publicApp.get<{ Params: { token: string } }>(
        "/api/public/chats/:token",
        async (request) => {
          const parsed = tokenSchema.safeParse(request.params.token)
          if (!parsed.success) {
            throw new NotFoundError("Link inválido.")
          }
          const payload = await getPublicChat(parsed.data)
          if (!payload) {
            throw new NotFoundError("Conversa não encontrada ou link revogado.")
          }
          return payload
        },
      )

      publicApp.get<{ Params: { token: string } }>(
        "/api/public/artifacts/:token",
        async (request) => {
          const parsed = tokenSchema.safeParse(request.params.token)
          if (!parsed.success) {
            throw new NotFoundError("Link inválido.")
          }
          const payload = await getPublicArtifact(parsed.data)
          if (!payload) {
            throw new NotFoundError("Artefato não encontrado ou link revogado.")
          }
          return payload
        },
      )
    },
    { prefix: "" },
  )
}
