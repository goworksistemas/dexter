/**
 * Resolução de usuário a partir do request.
 * - Sem Authorization: só permite DEV_USER_ID quando ALLOW_DEV_USER=true
 *   (dev local). Em produção o default é rejeitar (401).
 * - JWT inválido/expirado: sempre 401 (não mascara com DEV_USER_ID).
 */
import type { FastifyRequest } from "fastify"

import { config } from "../config.js"
import { supabase } from "../lib/supabase.js"

export interface ResolvedUser {
  userId: string
}

export class AuthError extends Error {
  statusCode = 401

  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

export class ForbiddenError extends Error {
  statusCode = 403

  constructor(message: string) {
    super(message)
    this.name = "ForbiddenError"
  }
}

export class NotFoundError extends Error {
  statusCode = 404

  constructor(message: string) {
    super(message)
    this.name = "NotFoundError"
  }
}

/** Extrai o token Bearer do header Authorization, se houver. */
function extractBearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization
  if (!header) return undefined
  const [scheme, token] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined
  return token
}

/** Resolve o usuário autenticado do request. */
export async function resolveUser(req: FastifyRequest): Promise<ResolvedUser> {
  const token = extractBearerToken(req)

  if (!token) {
    if (config.ALLOW_DEV_USER) {
      return { userId: config.DEV_USER_ID }
    }
    throw new AuthError("Não autorizado. Faça login e envie o JWT do Supabase.")
  }

  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      req.log.warn({ err: error }, "JWT inválido/expirado")
      throw new AuthError("Sessão inválida ou expirada.")
    }
    return { userId: data.user.id }
  } catch (err) {
    if (err instanceof AuthError) throw err
    req.log.warn({ err }, "Falha ao validar JWT no Supabase")
    throw new AuthError("Falha ao validar autenticação.")
  }
}
