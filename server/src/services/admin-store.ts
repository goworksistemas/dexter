/**
 * Administração de usuários do Dexter (profiles no agentcore).
 * Toda operação exige actor admin/master — checado nas rotas.
 * Master bootstrap: bpm@gowork.com.br
 */
import { supabase } from "../lib/supabase.js"
import { ForbiddenError, NotFoundError } from "./errors.js"

export const MASTER_EMAIL = "bpm@gowork.com.br"

export type DexterRole = "user" | "admin" | "master"

export interface ProfileAdminRow {
  id: string
  email: string | null
  full_name: string | null
  avatar_url: string | null
  role: DexterRole
  disabled_at: string | null
  /** Modelos liberados (ids provider:modelo). null = todos os habilitados. */
  allowed_models: string[] | null
  created_at: string
  updated_at: string
  last_sign_in_at: string | null
}

export interface ActorProfile {
  id: string
  email: string | null
  role: DexterRole
  disabled_at: string | null
}

function normalizeRole(raw: unknown): DexterRole {
  if (raw === "admin" || raw === "master" || raw === "user") return raw
  return "user"
}

export function isStaffRole(role: DexterRole): boolean {
  return role === "admin" || role === "master"
}

/** Carrega perfil do actor; promove master por email se necessário. */
export async function loadActorProfile(
  userId: string,
  email?: string,
): Promise<ActorProfile> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role, disabled_at")
    .eq("id", userId)
    .maybeSingle()

  if (error) {
    throw new Error(`Falha ao carregar perfil: ${error.message}`)
  }

  if (!data) {
    // Perfil ainda não criado — bootstrap mínimo
    const role: DexterRole =
      email && email.toLowerCase() === MASTER_EMAIL.toLowerCase()
        ? "master"
        : "user"
    return { id: userId, email: email ?? null, role, disabled_at: null }
  }

  let role = normalizeRole(data.role)
  const profileEmail = (data.email as string | null) ?? email ?? null

  // Bootstrap: e-mail master sempre master e nunca disabled
  if (
    profileEmail &&
    profileEmail.toLowerCase() === MASTER_EMAIL.toLowerCase() &&
    (role !== "master" || data.disabled_at)
  ) {
    await supabase
      .from("profiles")
      .update({ role: "master", disabled_at: null })
      .eq("id", userId)
    role = "master"
    return { id: userId, email: profileEmail, role, disabled_at: null }
  }

  return {
    id: userId,
    email: profileEmail,
    role,
    disabled_at: (data.disabled_at as string | null) ?? null,
  }
}

export async function assertNotDisabled(actor: ActorProfile): Promise<void> {
  if (actor.disabled_at) {
    throw new ForbiddenError(
      "Sua conta foi desativada no Dexter. Fale com um administrador.",
    )
  }
}

export async function assertStaff(actor: ActorProfile): Promise<void> {
  await assertNotDisabled(actor)
  if (!isStaffRole(actor.role)) {
    throw new ForbiddenError("Acesso restrito a administradores.")
  }
}

async function lastSignInMap(): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  let page = 1
  const perPage = 200

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    })
    if (error) {
      throw new Error(`listUsers falhou: ${error.message}`)
    }
    const users = data.users ?? []
    for (const u of users) {
      map.set(u.id, u.last_sign_in_at ?? null)
    }
    if (users.length < perPage) break
    page += 1
    if (page > 50) break // safety
  }
  return map
}

export async function fetchAdminCostCenter(days = 30): Promise<unknown> {
  const { data, error } = await supabase.rpc("dexter_admin_cost_center", {
    p_days: days,
  })
  if (error) throw new Error(`dexter_admin_cost_center: ${error.message}`)
  return data
}

export async function fetchAdminOverview(days = 30): Promise<unknown> {
  const { data, error } = await supabase.rpc("dexter_admin_overview", {
    p_days: days,
  })
  if (error) throw new Error(`overview falhou: ${error.message}`)
  return data
}

export async function fetchAdminUserDetail(
  userId: string,
  days = 30,
): Promise<unknown> {
  const { data, error } = await supabase.rpc("dexter_admin_user_detail", {
    p_user_id: userId,
    p_days: days,
  })
  if (error) throw new Error(`user detail falhou: ${error.message}`)
  if (
    data &&
    typeof data === "object" &&
    "erro" in (data as Record<string, unknown>)
  ) {
    throw new NotFoundError(String((data as { erro: string }).erro))
  }
  return data
}

export async function listAdminUsers(): Promise<ProfileAdminRow[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, full_name, avatar_url, role, disabled_at, allowed_models, created_at, updated_at",
    )
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`listAdminUsers falhou: ${error.message}`)
  }

  const signIns = await lastSignInMap()
  return (data ?? []).map((row) => ({
    id: row.id as string,
    email: (row.email as string | null) ?? null,
    full_name: (row.full_name as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    role: normalizeRole(row.role),
    disabled_at: (row.disabled_at as string | null) ?? null,
    allowed_models: (row.allowed_models as string[] | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    last_sign_in_at: signIns.get(row.id as string) ?? null,
  }))
}

export interface PatchUserInput {
  role?: DexterRole
  disabled?: boolean
  /** null = liberar todos os modelos; array = restringir a estes ids. */
  allowed_models?: string[] | null
  /** Teto USD no mês corrente (null = sem limite). */
  usage_budget_usd?: number | null
}

export async function patchAdminUser(
  actor: ActorProfile,
  targetId: string,
  patch: PatchUserInput,
): Promise<ProfileAdminRow> {
  const { data: target, error: readErr } = await supabase
    .from("profiles")
    .select(
      "id, email, full_name, avatar_url, role, disabled_at, allowed_models, created_at, updated_at",
    )
    .eq("id", targetId)
    .maybeSingle()

  if (readErr) throw new Error(readErr.message)
  if (!target) throw new NotFoundError("Usuário não encontrado.")

  const targetRole = normalizeRole(target.role)
  const targetEmail = (target.email as string | null) ?? ""

  // Proteções
  if (targetId === actor.id && patch.disabled === true) {
    throw new ForbiddenError("Você não pode desativar a própria conta.")
  }
  if (
    targetEmail.toLowerCase() === MASTER_EMAIL.toLowerCase() ||
    targetRole === "master"
  ) {
    if (patch.disabled === true) {
      throw new ForbiddenError("Não é permitido desativar o master.")
    }
    if (patch.role && patch.role !== "master") {
      throw new ForbiddenError("Não é permitido rebaixar o master.")
    }
  }

  // Só master altera roles
  if (patch.role !== undefined) {
    if (actor.role !== "master") {
      throw new ForbiddenError("Só o master pode alterar papéis.")
    }
    if (patch.role === "master" && targetId !== actor.id) {
      // Permite no máximo transferir? Por segurança: não criar outros masters via API
      // Exceto o email bootstrap. Se alguém precisa ser master, usa o email certo.
      if (targetEmail.toLowerCase() !== MASTER_EMAIL.toLowerCase()) {
        throw new ForbiddenError(
          "Só o e-mail master designado pode ter papel master.",
        )
      }
    }
    if (patch.role === "admin" || patch.role === "user") {
      // ok
    } else if (patch.role !== "master") {
      throw new ForbiddenError("Papel inválido.")
    }
  }

  // Admin comum só desativa/reativa users (não outros admins/masters)
  if (actor.role === "admin") {
    if (targetRole !== "user") {
      throw new ForbiddenError(
        "Admins só podem gerenciar usuários comuns (não outros admins).",
      )
    }
    if (patch.role !== undefined) {
      throw new ForbiddenError("Só o master pode alterar papéis.")
    }
  }

  // Restringir modelos de admin/master não faz sentido (staff vê tudo).
  if (
    patch.allowed_models !== undefined &&
    patch.allowed_models !== null &&
    targetRole !== "user" &&
    !(patch.role === "user")
  ) {
    throw new ForbiddenError(
      "Modelos só podem ser restringidos para usuários comuns.",
    )
  }

  const update: Record<string, unknown> = {}
  if (patch.role !== undefined) update.role = patch.role
  if (patch.disabled === true) update.disabled_at = new Date().toISOString()
  if (patch.disabled === false) update.disabled_at = null
  if (patch.allowed_models !== undefined) {
    update.allowed_models = patch.allowed_models
  }
  if (patch.usage_budget_usd !== undefined) {
    update.usage_budget_usd = patch.usage_budget_usd
  }

  if (Object.keys(update).length === 0) {
    throw new Error("Nenhuma alteração informada.")
  }

  const { data: updated, error: updErr } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", targetId)
    .select(
      "id, email, full_name, avatar_url, role, disabled_at, allowed_models, created_at, updated_at",
    )
    .single()

  if (updErr || !updated) {
    throw new Error(updErr?.message ?? "Falha ao atualizar usuário.")
  }

  // Ban/unban no Auth como trava extra (login bloqueado)
  try {
    if (patch.disabled === true) {
      await supabase.auth.admin.updateUserById(targetId, {
        ban_duration: "876000h", // ~100 anos
      })
    } else if (patch.disabled === false) {
      await supabase.auth.admin.updateUserById(targetId, {
        ban_duration: "none",
      })
    }
  } catch {
    // profiles.disabled_at já basta para APIs; ban é best-effort
  }

  const signIns = await lastSignInMap()
  return {
    id: updated.id as string,
    email: (updated.email as string | null) ?? null,
    full_name: (updated.full_name as string | null) ?? null,
    avatar_url: (updated.avatar_url as string | null) ?? null,
    role: normalizeRole(updated.role),
    disabled_at: (updated.disabled_at as string | null) ?? null,
    allowed_models: (updated.allowed_models as string[] | null) ?? null,
    created_at: updated.created_at as string,
    updated_at: updated.updated_at as string,
    last_sign_in_at: signIns.get(updated.id as string) ?? null,
  }
}
