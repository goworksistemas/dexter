/**
 * Workflows agendados do usuário:
 * GET/POST /api/workflows
 * PATCH/DELETE /api/workflows/:id
 * POST /api/workflows/:id/run      (dispara agora, em background)
 * GET /api/workflows/:id/runs      (histórico de execuções)
 *
 * Ownership sempre por user_id — workflow de outro dono responde 404.
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import {
  DEFAULT_TIMEZONE,
  isSupportedTimezone,
  scheduleSchema,
} from "../lib/schedule.js"
import { NotFoundError, resolveUser } from "../services/auth.js"
import { startManualRun } from "../services/workflow-runner.js"
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listRuns,
  listWorkflows,
  updateWorkflow,
} from "../services/workflow-store.js"

const NAME_MAX = 120
const DESCRIPTION_MAX = 500
/** Espelha a constraint agent_workflows_prompt_len. */
const PROMPT_MAX = 8_000
const MODEL_ID_MAX = 120

const nameSchema = z
  .string()
  .trim()
  .min(1, "Informe um nome para o workflow.")
  .max(NAME_MAX, `O nome deve ter no máximo ${NAME_MAX} caracteres.`)

/** O front manda `null` para "sem descrição" — vira string vazia no banco. */
const descriptionSchema = z
  .string()
  .trim()
  .max(
    DESCRIPTION_MAX,
    `A descrição deve ter no máximo ${DESCRIPTION_MAX} caracteres.`,
  )
  .nullable()
  .transform((v) => v ?? "")

const promptSchema = z
  .string()
  .trim()
  .min(1, "Informe as instruções que o Dexter deve executar.")
  .max(
    PROMPT_MAX,
    `As instruções devem ter no máximo ${PROMPT_MAX} caracteres.`,
  )

const timezoneSchema = z
  .string()
  .trim()
  .refine(isSupportedTimezone, {
    message: `Fuso não suportado. Use ${DEFAULT_TIMEZONE} (ou outro fuso do Brasil / UTC).`,
  })

const modelIdSchema = z
  .string()
  .trim()
  .min(1, "model_id não pode ser vazio.")
  .max(MODEL_ID_MAX, "model_id inválido.")
  .nullable()

const createBodySchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema.optional(),
  prompt: promptSchema,
  schedule: scheduleSchema,
  timezone: timezoneSchema.optional(),
  enabled: z.boolean().optional(),
  model_id: modelIdSchema.optional(),
})

const patchBodySchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    prompt: promptSchema.optional(),
    schedule: scheduleSchema.optional(),
    timezone: timezoneSchema.optional(),
    enabled: z.boolean().optional(),
    model_id: modelIdSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "Informe ao menos um campo para atualizar.",
  })

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

export default async function workflowsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api/workflows", async (request) => {
    const { userId } = await resolveUser(request)
    return { workflows: await listWorkflows(userId) }
  })

  app.post("/api/workflows", async (request, reply) => {
    const { userId } = await resolveUser(request)
    const parsed = createBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Body inválido.")
    }
    const workflow = await createWorkflow({
      userId,
      name: parsed.data.name,
      description: parsed.data.description,
      prompt: parsed.data.prompt,
      schedule: parsed.data.schedule,
      timezone: parsed.data.timezone,
      enabled: parsed.data.enabled,
      modelId: parsed.data.model_id,
    })
    return reply.code(201).send({ workflow })
  })

  app.patch<{ Params: { id: string } }>(
    "/api/workflows/:id",
    async (request) => {
      const { userId } = await resolveUser(request)
      const parsed = patchBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? "Body inválido.")
      }
      const workflow = await updateWorkflow(request.params.id, userId, {
        name: parsed.data.name,
        description: parsed.data.description,
        prompt: parsed.data.prompt,
        schedule: parsed.data.schedule,
        timezone: parsed.data.timezone,
        enabled: parsed.data.enabled,
        modelId: parsed.data.model_id,
      })
      return { workflow }
    },
  )

  app.delete<{ Params: { id: string } }>(
    "/api/workflows/:id",
    async (request) => {
      const { userId } = await resolveUser(request)
      const ok = await deleteWorkflow(request.params.id, userId)
      if (!ok) throw new NotFoundError("Workflow não encontrado.")
      return { ok: true }
    },
  )

  /**
   * Executa agora: abre a run e responde na hora — a execução segue em
   * background (pode levar minutos). O front acompanha por GET .../runs.
   */
  app.post<{ Params: { id: string } }>(
    "/api/workflows/:id/run",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      const workflow = await getWorkflow(request.params.id, userId)
      if (!workflow) throw new NotFoundError("Workflow não encontrado.")
      const run = await startManualRun(workflow)
      return reply.code(202).send({ run })
    },
  )

  app.get<{ Params: { id: string } }>(
    "/api/workflows/:id/runs",
    async (request) => {
      const { userId } = await resolveUser(request)
      const workflow = await getWorkflow(request.params.id, userId)
      if (!workflow) throw new NotFoundError("Workflow não encontrado.")
      return { runs: await listRuns(workflow.id, userId) }
    },
  )
}
