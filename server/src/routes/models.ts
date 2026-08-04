/**
 * GET /api/models — catálogo dinâmico (APIs dos providers). Exige login.
 */
import type { FastifyInstance } from "fastify"

import { keySourceForProvider } from "../llm/model-catalog-meta.js"
import { probeModels, providerStatus } from "../llm/models.js"
import { isStaffRole, loadActorProfile } from "../services/admin-store.js"
import { resolveUser } from "../services/auth.js"
import { listUserKeys, type KeyProvider } from "../services/llm-keys.js"
import {
  defaultModelIdForUser,
  enabledModelsForUser,
} from "../services/model-access.js"
import {
  buildModelCreditContext,
  modelIsAvailableWithCredit,
} from "../services/provider-credit.js"

export default async function modelsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Querystring: { probe?: string } }>(
    "/api/models",
    async (request) => {
      const user = await resolveUser(request)

      const pediuProbe =
        request.query.probe === "1" || request.query.probe === "true"
      let probe = false
      if (pediuProbe) {
        try {
          const actor = await loadActorProfile(user.userId, user.email)
          probe = isStaffRole(actor.role)
        } catch (err) {
          request.log.warn({ err }, "perfil indisponível — servindo cache")
        }
      }

      if (probe) await probeModels(true)
      const [allModels, userKeys] = await Promise.all([
        enabledModelsForUser(user),
        listUserKeys(user.userId).catch(() => []),
      ])

      const personalProviders = new Set<KeyProvider>(
        userKeys.map((k) => k.provider),
      )
      const creditCtx = await buildModelCreditContext(
        user.userId,
        personalProviders,
      )
      const models = allModels.filter((m) =>
        modelIsAvailableWithCredit(creditCtx, m.provider),
      )
      const keyLast4ByProvider = Object.fromEntries(
        userKeys.map((k) => [k.provider, k.last4]),
      ) as Partial<Record<KeyProvider, string>>
      const defaultModelId = await defaultModelIdForUser(user)

      return {
        default:
          models.find((m) => m.id === defaultModelId)?.id ??
          models[0]?.id ??
          "",
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
            inputTokenLimit,
            maxOutputTokens,
            providerLabel,
            inputUsdPerMillion,
            outputUsdPerMillion,
            releasedAt,
          }) => {
            const keySource = keySourceForProvider(provider, personalProviders)
            return {
              id,
              label,
              provider,
              providerLabel,
              description,
              traits,
              capabilities,
              available,
              ...(inputUsdPerMillion != null
                ? { inputUsdPerMillion }
                : {}),
              ...(outputUsdPerMillion != null
                ? { outputUsdPerMillion }
                : {}),
              ...(inputTokenLimit != null ? { inputTokenLimit } : {}),
              ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
              ...(releasedAt ? { releasedAt } : {}),
              ...(latencyMs !== undefined ? { latencyMs } : {}),
              ...(error ? { error } : {}),
              keySource,
              ...(keySource === "personal"
                ? { keyLast4: keyLast4ByProvider[provider as KeyProvider] }
                : {}),
            }
          },
        ),
      }
    },
  )
}
