/**
 * Entry point do AgentCore — servidor Fastify (Node 22, ESM).
 */
import { randomUUID } from "node:crypto"

import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import Fastify from "fastify"

import { config, corsOrigins } from "./config.js"
import { connectorsBootSummary } from "./connectors/registry.js"
import adminRoutes from "./routes/admin.js"
import chatRoutes from "./routes/chat.js"
import chatsRoutes from "./routes/chats.js"
import connectionsRoutes from "./routes/connections.js"
import connectorsRoutes from "./routes/connectors.js"
import modelsRoutes from "./routes/models.js"
import projectsRoutes from "./routes/projects.js"
import transcribeRoutes from "./routes/transcribe.js"
import { AuthError, ForbiddenError, NotFoundError } from "./services/auth.js"

declare module "fastify" {
  interface FastifyRequest {
    /** trace_id gerado por request — usado em logs e persistido nas mensagens. */
    traceId: string
  }
}

// Anexos (imagem de referência em base64) facilmente passam de 1 MB.
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  bodyLimit: 32 * 1024 * 1024,
})

app.decorateRequest("traceId", "")
app.addHook("onRequest", async (request) => {
  request.traceId = randomUUID()
})

app.setErrorHandler((error, request, reply) => {
  if (error instanceof AuthError) {
    reply.code(error.statusCode).send({ error: "unauthorized", message: error.message })
    return
  }
  if (error instanceof ForbiddenError) {
    reply.code(error.statusCode).send({ error: "forbidden", message: error.message })
    return
  }
  if (error instanceof NotFoundError) {
    reply.code(error.statusCode).send({ error: "not_found", message: error.message })
    return
  }
  request.log.error(error)
  const statusCode =
    typeof error === "object" &&
    error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "internal_error" : "request_error",
    message: error instanceof Error ? error.message : "Erro inesperado",
  })
})

await app.register(cors, { origin: corsOrigins, credentials: true })
await app.register(rateLimit, {
  max: config.RATE_LIMIT_MAX,
  timeWindow: config.RATE_LIMIT_WINDOW,
})

app.get("/healthz", async () => ({ status: "ok" }))

await app.register(chatRoutes)
await app.register(chatsRoutes)
await app.register(projectsRoutes)
await app.register(connectionsRoutes)
await app.register(connectorsRoutes)
await app.register(modelsRoutes)
await app.register(transcribeRoutes)
await app.register(adminRoutes)

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: config.HOST })
    for (const line of connectorsBootSummary()) {
      app.log.info(`[connectors] ${line}`)
    }
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "encerrando AgentCore...")
  try {
    await app.close()
    process.exit(0)
  } catch (err) {
    app.log.error(err, "erro ao encerrar")
    process.exit(1)
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

await start()
