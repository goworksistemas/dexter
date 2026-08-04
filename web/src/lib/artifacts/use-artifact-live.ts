/**
 * Carrega um artefato e mantém conteúdo/título em sync:
 * - BroadcastChannel (edição local na outra aba, sem esperar save)
 * - Supabase postgres_changes (save / regeneração do agente)
 */
import * as React from "react"

import { supabase } from "@/lib/supabase/client"
import { fetchArtifactById } from "./api"
import {
  subscribeArtifactLive,
  type ArtifactLivePayload,
} from "./live-channel"
import type { AgentArtifact } from "./types"

export type LiveArtifactView = {
  id: string
  kind: AgentArtifact["kind"]
  title: string
  content: string
  version: number
  chatId: string
  updatedAt: string
}

export function useArtifactLive(artifactId: string | undefined) {
  const [artifact, setArtifact] = React.useState<LiveArtifactView | null>(null)
  const [isLoading, setIsLoading] = React.useState(Boolean(artifactId))
  const [error, setError] = React.useState<string | null>(null)
  const [liveSource, setLiveSource] = React.useState<"db" | "local" | null>(
    null,
  )
  const lastAtRef = React.useRef(0)

  const applyLive = React.useCallback((payload: ArtifactLivePayload) => {
    if (payload.at < lastAtRef.current) return
    lastAtRef.current = payload.at
    setArtifact((prev) => {
      if (!prev || prev.id !== payload.artifactId) {
        return {
          id: payload.artifactId,
          kind: payload.kind,
          title: payload.title || "Artefato",
          content: payload.content,
          version: payload.version ?? prev?.version ?? 1,
          chatId: prev?.chatId ?? "",
          updatedAt: new Date(payload.at).toISOString(),
        }
      }
      return {
        ...prev,
        kind: payload.kind,
        title: payload.title || prev.title,
        content: payload.content,
        version: payload.version ?? prev.version,
        updatedAt: new Date(payload.at).toISOString(),
      }
    })
    setLiveSource("local")
    setError(null)
    setIsLoading(false)
  }, [])

  React.useEffect(() => {
    if (!artifactId) {
      setArtifact(null)
      setIsLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)
    lastAtRef.current = 0

    void fetchArtifactById(artifactId)
      .then((row) => {
        if (cancelled) return
        if (!row) {
          setArtifact(null)
          setError("Artefato não encontrado.")
          return
        }
        const at = Date.parse(row.updated_at) || Date.now()
        lastAtRef.current = at
        setArtifact({
          id: row.id,
          kind: row.kind,
          title: row.title || "Artefato",
          content: row.content,
          version: row.version,
          chatId: row.chat_id,
          updatedAt: row.updated_at,
        })
        setLiveSource("db")
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setArtifact(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    const unsubLive = subscribeArtifactLive(artifactId, applyLive)

    let channel: ReturnType<NonNullable<typeof supabase>["channel"]> | null =
      null
    if (supabase) {
      channel = supabase
        .channel(`artifact-db:${artifactId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "agent_artifacts",
            filter: `id=eq.${artifactId}`,
          },
          (payload) => {
            const row = (payload.new ?? null) as AgentArtifact | null
            if (!row?.id) return
            const at = Date.parse(row.updated_at) || Date.now()
            // Draft local mais novo ganha até o save chegar.
            if (at < lastAtRef.current) return
            lastAtRef.current = at
            setArtifact({
              id: row.id,
              kind: row.kind,
              title: row.title || "Artefato",
              content: row.content,
              version: row.version,
              chatId: row.chat_id,
              updatedAt: row.updated_at,
            })
            setLiveSource("db")
          },
        )
        .subscribe()
    }

    return () => {
      cancelled = true
      unsubLive()
      if (channel && supabase) {
        void supabase.removeChannel(channel)
      }
    }
  }, [artifactId, applyLive])

  return { artifact, isLoading, error, liveSource }
}
