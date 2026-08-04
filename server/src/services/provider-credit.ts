/**
 * Crédito de providers (corporativo + BYOK) e orçamento mensal por usuário.
 */
import { KEY_PROVIDERS, type KeyProvider } from "./llm-keys.js"
import { supabase } from "../lib/supabase.js"
import type { ModelProvider } from "./model-store.js"
import type { ModelKeySource } from "../llm/model-catalog-meta.js"

export type CreditStatus = "available" | "low" | "depleted" | "unknown"

const BILLED = new Set<string>(KEY_PROVIDERS)

export function isQuotaError(message: string): boolean {
  return /insufficient.?quota|quota.?exceeded|billing|credit.?balance|exceeded.*limit|402|429|rate.?limit/i.test(
    message,
  )
}

export async function markUserProviderCredit(
  userId: string,
  provider: KeyProvider,
  status: CreditStatus,
  lastError?: string,
): Promise<void> {
  const { error } = await supabase.from("dexter_user_provider_credit").upsert(
    {
      user_id: userId,
      provider,
      credit_status: status,
      last_error: lastError?.slice(0, 500) ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  )
  if (error) {
    throw new Error(`markUserProviderCredit: ${error.message}`)
  }
}

export async function markGlobalProviderCredit(
  provider: ModelProvider,
  status: CreditStatus,
): Promise<void> {
  const { error } = await supabase
    .from("dexter_providers")
    .update({
      credit_status: status,
      balance_updated_at: new Date().toISOString(),
    })
    .eq("id", provider)
  if (error) throw new Error(`markGlobalProviderCredit: ${error.message}`)
}

export async function recordQuotaError(
  userId: string,
  provider: ModelProvider,
  keySource: ModelKeySource,
  errMsg: string,
): Promise<void> {
  if (!isQuotaError(errMsg)) return
  if (keySource === "personal" && BILLED.has(provider)) {
    await markUserProviderCredit(
      userId,
      provider as KeyProvider,
      "depleted",
      errMsg,
    ).catch(() => {})
    return
  }
  if (keySource === "company") {
    await markGlobalProviderCredit(provider, "depleted").catch(() => {})
  }
}

function monthStartUtc(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

async function userMonthSpendUsd(userId: string): Promise<number> {
  const since = monthStartUtc()
  const { data: chats } = await supabase
    .from("agent_chats")
    .select("id")
    .eq("user_id", userId)
  const chatIds = (chats ?? []).map((c) => String(c.id))
  if (chatIds.length === 0) return 0

  const { data: rows, error } = await supabase
    .from("agent_messages")
    .select("cost_usd")
    .in("chat_id", chatIds)
    .gte("created_at", since)
  if (error) return 0
  let sum = 0
  for (const row of rows ?? []) {
    sum += Number(row.cost_usd ?? 0)
  }
  return sum
}

export interface ModelCreditContext {
  userId: string
  personalProviders: ReadonlySet<KeyProvider>
  budgetOk: boolean
  userProviderStatus: Map<KeyProvider, CreditStatus>
  globalProviderStatus: Map<
    ModelProvider,
    {
      credit_status: CreditStatus
      balance_usd: number | null
    }
  >
}

export async function buildModelCreditContext(
  userId: string,
  personalProviders: ReadonlySet<KeyProvider>,
): Promise<ModelCreditContext> {
  const [budgetRow, spend, userCredits, globalProviders] = await Promise.all([
    supabase
      .from("profiles")
      .select("usage_budget_usd")
      .eq("id", userId)
      .maybeSingle(),
    userMonthSpendUsd(userId),
    supabase
      .from("dexter_user_provider_credit")
      .select("provider, credit_status")
      .eq("user_id", userId),
    supabase
      .from("dexter_providers")
      .select("id, credit_status, balance_usd"),
  ])

  const budget =
    budgetRow.data?.usage_budget_usd != null
      ? Number(budgetRow.data.usage_budget_usd)
      : null
  const budgetOk =
    budget == null || !Number.isFinite(budget) ? true : spend < budget

  const userProviderStatus = new Map<KeyProvider, CreditStatus>()
  for (const row of userCredits.data ?? []) {
    const s = row.credit_status as CreditStatus
    if (
      s === "available" ||
      s === "low" ||
      s === "depleted" ||
      s === "unknown"
    ) {
      userProviderStatus.set(row.provider as KeyProvider, s)
    }
  }

  const globalProviderStatus = new Map<
    ModelProvider,
    { credit_status: CreditStatus; balance_usd: number | null }
  >()
  for (const row of globalProviders.data ?? []) {
    const s = row.credit_status as CreditStatus
    globalProviderStatus.set(row.id as ModelProvider, {
      credit_status:
        s === "available" ||
        s === "low" ||
        s === "depleted" ||
        s === "unknown"
          ? s
          : "unknown",
      balance_usd:
        row.balance_usd != null ? Number(row.balance_usd) : null,
    })
  }

  return {
    userId,
    personalProviders,
    budgetOk,
    userProviderStatus,
    globalProviderStatus,
  }
}

export function keySourceForModel(
  provider: ModelProvider,
  personalProviders: ReadonlySet<KeyProvider>,
): ModelKeySource {
  if (!BILLED.has(provider)) return "free"
  return personalProviders.has(provider as KeyProvider)
    ? "personal"
    : "company"
}

function providerHasCreditFromCtx(
  ctx: ModelCreditContext,
  provider: ModelProvider,
  keySource: ModelKeySource,
): boolean {
  if (keySource === "free" || !BILLED.has(provider)) return true

  if (keySource === "personal") {
    const st =
      ctx.userProviderStatus.get(provider as KeyProvider) ?? "available"
    return st !== "depleted"
  }

  const g = ctx.globalProviderStatus.get(provider)
  if (g?.credit_status === "depleted") return false
  if (g?.balance_usd != null && g.balance_usd <= 0) return false
  return true
}

export function modelIsAvailableWithCredit(
  ctx: ModelCreditContext,
  provider: ModelProvider,
): boolean {
  if (!ctx.budgetOk && BILLED.has(provider)) return false
  const keySource = keySourceForModel(provider, ctx.personalProviders)
  return providerHasCreditFromCtx(ctx, provider, keySource)
}
