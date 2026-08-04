/**
 * Resolução de usuário a partir do request.
 * - Sem Authorization: só permite DEV_USER_ID quando ALLOW_DEV_USER=true
 *   (dev local). Em produção o default é rejeitar (401).
 * - JWT inválido/expirado: sempre 401 (não mascara com DEV_USER_ID).
 * - Conta com profiles.disabled_at: 403.
 */
import type { FastifyRequest } from "fastify"

import { config } from "../config.js"
import { assertAllowedEmail } from "../lib/email-domain.js"
import { supabase } from "../lib/supabase.js"
import {
  assertNotDisabled,
  loadActorProfile,
  type DexterRole,
} from "./admin-store.js"
import { AuthError, ForbiddenError, NotFoundError } from "./errors.js"

export { AuthError, ForbiddenError, NotFoundError }
export type { DexterRole }

export interface ResolvedUser {
  userId: string
  /** email verificado (do JWT) — chave de identidade para as RPCs dos sistemas. */
  email?: string
  role?: DexterRole
}

/** Extrai o token Bearer do header Authorization, se houver. */
function extractBearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization
  if (!header) return undefined
  const [scheme, token] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined
  return token
}

const AUTH_CACHE_TTL_MS = 45_000
const authCache = new Map<string, { at: number; user: ResolvedUser }>()

/** Resolve o usuário autenticado do request. */
export async function resolveUser(req: FastifyRequest): Promise<ResolvedUser> {
  const token = extractBearerToken(req)

  if (!token) {
    if (config.ALLOW_DEV_USER) {
      return { userId: config.DEV_USER_ID }
    }
    throw new AuthError("Não autorizado. Faça login e envie o JWT do Supabase.")
  }

  const hit = authCache.get(token)
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL_MS) {
    return hit.user
  }

  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      authCache.delete(token)
      req.log.warn({ err: error }, "JWT inválido/expirado")
      throw new AuthError("Sessão inválida ou expirada.")
    }
    const userId = data.user.id
    const email = data.user.email ?? undefined
    try {
      await assertAllowedEmail(email)
    } catch (domainErr) {
      throw new ForbiddenError(
        domainErr instanceof Error
          ? domainErr.message
          : "E-mail fora do domínio autorizado.",
      )
    }
    const actor = await loadActorProfile(userId, email)
    await assertNotDisabled(actor)
    const user: ResolvedUser = { userId, email, role: actor.role }
    authCache.set(token, { at: Date.now(), user })
    if (authCache.size > 500) {
      const oldest = authCache.keys().next().value
      if (oldest) authCache.delete(oldest)
    }
    return user
  } catch (err) {
    if (err instanceof AuthError) throw err
    if (err instanceof ForbiddenError) throw err
    req.log.warn({ err }, "Falha ao validar JWT no Supabase")
    throw new AuthError("Falha ao validar autenticação.")
  }
}
