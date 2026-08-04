/**
 * Rotas de administração do Dexter.
 */
import type { FastifyPluginAsync } from "fastify"
import { z } from "zod"

import {
  assertStaff,
  fetchAdminOverview,
  fetchAdminUserDetail,
  listAdminUsers,
  loadActorProfile,
  patchAdminUser,
  type DexterRole,
} from "../services/admin-store.js"
import {
  bulkUpsertModelOverrides,
  upsertModelOverride,
} from "../services/model-store.js"
import {
  createKbDoc,
  deleteKbDoc,
  listKbDocs,
  updateKbDoc,
  KB_CATEGORIES,
} from "../services/kb-store.js"
import {
  invalidateModelProbeCache,
  listAllDiscoveredModels,
  providerStatus,
} from "../llm/models.js"
import { resolveUser } from "../services/auth.js"

const patchSchema = z
  .object({
    role: z.enum(["user", "admin", "master"]).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {
    message: "Informe role e/ou disabled.",
  })

const daysSchema = z.coerce.number().int().min(1).max(365).default(30)

const modelPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    label: z.string().min(1).max(120).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    sort_order: z.number().int().min(0).max(10_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo.",
  })

/** Base de conhecimento: mesmo domínio dos checks da migration 0020. */
const kbSlugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,80}$/,
    "Slug inválido: 2 a 81 caracteres, só minúsculas, números e hífen.",
  )
const kbTitleSchema = z.string().trim().min(1).max(160)
const kbContentSchema = z.string().max(60_000)
const kbCategorySchema = z.enum(KB_CATEGORIES)
const kbSortSchema = z.number().int().min(0).max(10_000)

const kbCreateSchema = z.strictObject({
  slug: kbSlugSchema.optional(),
  title: kbTitleSchema,
  category: kbCategorySchema,
  content: kbContentSchema,
  enabled: z.boolean().optional(),
  always_load: z.boolean().optional(),
  sort: kbSortSchema.optional(),
})

const kbPatchSchema = z
  .strictObject({
    slug: kbSlugSchema.optional(),
    title: kbTitleSchema.optional(),
    category: kbCategorySchema.optional(),
    content: kbContentSchema.optional(),
    enabled: z.boolean().optional(),
    always_load: z.boolean().optional(),
    sort: kbSortSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo.",
  })

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/admin/me", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    return {
      id: actor.id,
      email: actor.email,
      role: actor.role,
      isStaff: actor.role === "admin" || actor.role === "master",
      disabled_at: actor.disabled_at,
    }
  })

  app.get("/api/admin/overview", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const q = req.query as { days?: string }
    const days = daysSchema.parse(q.days ?? 30)
    const overview = await fetchAdminOverview(days)
    return { overview, actorRole: actor.role as DexterRole }
  })

  app.get("/api/admin/users", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const users = await listAdminUsers()
    return { users, actorRole: actor.role as DexterRole }
  })

  app.get<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const q = req.query as { days?: string }
      const days = daysSchema.parse(q.days ?? 30)
      const detail = await fetchAdminUserDetail(req.params.id, days)
      return { detail, actorRole: actor.role as DexterRole }
    },
  )

  app.patch<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const body = patchSchema.parse(req.body)
      const updated = await patchAdminUser(actor, req.params.id, body)
      return { user: updated }
    },
  )

  app.get("/api/admin/models", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const models = await listAllDiscoveredModels(true)
    return {
      models: models.map((m) => ({
        id: m.id,
        provider: m.provider,
        api_model: m.model,
        label: m.label,
        description: m.description,
        traits: m.traits,
        capabilities: m.capabilities,
        enabled: m.enabled,
        is_default: m.isDefault,
        sort_order: m.sortOrder,
        max_output_tokens: m.maxOutputTokens,
        input_token_limit: m.inputTokenLimit ?? null,
        released_at: m.releasedAt ?? null,
        credential_ok: m.credentialOk,
        latency_ms: m.latencyMs ?? null,
      })),
      providers: providerStatus(),
      actorRole: actor.role as DexterRole,
    }
  })

  const bulkSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(500),
    enabled: z.boolean(),
  })

  app.post("/api/admin/models/bulk", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const body = bulkSchema.parse(req.body)
    const count = await bulkUpsertModelOverrides(body.ids, {
      enabled: body.enabled,
    })
    invalidateModelProbeCache()
    return { updated: count, enabled: body.enabled }
  })

  app.patch<{ Params: { id: string } }>(
    "/api/admin/models/:id",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const body = modelPatchSchema.parse(req.body)
      const updated = await upsertModelOverride(req.params.id, body)
      invalidateModelProbeCache()
      const models = await listAllDiscoveredModels(true)
      const live = models.find((m) => m.id === req.params.id)
      return {
        model: {
          id: updated.id,
          provider: live?.provider ?? "openai",
          api_model: live?.model ?? updated.id,
          label: live?.label ?? updated.label ?? updated.id,
          description: live?.description ?? updated.description ?? "",
          traits: live?.traits ?? [],
          capabilities: live?.capabilities,
          enabled: updated.enabled,
          is_default: updated.is_default,
          sort_order: updated.sort_order ?? live?.sortOrder ?? 1000,
          max_output_tokens: live?.maxOutputTokens ?? null,
          input_token_limit: live?.inputTokenLimit ?? null,
          released_at: live?.releasedAt ?? null,
          credential_ok: live?.credentialOk ?? false,
          latency_ms: live?.latencyMs ?? null,
        },
      }
    },
  )

  // Base de conhecimento GoWork (contexto curado do Dexter).
  app.get("/api/admin/kb", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const docs = await listKbDocs()
    return { docs, actorRole: actor.role as DexterRole }
  })

  app.post("/api/admin/kb", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const body = kbCreateSchema.parse(req.body)
    const doc = await createKbDoc(body, actor.id)
    return { doc }
  })

  app.patch<{ Params: { id: string } }>("/api/admin/kb/:id", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const body = kbPatchSchema.parse(req.body)
    const doc = await updateKbDoc(req.params.id, body, actor.id)
    return { doc }
  })

  app.delete<{ Params: { id: string } }>("/api/admin/kb/:id", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    await deleteKbDoc(req.params.id)
    return { ok: true }
  })
}

export default adminRoutes
