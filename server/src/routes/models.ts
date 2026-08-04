/**
 * GET /api/models — catálogo dinâmico (APIs dos providers). Exige login.
 * ?probe=1 força rediscovery (ignora cache ~60s) — só staff, porque dispara
 * chamadas às APIs pagas dos providers (amplificação se ficasse público).
 */
import type { FastifyInstance } from "fastify"

import { probeModels, providerStatus } from "../llm/models.js"
import { isStaffRole, loadActorProfile } from "../services/admin-store.js"
import { resolveUser } from "../services/auth.js"
import {
  defaultModelIdForUser,
  enabledModelsForUser,
} from "../services/model-access.js"

export default async function modelsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Querystring: { probe?: string } }>(
    "/api/models",
    async (request) => {
      const user = await resolveUser(request)

      const pediuProbe =
        request.query.probe === "1" || request.query.probe === "true"
      // Usuário comum: ignora o parâmetro e serve o cache.
      let probe = false
      if (pediuProbe) {
        try {
          const actor = await loadActorProfile(user.userId, user.email)
          probe = isStaffRole(actor.role)
        } catch (err) {
          request.log.warn({ err }, "perfil indisponível — servindo cache")
        }
      }

      // Rediscovery (staff) atualiza o cache; a lista final é sempre a do
      // usuário — só os modelos liberados para ele (profiles.allowed_models).
      if (probe) await probeModels(true)
      const models = await enabledModelsForUser(user)

      return {
        default: await defaultModelIdForUser(user),
        providers: await providerStatus(),
        models: models.map(
          ({
            id,
            label,
            provider,
            description,
            traits,
            capabilities,
            available,
            latencyMs,
            error,
          }) => ({
            id,
            label,
            provider,
            description,
            traits,
            capabilities,
            available,
            ...(latencyMs !== undefined ? { latencyMs } : {}),
            ...(error ? { error } : {}),
          }),
        ),
      }
    },
  )
}
