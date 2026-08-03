/**
 * Cliente por sistema de negócio. Cada sistema tem seu próprio projeto Supabase;
 * conectamos com a service_role dele (do Infisical) e chamamos SÓ as RPCs
 * read-only com gate (dexter_whoami + dexter_*). SQL do modelo só via
 * dexter_sql (allowlist SELECT/WITH + role dexter_ro).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import { SYSTEMS, getServiceRole } from "./registry.js"

const clients = new Map<string, SupabaseClient>()

/** Client Supabase (service_role) do sistema, ou null se não configurado. */
export function getSystemClient(slug: string): SupabaseClient | null {
  const sys = SYSTEMS.find((s) => s.slug === slug)
  if (!sys) return null
  const key = getServiceRole(slug)
  if (!key) return null

  const existing = clients.get(slug)
  if (existing) return existing

  const client = createClient(sys.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  clients.set(slug, client)
  return client
}

/** Chama uma RPC (dexter_*) de um sistema. Lança se o sistema não estiver
 * configurado ou se a RPC retornar erro (ex.: gate 'sem_acesso'). */
export async function callSystemRpc(
  slug: string,
  fn: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const client = getSystemClient(slug)
  if (!client) {
    throw new Error(`Sistema "${slug}" não configurado (service_role ausente no Infisical)`)
  }
  const { data, error } = await client.rpc(fn, args)
  if (error) {
    throw new Error(`${slug}.${fn}: ${error.message}`)
  }
  return data
}

export interface WhoamiResult {
  has_access: boolean
  [key: string]: unknown
}

/** Resolve o acesso do usuário (por email) num sistema, via dexter_whoami. */
export async function systemWhoami(slug: string, email: string): Promise<WhoamiResult> {
  try {
    const data = (await callSystemRpc(slug, "dexter_whoami", { p_email: email })) as WhoamiResult
    return data ?? { has_access: false }
  } catch {
    // Sistema sem whoami ainda / erro de conexão → trata como sem acesso.
    return { has_access: false }
  }
}
