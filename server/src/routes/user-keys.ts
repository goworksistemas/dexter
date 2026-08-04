/**
 * /api/user-keys — chaves de API pessoais (BYOK) do usuário logado.
 * Contrato com o front: web/src/lib/user-keys/api.ts.
 * A chave nunca volta ao cliente — só provider + last4 + updated_at.
 */
import type { FastifyPluginAsync } from "fastify"
import { z } from "zod"

import {
  deleteUserKey,
  isKeyProvider,
  keyManagementEnabled,
  listUserKeys,
  saveUserKey,
  type KeyProvider,
} from "../services/llm-keys.js"
import { resolveUser } from "../services/auth.js"
import { NotFoundError } from "../services/errors.js"

const putSchema = z.object({
  key: z
    .string()
    .trim()
    .min(8, "Chave muito curta.")
    .max(400, "Chave muito longa."),
})

function parseProvider(raw: string): KeyProvider {
  if (!isKeyProvider(raw)) {
    throw new NotFoundError(
      "Provedor desconhecido. Use anthropic, openai, gemini, deepseek ou xai.",
    )
  }
  return raw
}

const userKeysRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/user-keys", async (req) => {
    const user = await resolveUser(req)
    if (!keyManagementEnabled()) return { enabled: false, keys: [] }
    const keys = await listUserKeys(user.userId)
    return { enabled: true, keys }
  })

  app.put<{ Params: { provider: string } }>(
    "/api/user-keys/:provider",
    async (req, reply) => {
      const user = await resolveUser(req)
      if (!keyManagementEnabled()) {
        reply.code(503)
        return {
          message:
            "Gestão de chaves desabilitada no servidor (USER_API_KEYS_SECRET ausente).",
        }
      }
      const provider = parseProvider(req.params.provider)
      const body = putSchema.parse(req.body)
      const key = await saveUserKey(user.userId, provider, body.key)
      return { key }
    },
  )

  app.delete<{ Params: { provider: string } }>(
    "/api/user-keys/:provider",
    async (req) => {
      const user = await resolveUser(req)
      const provider = parseProvider(req.params.provider)
      await deleteUserKey(user.userId, provider)
      return { ok: true }
    },
  )
}

export default userKeysRoutes
