/**
 * Rotas de administração do Dexter.
 */
import type { FastifyPluginAsync } from "fastify"
import { z } from "zod"

import {
  assertStaff,
  fetchAdminCostCenter,
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
  type ModelCostTier,
} from "../services/model-store.js"
import {
  listProviderMeta,
  patchProviderMeta,
  type ProviderCreditStatus,
} from "../services/provider-meta-store.js"
import {
  backfillMessageCosts,
  listModelPricing,
  upsertModelPricing,
} from "../services/model-pricing.js"
import {
  invalidatePricingSyncCache,
  syncCatalogPricing,
} from "../services/pricing-sync.js"
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
import {
  deleteProviderKey,
  deleteUserKey,
  isKeyProvider,
  keyManagementEnabled,
  listProviderKeysAdmin,
  listUserKeys,
  saveProviderKey,
  saveUserKey,
} from "../services/llm-keys.js"
import { invalidateModelAccessCache } from "../services/model-access.js"
import { resolveUser } from "../services/auth.js"
import { NotFoundError } from "../services/errors.js"

const patchSchema = z
  .object({
    role: z.enum(["user", "admin", "master"]).optional(),
    disabled: z.boolean().optional(),
    /** null = todos os modelos habilitados; array = só estes ids. */
    allowed_models: z
      .array(z.string().min(1).max(200))
      .max(500)
      .nullable()
      .optional(),
    usage_budget_usd: z.number().min(0).max(1_000_000).nullable().optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.disabled !== undefined ||
      v.allowed_models !== undefined ||
      v.usage_budget_usd !== undefined,
    { message: "Informe role, disabled, allowed_models e/ou usage_budget_usd." },
  )

const daysSchema = z.coerce.number().int().min(1).max(365).default(30)

const modelPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    label: z.string().min(1).max(120).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    sort_order: z.number().int().min(0).max(10_000).nullable().optional(),
    cost_tier: z
      .enum(["free", "cheap", "standard", "premium"])
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo.",
  })

const providerPatchSchema = z
  .strictObject({
    label: z.string().min(1).max(80).optional(),
    default_cost_tier: z
      .enum(["free", "cheap", "standard", "premium"])
      .nullable()
      .optional(),
    credit_status: z
      .enum(["available", "low", "depleted", "unknown"])
      .optional(),
    balance_usd: z.number().min(0).max(10_000_000).nullable().optional(),
    low_threshold_usd: z.number().min(0).max(10_000_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo.",
  })

const pricingPatchSchema = z.strictObject({
  input_usd_per_million: z.number().min(0).max(10_000).nullable().optional(),
  output_usd_per_million: z.number().min(0).max(10_000).nullable().optional(),
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

  app.get("/api/admin/cost-center", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const q = req.query as { days?: string }
    const days = daysSchema.parse(q.days ?? 30)
    await backfillMessageCosts().catch(() => {})
    const costCenter = await fetchAdminCostCenter(days)
    return { costCenter, actorRole: actor.role as DexterRole }
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
      if (body.allowed_models !== undefined) {
        invalidateModelAccessCache(req.params.id)
      }
      return { user: updated }
    },
  )

  app.get<{ Querystring: { probe?: string } }>(
    "/api/admin/models",
    async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const force =
      req.query.probe === "1" || req.query.probe === "true"
    const models = await listAllDiscoveredModels(force)
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
        input_usd_per_million: m.inputUsdPerMillion ?? null,
        output_usd_per_million: m.outputUsdPerMillion ?? null,
        provider_label: m.providerLabel,
      })),
      providers: await providerStatus(),
      provider_meta: (await listProviderMeta()).map((p) => ({
        id: p.id,
        label: p.label,
        default_cost_tier: p.default_cost_tier,
        credit_status: p.credit_status,
        balance_usd: p.balance_usd,
        low_threshold_usd: p.low_threshold_usd,
      })),
      actorRole: actor.role as DexterRole,
    }
  })

  app.get("/api/admin/providers", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    return {
      providers: await listProviderMeta(),
      actorRole: actor.role as DexterRole,
    }
  })

  app.patch<{ Params: { id: string } }>(
    "/api/admin/providers/:id",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const body = providerPatchSchema.parse(req.body)
      const updated = await patchProviderMeta(req.params.id, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.default_cost_tier !== undefined
          ? { default_cost_tier: body.default_cost_tier as ModelCostTier | null }
          : {}),
        ...(body.credit_status !== undefined
          ? { credit_status: body.credit_status as ProviderCreditStatus }
          : {}),
        ...(body.balance_usd !== undefined
          ? { balance_usd: body.balance_usd }
          : {}),
        ...(body.low_threshold_usd !== undefined
          ? { low_threshold_usd: body.low_threshold_usd }
          : {}),
      })
      invalidateModelProbeCache()
      return { provider: updated, actorRole: actor.role as DexterRole }
    },
  )

  app.get("/api/admin/pricing", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    return {
      pricing: await listModelPricing(),
      actorRole: actor.role as DexterRole,
    }
  })

  app.patch<{ Params: { id: string } }>(
    "/api/admin/pricing/:id",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const body = pricingPatchSchema.parse(req.body)
      const updated = await upsertModelPricing(req.params.id, body)
      return { pricing: updated, actorRole: actor.role as DexterRole }
    },
  )

  app.post("/api/admin/pricing/sync", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    invalidatePricingSyncCache()
    invalidateModelProbeCache()
    const models = await listAllDiscoveredModels(true)
    const result = await syncCatalogPricing(
      models
        .filter((m) => m.enabled !== false)
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          model: m.model,
        })),
    )
    const backfilled = await backfillMessageCosts().catch(() => 0)
    return { ...result, backfilled, actorRole: actor.role as DexterRole }
  })

  // --- Chaves de API globais dos provedores (banco, cifradas) ---------------

  app.get("/api/admin/provider-keys", async (req) => {
    const user = await resolveUser(req)
    const actor = await loadActorProfile(user.userId, user.email)
    await assertStaff(actor)
    const result = await listProviderKeysAdmin()
    return { ...result, actorRole: actor.role as DexterRole }
  })

  const providerKeySchema = z.object({
    key: z.string().trim().min(8, "Chave muito curta.").max(400),
  })

  app.put<{ Params: { provider: string } }>(
    "/api/admin/provider-keys/:provider",
    async (req, reply) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      if (!keyManagementEnabled()) {
        reply.code(503)
        return {
          message:
            "Defina USER_API_KEYS_SECRET no ambiente do AgentCore para gerenciar chaves pelo painel.",
        }
      }
      const provider = req.params.provider
      if (!isKeyProvider(provider)) {
        throw new NotFoundError("Provedor desconhecido.")
      }
      const body = providerKeySchema.parse(req.body)
      const key = await saveProviderKey(provider, body.key, actor.id)
      // Catálogo muda junto com a chave (novos modelos aparecem/somem).
      invalidateModelProbeCache()
      return { key }
    },
  )

  app.delete<{ Params: { provider: string } }>(
    "/api/admin/provider-keys/:provider",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const provider = req.params.provider
      if (!isKeyProvider(provider)) {
        throw new NotFoundError("Provedor desconhecido.")
      }
      await deleteProviderKey(provider)
      invalidateModelProbeCache()
      return { ok: true }
    },
  )

  // --- Chaves DEDICADAS por usuário (atribuídas pelo admin) -----------------
  // Mesma tabela do BYOK (agent_user_api_keys): a chave que o admin dedica ao
  // usuário é exatamente a que ele usaria se cadastrasse a própria.

  app.get<{ Params: { id: string } }>(
    "/api/admin/users/:id/keys",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      if (!keyManagementEnabled()) return { enabled: false, keys: [] }
      const keys = await listUserKeys(req.params.id)
      return { enabled: true, keys }
    },
  )

  app.put<{ Params: { id: string; provider: string } }>(
    "/api/admin/users/:id/keys/:provider",
    async (req, reply) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      if (!keyManagementEnabled()) {
        reply.code(503)
        return {
          message:
            "Defina USER_API_KEYS_SECRET no ambiente do AgentCore para gerenciar chaves pelo painel.",
        }
      }
      const provider = req.params.provider
      if (!isKeyProvider(provider)) {
        throw new NotFoundError("Provedor desconhecido.")
      }
      const body = providerKeySchema.parse(req.body)
      const key = await saveUserKey(req.params.id, provider, body.key)
      return { key }
    },
  )

  app.delete<{ Params: { id: string; provider: string } }>(
    "/api/admin/users/:id/keys/:provider",
    async (req) => {
      const user = await resolveUser(req)
      const actor = await loadActorProfile(user.userId, user.email)
      await assertStaff(actor)
      const provider = req.params.provider
      if (!isKeyProvider(provider)) {
        throw new NotFoundError("Provedor desconhecido.")
      }
      await deleteUserKey(req.params.id, provider)
      return { ok: true }
    },
  )

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
          input_usd_per_million: live?.inputUsdPerMillion ?? null,
          output_usd_per_million: live?.outputUsdPerMillion ?? null,
          provider_label: live?.providerLabel ?? live?.provider ?? "",
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
