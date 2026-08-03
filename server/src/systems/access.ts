/**
 * Preflight de acesso: dado o email (verificado) do usuário do Dexter, resolve
 * em paralelo o `dexter_whoami` de todos os sistemas configurados e monta o
 * mapa "o que esse usuário acessa". Cache curto em memória por email.
 *
 * Este mapa alimenta (a) o system prompt (o Dexter só oferece o que ele pode)
 * e (b) o gate das tools (não deixa consultar sistema fora do mapa).
 */
import { configuredSystems } from "./registry.js"
import { systemWhoami, type WhoamiResult } from "./client.js"

export interface SystemAccess {
  slug: string
  label: string
  access: WhoamiResult
}

export type ConnectionStatus = "connected" | "no_access" | "unavailable"

export interface ConnectionInfo {
  slug: string
  label: string
  status: ConnectionStatus
  /** Metadados seguros do whoami (sem secrets). */
  role?: string
  fullName?: string
  email?: string
}

const TTL_MS = 60_000
const cache = new Map<string, { at: number; data: SystemAccess[] }>()
const connectionsCache = new Map<string, { at: number; data: ConnectionInfo[] }>()

function pickDisplay(access: WhoamiResult): Pick<ConnectionInfo, "role" | "fullName" | "email"> {
  const role =
    typeof access.platform_role === "string"
      ? access.platform_role
      : typeof access.role === "string"
        ? access.role
        : undefined
  const fullName =
    typeof access.full_name === "string" ? access.full_name : undefined
  const email = typeof access.email === "string" ? access.email : undefined
  return { role, fullName, email }
}

/** Lista todos os sistemas configurados com status de conexão do usuário. */
export async function listConnections(email?: string): Promise<ConnectionInfo[]> {
  const systems = configuredSystems()
  if (systems.length === 0) return []

  if (!email) {
    return systems.map((s) => ({
      slug: s.slug,
      label: s.label,
      status: "unavailable" as const,
    }))
  }

  const cached = connectionsCache.get(email)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data

  const results = await Promise.all(
    systems.map(async (s) => {
      try {
        const access = await systemWhoami(s.slug, email)
        if (access.has_access === true) {
          return {
            slug: s.slug,
            label: s.label,
            status: "connected" as const,
            ...pickDisplay(access),
          }
        }
        return {
          slug: s.slug,
          label: s.label,
          status: "no_access" as const,
        }
      } catch {
        return {
          slug: s.slug,
          label: s.label,
          status: "unavailable" as const,
        }
      }
    }),
  )

  connectionsCache.set(email, { at: Date.now(), data: results })
  return results
}

/** Sistemas em que o usuário (por email) tem acesso (has_access=true). */
export async function resolveAccess(email: string): Promise<SystemAccess[]> {
  const cached = cache.get(email)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data

  const systems = configuredSystems()
  const results = await Promise.all(
    systems.map(async (s) => ({
      slug: s.slug,
      label: s.label,
      access: await systemWhoami(s.slug, email),
    }))
  )
  const allowed = results.filter((r) => r.access.has_access === true)
  cache.set(email, { at: Date.now(), data: allowed })
  return allowed
}

/** Resumo em texto do acesso do usuário — vai no system prompt. */
export function accessSummary(access: SystemAccess[]): string {
  if (access.length === 0) {
    return "Este usuário NÃO tem acesso a nenhum sistema de negócio conectado. Responda que não há dados disponíveis para ele."
  }
  return access
    .map((a) => `- ${a.label} (slug: ${a.slug})`)
    .join("\n")
}

/** true se o usuário pode consultar o sistema (usado no gate das tools). */
export function canAccess(access: SystemAccess[], slug: string): boolean {
  return access.some((a) => a.slug === slug)
}
