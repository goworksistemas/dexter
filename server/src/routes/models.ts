/**
 * GET /api/models — modelos para o seletor da interface.
 * ?probe=1 faz ping real nos providers (cache ~30s no server).
 */
import type { FastifyInstance } from "fastify"

import {
  defaultModelId,
  listModelsWithCredentialFlag,
  probeModels,
} from "../llm/models.js"

export default async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { probe?: string } }>("/api/models", async (request) => {
    const probe =
      request.query.probe === "1" ||
      request.query.probe === "true"

    const models = probe
      ? await probeModels()
      : listModelsWithCredentialFlag()

    return {
      default: defaultModelId(),
      models: models.map(({ id, label, provider, available, latencyMs, error }) => ({
        id,
        label,
        provider,
        available,
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(error ? { error } : {}),
      })),
    }
  })
}
