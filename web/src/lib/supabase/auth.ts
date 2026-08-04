// Auth helpers — password-based + recovery (docs Supabase Auth / passwords).
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js"

import {
  assertAllowedEmail,
  emailDomainErrorMessage,
} from "@/lib/auth/email-domain"
import type { UserProfile } from "@/types"
import { hasSupabase, requireSupabase, supabase } from "./client"

export function authRedirectTo(path: string): string {
  const base = window.location.origin.replace(/\/$/, "")
  const p = path.startsWith("/") ? path : `/${path}`
  return `${base}${p}`
}

export function mapAuthError(
  error: { message?: string; code?: string } | null,
): string {
  const msg = (error?.message || "").toLowerCase()
  const code = (error?.code || "").toLowerCase()

  if (code.includes("invalid_credentials") || msg.includes("invalid login")) {
    return "E-mail ou senha incorretos."
  }
  if (msg.includes("email not confirmed")) {
    return "Confirme seu e-mail antes de entrar."
  }
  if (
    msg.includes("user already registered") ||
    msg.includes("already been registered")
  ) {
    return "Este e-mail já está cadastrado. Faça login ou recupere a senha."
  }
  if (
    msg.includes("password") &&
    (msg.includes("weak") || msg.includes("least") || msg.includes("short"))
  ) {
    return "A senha precisa ter pelo menos 6 caracteres."
  }
  if (msg.includes("rate limit") || msg.includes("too many")) {
    return "Muitas tentativas. Aguarde um momento e tente de novo."
  }
  if (msg.includes("signup is disabled")) {
    return "Cadastro desabilitado neste ambiente."
  }
  if (
    msg.includes("gowork.com.br") ||
    msg.includes("domínio") ||
    msg.includes("domain") ||
    msg.includes("email domain")
  ) {
    return emailDomainErrorMessage()
  }
  return error?.message || "Não foi possível concluir a autenticação."
}

export function userToProfile(user: User): UserProfile {
  const meta = user.user_metadata ?? {}
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    (user.email ? user.email.split("@")[0] : undefined)
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    undefined

  return {
    id: user.id,
    email: user.email ?? null,
    name,
    avatarUrl,
  }
}

/** JWT de acesso da sessão atual para `Authorization: Bearer` no AgentCore. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) return null
  return data.session.access_token
}

export async function getSession(): Promise<Session | null> {
  if (!supabase) return null
  const { data, error } = await supabase.auth.getSession()
  if (error) return null
  return data.session
}

export function onAuthStateChange(
  cb: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  if (!supabase) return () => {}
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(cb)
  return () => subscription.unsubscribe()
}

export async function signInWithPassword(email: string, password: string) {
  const allowed = assertAllowedEmail(email)
  const client = requireSupabase()
  const { data, error } = await client.auth.signInWithPassword({
    email: allowed,
    password,
  })
  if (error) throw new Error(mapAuthError(error))
  return data
}

export async function signUpWithPassword(input: {
  email: string
  password: string
  name?: string
}) {
  const allowed = assertAllowedEmail(input.email)
  const client = requireSupabase()
  const { data, error } = await client.auth.signUp({
    email: allowed,
    password: input.password,
    options: {
      emailRedirectTo: authRedirectTo("/auth/callback"),
      data: {
        full_name: input.name?.trim() || undefined,
      },
    },
  })
  if (error) throw new Error(mapAuthError(error))
  return data
}

export async function signOut() {
  if (!hasSupabase()) return
  const { error } = await requireSupabase().auth.signOut()
  if (error) throw new Error(mapAuthError(error))
}

export async function resetPasswordForEmail(email: string) {
  const allowed = assertAllowedEmail(email)
  const client = requireSupabase()
  const { error } = await client.auth.resetPasswordForEmail(allowed, {
    redirectTo: authRedirectTo("/update-password"),
  })
  if (error) throw new Error(mapAuthError(error))
}

export async function updatePassword(password: string) {
  const client = requireSupabase()
  const { data, error } = await client.auth.updateUser({ password })
  if (error) throw new Error(mapAuthError(error))
  return data
}

export async function exchangeCodeForSession(code: string) {
  const client = requireSupabase()
  const { data, error } = await client.auth.exchangeCodeForSession(code)
  if (error) throw new Error(mapAuthError(error))
  return data
}

/**
 * Troca `token_hash` (magic link / cross-login) por sessão via verifyOtp.
 * Necessário porque o client usa flowType pkce, que rejeita tokens no hash
 * (`#access_token=`) — e o token_hash só é consumido aqui, pelo JS do app,
 * imune a scanners de link que "queimam" o action_link de uso único.
 */
export async function verifyEmailOtp(tokenHash: string) {
  const client = requireSupabase()
  const { data, error } = await client.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  })
  if (error) throw new Error(mapAuthError(error))
  return data
}
