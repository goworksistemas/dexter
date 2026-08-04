/**
 * Persistência OAuth por usuário (service_role).
 * Nunca enviar access_token/refresh_token ao frontend.
 */
import { randomBytes } from "node:crypto"

import { supabase } from "../lib/supabase.js"
import type { ConnectorId } from "./types.js"

export type ConnectorRowStatus = "connected" | "revoked" | "error"

export interface UserConnectorRow {
  user_id: string
  provider: ConnectorId
  access_token: string
  refresh_token: string | null
  expires_at: string | null
  meta: Record<string, unknown>
  status: ConnectorRowStatus
  connected_at: string
  revoked_at: string | null
}

export interface ConnectorPublicStatus {
  provider: ConnectorId
  status: ConnectorRowStatus
  meta: Record<string, unknown>
  expires_at: string | null
  connected_at: string
  revoked_at: string | null
}

const STATE_TTL_MS = 10 * 60 * 1000

export async function getConnectorRow(
  userId: string,
  provider: ConnectorId,
): Promise<UserConnectorRow | null> {
  const { data, error } = await supabase
    .from("dexter_user_connectors")
    .select(
      "user_id,provider,access_token,refresh_token,expires_at,meta,status,connected_at,revoked_at",
    )
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    user_id: data.user_id as string,
    provider: data.provider as ConnectorId,
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string | null) ?? null,
    expires_at: (data.expires_at as string | null) ?? null,
    meta:
      data.meta && typeof data.meta === "object"
        ? (data.meta as Record<string, unknown>)
        : {},
    status: data.status as ConnectorRowStatus,
    connected_at: data.connected_at as string,
    revoked_at: (data.revoked_at as string | null) ?? null,
  }
}

export async function listConnectorPublicStatuses(
  userId: string,
): Promise<Map<ConnectorId, ConnectorPublicStatus>> {
  const { data, error } = await supabase
    .from("dexter_user_connectors")
    .select("provider,status,meta,expires_at,connected_at,revoked_at")
    .eq("user_id", userId)
  if (error) throw new Error(error.message)
  const map = new Map<ConnectorId, ConnectorPublicStatus>()
  for (const row of data ?? []) {
    const provider = row.provider as ConnectorId
    map.set(provider, {
      provider,
      status: row.status as ConnectorRowStatus,
      meta:
        row.meta && typeof row.meta === "object"
          ? (row.meta as Record<string, unknown>)
          : {},
      expires_at: (row.expires_at as string | null) ?? null,
      connected_at: row.connected_at as string,
      revoked_at: (row.revoked_at as string | null) ?? null,
    })
  }
  return map
}

export async function upsertConnectorTokens(opts: {
  userId: string
  provider: ConnectorId
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  meta?: Record<string, unknown>
}): Promise<void> {
  const payload = {
    user_id: opts.userId,
    provider: opts.provider,
    access_token: opts.accessToken,
    refresh_token: opts.refreshToken ?? null,
    expires_at: opts.expiresAt ? opts.expiresAt.toISOString() : null,
    meta: opts.meta ?? {},
    status: "connected" as const,
    connected_at: new Date().toISOString(),
    revoked_at: null,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase
    .from("dexter_user_connectors")
    .upsert(payload, { onConflict: "user_id,provider" })
  if (error) throw new Error(error.message)
}

export async function updateConnectorTokens(opts: {
  userId: string
  provider: ConnectorId
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
}): Promise<void> {
  const patch: Record<string, unknown> = {
    access_token: opts.accessToken,
    updated_at: new Date().toISOString(),
    status: "connected",
  }
  if (opts.refreshToken !== undefined) {
    patch.refresh_token = opts.refreshToken
  }
  if (opts.expiresAt !== undefined) {
    patch.expires_at = opts.expiresAt ? opts.expiresAt.toISOString() : null
  }
  const { error } = await supabase
    .from("dexter_user_connectors")
    .update(patch)
    .eq("user_id", opts.userId)
    .eq("provider", opts.provider)
  if (error) throw new Error(error.message)
}

export async function revokeConnector(
  userId: string,
  provider: ConnectorId,
): Promise<void> {
  const { error } = await supabase
    .from("dexter_user_connectors")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
  if (error) throw new Error(error.message)
}

export async function createOAuthState(opts: {
  userId: string
  provider: ConnectorId
  returnTo?: string | null
  payload?: Record<string, unknown>
}): Promise<string> {
  const state = randomBytes(32).toString("hex")
  const expires_at = new Date(Date.now() + STATE_TTL_MS).toISOString()
  await supabase
    .from("dexter_connector_oauth_states")
    .delete()
    .eq("user_id", opts.userId)
    .lt("expires_at", new Date().toISOString())

  const { error } = await supabase.from("dexter_connector_oauth_states").insert({
    state,
    user_id: opts.userId,
    provider: opts.provider,
    return_to: opts.returnTo ?? null,
    expires_at,
    payload: opts.payload ?? {},
  })
  if (error) throw new Error(error.message)
  return state
}

export async function consumeOAuthState(
  state: string,
  provider: ConnectorId,
): Promise<{
  userId: string
  returnTo: string | null
  payload: Record<string, unknown>
} | null> {
  const { data, error } = await supabase
    .from("dexter_connector_oauth_states")
    .select("user_id,provider,return_to,expires_at,payload")
    .eq("state", state)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null

  await supabase.from("dexter_connector_oauth_states").delete().eq("state", state)

  if (data.provider !== provider) return null
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null
  return {
    userId: data.user_id as string,
    returnTo: (data.return_to as string | null) ?? null,
    payload:
      data.payload && typeof data.payload === "object"
        ? (data.payload as Record<string, unknown>)
        : {},
  }
}

export async function logConnectorEvent(opts: {
  userId: string
  provider: ConnectorId
  event: "connect" | "disconnect" | "token_refresh" | "error"
  meta?: Record<string, unknown>
}): Promise<void> {
  const { error } = await supabase.from("dexter_connector_events").insert({
    user_id: opts.userId,
    provider: opts.provider,
    event: opts.event,
    meta: opts.meta ?? {},
  })
  if (error) {
    console.error("[connectors] falha ao gravar evento:", error.message)
  }
}
