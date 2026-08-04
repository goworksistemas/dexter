import * as React from "react"
import { Blocks, Code2, ExternalLink, FileText, MessageSquare, Search } from "lucide-react"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  fetchArtifactsForUser,
  openArtifactTab,
  type AgentArtifact,
} from "@/lib/artifacts"
import { useChats } from "@/lib/chats"
import { formatRelative } from "@/lib/dates"

export function ArtifactsPage() {
  const { chats, selectChat } = useChats()
  const [artifacts, setArtifacts] = React.useState<AgentArtifact[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)
    fetchArtifactsForUser(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setArtifacts(list)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    return () => controller.abort()
  }, [reloadToken])

  const chatTitle = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const chat of chats) map.set(chat.id, chat.title || "Sem título")
    return map
  }, [chats])

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return artifacts
    return artifacts.filter((a) => (a.title || "").toLowerCase().includes(q))
  }, [artifacts, query])

  return (
    <PageShell>
      <PageHeading
        title="Artefatos"
        description="Documentos e páginas geradas nas conversas, com a última versão salva."
      />

      <div className="relative mt-5">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por título"
          aria-label="Buscar artefatos"
          className="h-9 pl-9 text-sm"
        />
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
            <p className="text-sm font-medium text-destructive">
              Não foi possível carregar os artefatos.
            </p>
            <p className="mt-1 text-xs break-words text-muted-foreground">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setReloadToken((t) => t + 1)}
            >
              Tentar de novo
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Blocks className="size-5" />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">
                {query.trim()
                  ? "Nenhum artefato encontrado."
                  : "Nenhum artefato ainda."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Quando o Dexter gerar uma página HTML ou um documento longo, ele
                aparece aqui.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visible.map((artifact) => {
              const Icon = artifact.kind === "html" ? Code2 : FileText
              const origem = chatTitle.get(artifact.chat_id)
              return (
                <div
                  key={artifact.id}
                  className="hover:shadow-elevate-sm flex flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
                >
                  <button
                    type="button"
                    onClick={() => openArtifactTab(artifact.id)}
                    className="flex items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-card-foreground">
                      {artifact.title || "Artefato"}
                    </span>
                    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
                      {artifact.kind === "html" ? "HTML" : "MD"}
                    </span>
                  </button>

                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {origem ? `Conversa: ${origem}` : "Conversa removida"}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>v{artifact.version}</span>
                    <span aria-hidden>·</span>
                    <span>{formatRelative(artifact.updated_at)}</span>
                    <span className="ml-auto flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2"
                        title="Abrir em aba dedicada"
                        onClick={() => openArtifactTab(artifact.id)}
                      >
                        <ExternalLink className="size-3" />
                        Aba
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2"
                        title="Abrir conversa"
                        onClick={() => selectChat(artifact.chat_id)}
                      >
                        <MessageSquare className="size-3" />
                        Chat
                      </Button>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </PageShell>
  )
}
