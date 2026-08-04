/**
 * URLs públicas para OAuth — separado para evitar ciclo
 * notion-mcp-oauth ↔ oauth.
 */
import { config, corsOrigins } from "../config.js"

export function agentcorePublicUrl(): string {
  const u = config.AGENTCORE_PUBLIC_URL?.trim()
  if (u) return u.replace(/\/$/, "")
  return `http://localhost:${config.PORT}`
}

export function dexterAppUrl(): string {
  const u = config.DEXTER_APP_URL?.trim()
  if (u) return u.replace(/\/$/, "")
  return (corsOrigins[0] ?? "http://localhost:5273").replace(/\/$/, "")
}

export function microsoftRedirectUri(): string {
  const u = config.MICROSOFT_REDIRECT_URI?.trim()
  if (u) return u
  return `${agentcorePublicUrl()}/api/connectors/outlook/callback`
}
