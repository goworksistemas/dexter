/**
 * Preferência opt-in de multi-agentes em profiles.preferences.multi_agent (jsonb).
 */
import { supabase } from "../lib/supabase.js"

export interface MultiAgentPreferences {
  enabled: boolean
  /** ISO8601 — quando o usuário autorizou explicitamente. */
  authorizedAt?: string
}

export function parseMultiAgentPreferences(raw: unknown): MultiAgentPreferences {
  if (!raw || typeof raw !== "object") return { enabled: false }
  const root = raw as { multi_agent?: unknown }
  const ma = root.multi_agent
  if (!ma || typeof ma !== "object") return { enabled: false }
  const obj = ma as Record<string, unknown>
  const enabled = obj.enabled === true
  const authorizedAt =
    typeof obj.authorized_at === "string" ? obj.authorized_at : undefined
  if (!enabled) return { enabled: false }
  return { enabled: true, ...(authorizedAt ? { authorizedAt } : {}) }
}

export async function loadMultiAgentPreferences(
  userId: string,
): Promise<MultiAgentPreferences> {
  const { data, error } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("id", userId)
    .maybeSingle()
  if (error || !data) return { enabled: false }
  return parseMultiAgentPreferences(data.preferences)
}

export function isMultiAgentAuthorized(prefs: MultiAgentPreferences): boolean {
  return prefs.enabled === true && !!prefs.authorizedAt
}
