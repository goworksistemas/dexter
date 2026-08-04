import type { User } from "@supabase/supabase-js"

import type {
  DexterRole,
  ThemePreference,
  UserPreferences,
  UserProfile,
} from "@/types"
import { supabase } from "./client"
import { userToProfile } from "./auth"

function parsePreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== "object") return {}
  const obj = raw as {
    theme?: unknown
    sidebarCollapsed?: unknown
    connectors?: unknown
    multiAgent?: unknown
  }
  const prefs: UserPreferences = {}
  if (obj.theme === "light" || obj.theme === "dark" || obj.theme === "system") {
    prefs.theme = obj.theme
  }
  if (typeof obj.sidebarCollapsed === "boolean") {
    prefs.sidebarCollapsed = obj.sidebarCollapsed
  }
  if (obj.connectors && typeof obj.connectors === "object") {
    const c = obj.connectors as { notion?: unknown; outlook?: unknown }
    const connectors: NonNullable<UserPreferences["connectors"]> = {}
    if (typeof c.notion === "boolean") connectors.notion = c.notion
    if (typeof c.outlook === "boolean") connectors.outlook = c.outlook
    if (Object.keys(connectors).length > 0) prefs.connectors = connectors
  }
  if (obj.multiAgent && typeof obj.multiAgent === "object") {
    const ma = obj.multiAgent as { enabled?: unknown; authorizedAt?: unknown }
    if (ma.enabled === true) {
      prefs.multiAgent = {
        enabled: true,
        ...(typeof ma.authorizedAt === "string"
          ? { authorizedAt: ma.authorizedAt }
          : {}),
      }
    }
  } else if (obj.multi_agent && typeof obj.multi_agent === "object") {
    const ma = obj.multi_agent as { enabled?: unknown; authorized_at?: unknown }
    if (ma.enabled === true) {
      prefs.multiAgent = {
        enabled: true,
        ...(typeof ma.authorized_at === "string"
          ? { authorizedAt: ma.authorized_at }
          : {}),
      }
    }
  }
  return prefs
}

function parseRole(raw: unknown): DexterRole {
  if (raw === "admin" || raw === "master" || raw === "user") return raw
  return "user"
}

/**
 * Rede pendurada não pode travar o bootstrap da sessão: o auth-provider espera
 * este fetch antes de liberar a UI, e o ProtectedRoute trata sessão sem perfil
 * como "Carregando sessão...". Menor que o timeout de bootstrap (8s).
 */
const PROFILE_TIMEOUT_MS = 6_000

/** Carrega perfil da tabela public.profiles; fallback para user_metadata. */
export async function fetchUserProfile(user: User): Promise<UserProfile> {
  const fallback = userToProfile(user)
  if (!supabase) return fallback

  const query = supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, preferences, role, disabled_at")
    .eq("id", user.id)
    .maybeSingle()

  let timer: number | undefined
  const result = await Promise.race([
    query,
    new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), PROFILE_TIMEOUT_MS)
    }),
  ])
  if (timer !== undefined) window.clearTimeout(timer)
  if (!result) return fallback

  const { data, error } = result

  if (error || !data) return fallback

  return {
    id: data.id,
    email: data.email ?? fallback.email,
    name: data.full_name ?? fallback.name,
    avatarUrl: data.avatar_url ?? fallback.avatarUrl,
    preferences: parsePreferences(data.preferences),
    role: parseRole(data.role),
    disabledAt: (data.disabled_at as string | null) ?? null,
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
  // Sessão local (o client já faz auto-refresh) — evita um round-trip ao
  // /auth/v1/user a cada save.
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user.id
  if (!userId) throw new Error("Sessão inválida.")

  const trimmed = fullName.trim()
  if (!trimmed) throw new Error("Informe um nome.")
  if (trimmed.length > 120) throw new Error("Nome muito longo (máx. 120).")

  const { error } = await supabase
    .from("profiles")
    .update({ full_name: trimmed })
    .eq("id", userId)

  if (error) throw new Error(error.message)
}

/** Mescla preferências em profiles.preferences (jsonb). */
export async function updateProfilePreferences(
  patch: UserPreferences,
): Promise<UserPreferences> {
  if (!supabase) throw new Error("Supabase não configurado.")
  // Sessão local (o client já faz auto-refresh) — evita um round-trip ao
  // /auth/v1/user a cada save.
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user.id
  if (!userId) throw new Error("Sessão inválida.")

  const { data: current, error: readErr } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("id", userId)
    .maybeSingle()

  if (readErr) throw new Error(readErr.message)

  const prev = parsePreferences(current?.preferences)
  const next: UserPreferences = {
    ...prev,
    ...patch,
    connectors:
      patch.connectors || prev.connectors
        ? { ...prev.connectors, ...patch.connectors }
        : undefined,
    multiAgent:
      patch.multiAgent !== undefined ? patch.multiAgent : prev.multiAgent,
  }

  const prevRaw =
    current?.preferences && typeof current.preferences === "object"
      ? (current.preferences as Record<string, unknown>)
      : {}

  const dbPrefs: Record<string, unknown> = {
    ...prevRaw,
    theme: next.theme,
    sidebarCollapsed: next.sidebarCollapsed,
    connectors: next.connectors,
  }
  if (next.multiAgent?.enabled) {
    dbPrefs.multi_agent = {
      enabled: true,
      authorized_at: next.multiAgent.authorizedAt ?? new Date().toISOString(),
    }
  } else {
    delete dbPrefs.multi_agent
  }

  const { error } = await supabase
    .from("profiles")
    .update({ preferences: dbPrefs })
    .eq("id", userId)

  if (error) throw new Error(error.message)
  return next
}

export async function updateProfileTheme(theme: ThemePreference): Promise<void> {
  await updateProfilePreferences({ theme })
}
