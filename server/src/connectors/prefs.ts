/**
 * Preferências de conectores em profiles.preferences.connectors (jsonb).
 */
import { supabase } from "../lib/supabase.js"
import type { ConnectorId, ConnectorPreferences } from "./types.js"

const IDS: ConnectorId[] = ["notion", "outlook"]

export function parseConnectorPreferences(raw: unknown): ConnectorPreferences {
  if (!raw || typeof raw !== "object") return {}
  const root = raw as { connectors?: unknown }
  const c = root.connectors
  if (!c || typeof c !== "object") return {}
  const obj = c as Record<string, unknown>
  const out: ConnectorPreferences = {}
  if (typeof obj.notion === "boolean") out.notion = obj.notion
  if (typeof obj.outlook === "boolean") out.outlook = obj.outlook
  return out
}

export async function loadConnectorPreferences(
  userId: string,
): Promise<ConnectorPreferences> {
  const { data, error } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("id", userId)
    .maybeSingle()
  if (error || !data) return {}
  return parseConnectorPreferences(data.preferences)
}

export async function saveConnectorPreferences(
  userId: string,
  patch: ConnectorPreferences,
): Promise<ConnectorPreferences> {
  const { data: current, error: readErr } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("id", userId)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)

  const prevRaw =
    current?.preferences && typeof current.preferences === "object"
      ? (current.preferences as Record<string, unknown>)
      : {}
  const prevConnectors = parseConnectorPreferences(prevRaw)
  const nextConnectors: ConnectorPreferences = { ...prevConnectors }
  for (const id of IDS) {
    if (typeof patch[id] === "boolean") nextConnectors[id] = patch[id]
  }

  const nextPrefs = {
    ...prevRaw,
    connectors: nextConnectors,
  }

  const { error } = await supabase
    .from("profiles")
    .update({ preferences: nextPrefs })
    .eq("id", userId)
  if (error) throw new Error(error.message)
  return nextConnectors
}

export function isConnectorEnabled(
  prefs: ConnectorPreferences,
  id: ConnectorId,
): boolean {
  return prefs[id] === true
}
