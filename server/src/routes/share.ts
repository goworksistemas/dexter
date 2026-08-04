/**
 * Compartilhamento público de conversas e artefatos.
 *
 * Autenticado: publicar/revogar/consultar status (ownership obrigatório).
 * Anônimo: GET /api/public/* por token UUID (rate limit mais baixo).
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

const tokenSchema = z.string().uuid()

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
