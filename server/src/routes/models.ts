/**
 * GET /api/models — catálogo dinâmico (APIs dos providers).
 * ?probe=1 força rediscovery (ignora cache ~60s).
 */
import type { FastifyInstance } from "fastify"

import {
  defaultModelId,
  listModelsWithCredentialFlag,
  probeModels,
  providerStatus,
} from "../llm/models.js"

export default async function modelsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Querystring: { probe?: string } }>(
    "/api/models",
    async (request) => {
      const probe =
        request.query.probe === "1" || request.query.probe === "true"

      const models = probe
        ? await probeModels(true)
        : await listModelsWithCredentialFlag()

      return {
        default: await defaultModelId(),
        providers: providerStatus(),
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
