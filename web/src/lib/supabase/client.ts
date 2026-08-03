// Client Supabase — auth do Dexter (projeto agentcore).
// SPA Vite: PKCE + detectSessionInUrl para confirmar e-mail e recovery.
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined

/** Client Supabase ativo, ou `null` se as envs VITE_SUPABASE_* estiverem vazias. */
export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      })
    : null

export function hasSupabase(): boolean {
  return supabase !== null
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      "Supabase não configurado. Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.",
    )
  }
  return supabase
}
