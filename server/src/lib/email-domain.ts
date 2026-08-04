/**
 * Allowlist de domínio de e-mail (defesa no AgentCore).
 * Fonte de verdade no DB: public.dexter_allowed_email_domains.
 * Fallback: ALLOWED_EMAIL_DOMAINS (env / Infisical).
 */
import { config } from "../config.js"
import { supabase } from "./supabase.js"

const CACHE_TTL_MS = 60_000
let cache: { at: number; domains: Set<string> } | null = null

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailDomainOf(email: string): string | null {
  const n = normalizeEmail(email)
  const at = n.lastIndexOf("@")
  if (at <= 0 || at === n.length - 1) return null
  if (n.includes("@", at + 1)) return null
  return n.slice(at + 1)
}

function domainsFromEnv(): Set<string> {
  return new Set(
    config.ALLOWED_EMAIL_DOMAINS.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  )
}

export async function loadAllowedEmailDomains(
  force = false,
): Promise<Set<string>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.domains
  }

  try {
    const { data, error } = await supabase
      .from("dexter_allowed_email_domains")
      .select("domain")
      .eq("enabled", true)

    if (error) throw error
    const domains = new Set(
      (data ?? [])
        .map((r) => String(r.domain ?? "").trim().toLowerCase())
        .filter(Boolean),
    )
    if (domains.size === 0) {
      cache = { at: Date.now(), domains: domainsFromEnv() }
      return cache.domains
    }
    cache = { at: Date.now(), domains }
    return domains
  } catch {
    cache = { at: Date.now(), domains: domainsFromEnv() }
    return cache.domains
  }
}

export async function assertAllowedEmail(email: string | undefined | null) {
  const domains = await loadAllowedEmailDomains()
  const domain = email ? emailDomainOf(email) : null
  if (!domain || !domains.has(domain)) {
    const listed = [...domains].sort().join(", ")
    const err = new Error(
      `Acesso restrito a e-mails corporativos (${listed || "domínio autorizado"}).`,
    )
    ;(err as Error & { code: string }).code = "EMAIL_DOMAIN_FORBIDDEN"
    throw err
  }
}

export function isAllowedEmailSync(
  email: string | undefined | null,
  domains: Set<string>,
): boolean {
  const domain = email ? emailDomainOf(email) : null
  return Boolean(domain && domains.has(domain))
}
