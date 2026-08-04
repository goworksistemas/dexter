/**
 * Conectores Notion/Outlook — status, preferência, OAuth connect/callback/disconnect.
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import {
  buildConnectUrl,
  handleOAuthCallback,
  microsoftOAuthConfigured,
} from "../connectors/oauth.js"
import { connectorConfigured } from "../connectors/registry.js"
import {
  loadConnectorPreferences,
  saveConnectorPreferences,
} from "../connectors/prefs.js"
import { resolveConnectorRuntime } from "../connectors/status.js"
import {
  logConnectorEvent,
  revokeConnector,
} from "../connectors/store.js"
import type { ConnectorId } from "../connectors/types.js"
import { resolveUser } from "../services/auth.js"

const patchSchema = z.object({
  notion: z.boolean().optional(),
  outlook: z.boolean().optional(),
})

const providerSchema = z.enum(["notion", "outlook"])

export default async function connectorsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api/connectors", async (request) => {
    const { userId } = await resolveUser(request)
    const runtime = await resolveConnectorRuntime(userId)
    return {
      connectors: runtime.statuses,
      preferences: runtime.prefs,
    }
  })

  app.patch("/api/connectors", async (request, reply) => {
    const { userId } = await resolveUser(request)
    const parsed = patchSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      })
      return
    }
    if (
      typeof parsed.data.notion !== "boolean" &&
      typeof parsed.data.outlook !== "boolean"
    ) {
      reply.code(400).send({
        error: "invalid_request",
        message: "Informe notion e/ou outlook (boolean).",
      })
      return
    }

    const runtime = await resolveConnectorRuntime(userId)
    for (const id of ["notion", "outlook"] as const) {
      if (parsed.data[id] === true) {
        const st = runtime.statuses.find((s) => s.id === id)
        if (!st?.connected) {
          reply.code(400).send({
            error: "not_connected",
            message: `Conecte sua conta ${st?.label ?? id} antes de ligar o conector.`,
          })
          return
        }
      }
    }

    await saveConnectorPreferences(userId, parsed.data)
    const next = await resolveConnectorRuntime(userId)
    return {
      connectors: next.statuses,
      preferences: await loadConnectorPreferences(userId),
    }
  })

  app.get<{
    Params: { provider: string }
    Querystring: { return_to?: string }
  }>("/api/connectors/:provider/connect", async (request, reply) => {
    const providerParsed = providerSchema.safeParse(request.params.provider)
    if (!providerParsed.success) {
      reply.code(404).send({ error: "not_found", message: "provider inválido" })
      return
    }
    const provider = providerParsed.data as ConnectorId
    const { userId } = await resolveUser(request)

    if (!connectorConfigured(provider)) {
      const hint =
        provider === "outlook" && !microsoftOAuthConfigured()
          ? "Outlook indisponível: cadastre MICROSOFT_CLIENT_ID/SECRET/TENANT_ID no Infisical e rode `pnpm dev`."
          : "Conector indisponível neste ambiente."
      reply.code(503).send({
        error: "not_configured",
        message: hint,
      })
      return
    }

    try {
      const url = await buildConnectUrl({
        userId,
        provider,
        returnTo: request.query.return_to,
      })
      return { url, provider }
    } catch (err) {
      reply.code(500).send({
        error: "oauth_error",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  app.get<{
    Params: { provider: string }
    Querystring: {
      code?: string
      state?: string
      error?: string
      error_description?: string
    }
  }>("/api/connectors/:provider/callback", async (request, reply) => {
    const providerParsed = providerSchema.safeParse(request.params.provider)
    if (!providerParsed.success) {
      reply.code(404).send("provider inválido")
      return
    }
    const provider = providerParsed.data as ConnectorId
    const redirectTo = await handleOAuthCallback({
      provider,
      code: request.query.code,
      state: request.query.state,
      oauthError:
        request.query.error_description ?? request.query.error ?? undefined,
    })
    return reply.redirect(redirectTo)
  })

  app.delete<{ Params: { provider: string } }>(
    "/api/connectors/:provider",
    async (request, reply) => {
      const providerParsed = providerSchema.safeParse(request.params.provider)
      if (!providerParsed.success) {
        reply.code(404).send({ error: "not_found", message: "provider inválido" })
        return
      }
      const provider = providerParsed.data as ConnectorId
      const { userId } = await resolveUser(request)

      await revokeConnector(userId, provider)
      await saveConnectorPreferences(userId, { [provider]: false })
      await logConnectorEvent({
        userId,
        provider,
        event: "disconnect",
      })

      const runtime = await resolveConnectorRuntime(userId)
      return {
        connectors: runtime.statuses,
        preferences: await loadConnectorPreferences(userId),
      }
    },
  )
}
