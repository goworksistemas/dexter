/**
 * Sync same-origin entre painel e aba dedicada (antes do save no DB).
 * Complementa postgres_changes para updates persistidos / multi-dispositivo.
 */
import type { ArtifactKind } from "./types"

export type ArtifactLivePayload = {
  artifactId: string
  kind: ArtifactKind
  title: string
  content: string
  version?: number
  at: number
}

const CHANNEL = "dexter-artifact-live"

function canUseBroadcast(): boolean {
  return typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
}

export function publishArtifactLive(payload: ArtifactLivePayload): void {
  if (!canUseBroadcast() || !payload.artifactId) return
  try {
    const bc = new BroadcastChannel(CHANNEL)
    bc.postMessage(payload)
    bc.close()
  } catch {
    /* ignore */
  }
}

export function subscribeArtifactLive(
  artifactId: string,
  onUpdate: (payload: ArtifactLivePayload) => void,
): () => void {
  if (!canUseBroadcast() || !artifactId) return () => {}
  let bc: BroadcastChannel
  try {
    bc = new BroadcastChannel(CHANNEL)
  } catch {
    return () => {}
  }
  const handler = (ev: MessageEvent<ArtifactLivePayload>) => {
    const data = ev.data
    if (!data || data.artifactId !== artifactId) return
    if (typeof data.content !== "string") return
    onUpdate(data)
  }
  bc.addEventListener("message", handler)
  return () => {
    bc.removeEventListener("message", handler)
    bc.close()
  }
}

export function artifactTabUrl(artifactId: string): string {
  const base = window.location.origin.replace(/\/$/, "")
  return `${base}/artifacts/${encodeURIComponent(artifactId)}`
}

/** Abre (ou foca) a aba dedicada do artefato. */
export function openArtifactTab(artifactId: string): Window | null {
  if (!artifactId) return null
  // Sem noopener: reusa/foca a mesma aba nomeada ao clicar de novo.
  return window.open(artifactTabUrl(artifactId), `dexter-artifact-${artifactId}`)
}
