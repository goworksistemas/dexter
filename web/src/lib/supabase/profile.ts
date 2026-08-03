import type { User } from "@supabase/supabase-js"

import type { ThemePreference, UserPreferences, UserProfile } from "@/types"
import { supabase } from "./client"
import { userToProfile } from "./auth"

function parsePreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== "object") return {}
  const theme = (raw as { theme?: unknown }).theme
  if (theme === "light" || theme === "dark" || theme === "system") {
    return { theme }
  }
  return {}
}

/** Carrega perfil da tabela public.profiles; fallback para user_metadata. */
export async function fetchUserProfile(user: User): Promise<UserProfile> {
  const fallback = userToProfile(user)
  if (!supabase) return fallback

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, preferences")
    .eq("id", user.id)
    .maybeSingle()

  if (error || !data) return fallback

  return {
    id: data.id,
    email: data.email ?? fallback.email,
    name: data.full_name ?? fallback.name,
    avatarUrl: data.avatar_url ?? fallback.avatarUrl,
    preferences: parsePreferences(data.preferences),
  }
}

/** Garante linha em profiles após signup (trigger cobre o caso normal). */
export async function ensureProfileFromUser(user: User): Promise<void> {
  if (!supabase) return
  const meta = user.user_metadata ?? {}
  await supabase.from("profiles").upsert(
    {
      id: user.id,
      email: user.email,
      full_name:
        (typeof meta.full_name === "string" && meta.full_name) ||
        (typeof meta.name === "string" && meta.name) ||
        null,
      avatar_url:
        (typeof meta.avatar_url === "string" && meta.avatar_url) || null,
    },
    { onConflict: "id" },
  )
}

/** Atualiza o nome exibido em profiles.full_name. */
export async function updateProfileName(fullName: string): Promise<void> {
  if (!supabase) throw new Error("Supabase não configurado.")
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Sessão inválida.")

  const trimmed = fullName.trim()
  if (!trimmed) throw new Error("Informe um nome.")
  if (trimmed.length > 120) throw new Error("Nome muito longo (máx. 120).")

  const { error } = await supabase
    .from("profiles")
    .update({ full_name: trimmed })
    .eq("id", user.id)

  if (error) throw new Error(error.message)
}

/** Mescla preferências em profiles.preferences (jsonb). */
export async function updateProfilePreferences(
  patch: UserPreferences,
): Promise<UserPreferences> {
  if (!supabase) throw new Error("Supabase não configurado.")
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Sessão inválida.")

  const { data: current, error: readErr } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("id", user.id)
    .maybeSingle()

  if (readErr) throw new Error(readErr.message)

  const next: UserPreferences = {
    ...parsePreferences(current?.preferences),
    ...patch,
  }

  const { error } = await supabase
    .from("profiles")
    .update({ preferences: next })
    .eq("id", user.id)

  if (error) throw new Error(error.message)
  return next
}

export async function updateProfileTheme(theme: ThemePreference): Promise<void> {
  await updateProfilePreferences({ theme })
}
