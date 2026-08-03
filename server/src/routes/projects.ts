/**
 * CRUD de projetos e arquivos:
 * GET/POST /api/projects
 * GET/PATCH/DELETE /api/projects/:id
 * GET/POST /api/projects/:id/files
 * DELETE /api/projects/:id/files/:fileId
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { NotFoundError, resolveUser } from "../services/auth.js"
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  getProject,
  listProjectFiles,
  listProjects,
  updateProject,
  uploadProjectFile,
} from "../services/project-store.js"

const NAME_MIN = 1
const NAME_MAX = 120
const INSTRUCTIONS_MAX = 32_000

const createBodySchema = z.object({
  name: z.string().trim().min(NAME_MIN).max(NAME_MAX),
  instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
  color: z.string().trim().max(32).nullable().optional(),
  icon: z.string().trim().max(64).nullable().optional(),
})

const patchBodySchema = z
  .object({
    name: z.string().trim().min(NAME_MIN).max(NAME_MAX).optional(),
    instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
    color: z.string().trim().max(32).nullable().optional(),
    icon: z.string().trim().max(64).nullable().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.instructions !== undefined ||
      b.color !== undefined ||
      b.icon !== undefined,
    { message: "Informe ao menos um campo para atualizar." },
  )

const uploadBodySchema = z.object({
  name: z.string().trim().min(1).max(260),
  mimeType: z.string().trim().max(120).optional(),
  dataBase64: z.string().min(1),
})

function badRequest(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { statusCode: number }).statusCode = 400
  return err
}

export default async function projectsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/projects", async (request) => {
    const { userId } = await resolveUser(request)
    return listProjects(userId)
  })

  app.post("/api/projects", async (request, reply) => {
    const { userId } = await resolveUser(request)
    const parsed = createBodySchema.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Body inválido.")
    }
    const created = await createProject({
      userId,
      name: parsed.data.name,
      instructions: parsed.data.instructions,
      color: parsed.data.color,
      icon: parsed.data.icon,
    })
    return reply.code(201).send(created)
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const { userId } = await resolveUser(request)
    return getProject(request.params.id, userId)
  })

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const { userId } = await resolveUser(request)
    const parsed = patchBodySchema.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Body inválido.")
    }
    return updateProject(request.params.id, userId, parsed.data)
  })

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      const ok = await deleteProject(request.params.id, userId)
      if (!ok) throw new NotFoundError("Projeto não encontrado.")
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/files",
    async (request) => {
      const { userId } = await resolveUser(request)
      return listProjectFiles(request.params.id, userId)
    },
  )

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/files",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      const parsed = uploadBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? "Body inválido.")
      }
      // Limite bruto ~14MB base64 ≈ 10MB binário
      if (parsed.data.dataBase64.length > 14_000_000) {
        throw badRequest("Arquivo muito grande (máx. 10 MB).")
      }
      const file = await uploadProjectFile({
        projectId: request.params.id,
        userId,
        name: parsed.data.name,
        mimeType: parsed.data.mimeType,
        dataBase64: parsed.data.dataBase64,
      })
      return reply.code(201).send(file)
    },
  )

  app.delete<{ Params: { id: string; fileId: string } }>(
    "/api/projects/:id/files/:fileId",
    async (request, reply) => {
      const { userId } = await resolveUser(request)
      const ok = await deleteProjectFile(
        request.params.id,
        request.params.fileId,
        userId,
      )
      if (!ok) throw new NotFoundError("Arquivo não encontrado.")
      return reply.code(204).send()
    },
  )
}
