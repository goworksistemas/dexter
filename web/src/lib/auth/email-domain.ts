/**
 * Validação de domínio no client (UX). A trava real está no Supabase
 * (hook/trigger) e no AgentCore (resolveUser).
 */

const DEFAULT_DOMAINS = ["gowork.com.br"]

function parseDomains(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  return list.length > 0 ? list : DEFAULT_DOMAINS
}

export const ALLOWED_EMAIL_DOMAINS = parseDomains(
  import.meta.env.VITE_ALLOWED_EMAIL_DOMAINS as string | undefined,
)

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

export function isAllowedEmail(email: string | null | undefined): boolean {
  const domain = email ? emailDomainOf(email) : null
  return Boolean(domain && ALLOWED_EMAIL_DOMAINS.includes(domain))
}

export function allowedDomainsLabel(): string {
  return ALLOWED_EMAIL_DOMAINS.map((d) => `@${d}`).join(", ")
}

export function emailDomainErrorMessage(): string {
  return `Somente e-mails ${allowedDomainsLabel()} podem acessar o Dexter.`
}

/** Lança Error se o e-mail não for do domínio autorizado. */
export function assertAllowedEmail(email: string): string {
  const normalized = normalizeEmail(email)
  if (!isAllowedEmail(normalized)) {
    throw new Error(emailDomainErrorMessage())
  }
  return normalized
}
