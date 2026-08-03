/**
 * GET /api/connections — sistemas de negócio configurados e status de acesso
 * do usuário autenticado (via dexter_whoami em cada um).
 */
import type { FastifyInstance } from "fastify"

import { resolveUser } from "../services/auth.js"
import { listConnections } from "../systems/access.js"

export default async function connectionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/connections", async (request) => {
    const { email } = await resolveUser(request)
    const connections = await listConnections(email)
    return {
      email: email ?? null,
      connections,
      connectedCount: connections.filter((c) => c.status === "connected").length,
    }
  })
}
