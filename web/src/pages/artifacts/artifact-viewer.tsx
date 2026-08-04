/**
 * Aba dedicada do artefato — preview fullscreen com sync ao vivo
 * (BroadcastChannel + Supabase Realtime).
 */
import * as React from "react"
import { ArrowLeft, ExternalLink, Radio } from "lucide-react"
import { Link, useParams } from "react-router-dom"

import { HtmlPreview } from "@/components/artifacts/html-preview"
import { Markdown } from "@/components/chat/markdown"
import { ShareLinkButton } from "@/components/share/share-link-dialog"
import { Button } from "@/components/ui/button"
import { useArtifactLive } from "@/lib/artifacts/use-artifact-live"
import { cn } from "@/lib/utils"

export function ArtifactViewerPage() {
  const { artifactId } = useParams<{ artifactId: string }>()
  const { artifact, isLoading, error, liveSource } = useArtifactLive(artifactId)

  React.useEffect(() => {
    if (!artifact?.title) return
    const prev = document.title
    document.title = `${artifact.title} · Dexter`
    return () => {
      document.title = prev
    }
  }, [artifact?.title])

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Carregando artefato…
      </div>
    )
  }

  if (error || !artifact) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-base font-medium text-foreground">
          {error || "Artefato não encontrado."}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/artifacts">Voltar aos artefatos</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="size-8 shrink-0"
        >
          <Link
            to={artifact.chatId ? `/c/${artifact.chatId}` : "/artifacts"}
            title="Abrir conversa"
          >
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{artifact.title}</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {artifact.kind === "html" ? "HTML" : "Markdown"} · v
            {artifact.version}
            {liveSource ? (
              <span
                className={cn(
                  "ml-2 inline-flex items-center gap-1",
                  liveSource === "local"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "",
                )}
              >
                <Radio className="size-2.5" aria-hidden />
                {liveSource === "local" ? "ao vivo" : "sincronizado"}
              </span>
            ) : null}
          </p>
        </div>
        <ShareLinkButton
          resource="artifact"
          resourceId={artifact.id}
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1.5"
          label="Publicar"
        />
        <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5">
          <Link to="/artifacts">
            <ExternalLink className="size-3.5" />
            Lista
          </Link>
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">
        {artifact.kind === "html" ? (
          <HtmlPreview html={artifact.content} />
        ) : (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60 bg-background px-4 py-3 sm:px-6 sm:py-5">
            <Markdown content={artifact.content} />
          </div>
        )}
      </main>
    </div>
  )
}
