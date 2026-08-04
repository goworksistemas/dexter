/**
 * Entry point do AgentCore — servidor Fastify (Node 22, ESM).
 */
import { randomUUID } from "node:crypto"

import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import Fastify from "fastify"
import { ZodError } from "zod"

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
import userKeysRoutes from "./routes/user-keys.js"
import shareRoutes from "./routes/share.js"
import workflowsRoutes from "./routes/workflows.js"
import { AuthError, ForbiddenError, NotFoundError } from "./services/auth.js"
import {
  startWorkflowRunner,
  stopWorkflowRunner,
} from "./services/workflow-runner.js"

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
  // Body/query fora do schema (rotas que usam .parse) → 400, mesmo formato de
  // /api/chat, em vez de 500 com o JSON de issues do Zod.
  if (error instanceof ZodError) {
    request.log.warn({ err: error }, "requisição inválida")
    reply
      .code(400)
      .send({ error: "invalid_request", details: error.flatten() })
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
  // 5xx: mensagem interna (SQL/PostgREST/Supabase) NÃO vaza para o cliente —
  // fica só no log, com o traceId para correlacionar.
  if (statusCode >= 500) {
    reply.code(statusCode).send({
      error: "internal_error",
      message: "Erro interno. Tente novamente.",
      traceId: request.traceId,
    })
    return
  }
  reply.code(statusCode).send({
    error: "request_error",
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
await app.register(shareRoutes)
await app.register(projectsRoutes)
await app.register(connectionsRoutes)
await app.register(connectorsRoutes)
await app.register(modelsRoutes)
await app.register(transcribeRoutes)
await app.register(userKeysRoutes)
await app.register(workflowsRoutes)
await app.register(adminRoutes)

// Agendador dos workflows: para o timer junto com o servidor (SIGINT/SIGTERM).
app.addHook("onClose", async () => {
  stopWorkflowRunner()
})

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: config.HOST })
    for (const line of connectorsBootSummary()) {
      app.log.info(`[connectors] ${line}`)
    }
    // Sem service role não há como executar workflow (escrita bypassa RLS).
    if (config.SUPABASE_SERVICE_ROLE_KEY) {
      startWorkflowRunner()
    } else {
      app.log.warn("[workflows] agendador desligado — sem SUPABASE_SERVICE_ROLE_KEY")
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
