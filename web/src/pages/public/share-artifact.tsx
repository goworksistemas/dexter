/**
 * Visualização pública de um artefato publicado (somente leitura).
 */
import * as React from "react"
import { Link } from "react-router-dom"
import { FileCode2, Loader2 } from "lucide-react"

import { HtmlPreview } from "@/components/artifacts/html-preview"
import { Markdown } from "@/components/chat/markdown"
import { PublicRiskBanner } from "@/components/share/public-risk-banner"
import { Button } from "@/components/ui/button"
import { fetchPublicArtifact } from "@/lib/share/api"

export function ShareArtifactPage() {
  const token = window.location.pathname.split("/").pop() ?? ""
  const [artifact, setArtifact] = React.useState<Awaited<
    ReturnType<typeof fetchPublicArtifact>
  > | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!token) {
      setError("Link inválido.")
      setLoading(false)
      return
    }
    const ac = new AbortController()
    void fetchPublicArtifact(token, ac.signal)
      .then((data) => {
        setArtifact(data)
        document.title = `${data.title} · Dexter`
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        setError(err instanceof Error ? err.message : "Erro ao carregar.")
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [token])

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Carregando artefato…
      </div>
    )
  }

  if (error || !artifact) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <FileCode2 className="size-10 text-muted-foreground/50" />
        <div>
          <h1 className="text-lg font-medium">Artefato indisponível</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {error ?? "O link pode ter sido revogado."}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/login">Entrar no Dexter</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <PublicRiskBanner />
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Artefato publicado · somente leitura
          </p>
          <h1 className="truncate text-base font-semibold">{artifact.title}</h1>
          <p className="text-[11px] text-muted-foreground">
            {artifact.kind === "html" ? "HTML" : "Markdown"} · v{artifact.version}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link to="/login">Usar Dexter</Link>
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        {artifact.kind === "html" ? (
          <div className="h-full overflow-hidden rounded-lg border border-border/60">
            <HtmlPreview html={artifact.content} />
          </div>
        ) : (
          <div className="scroll-thin h-full overflow-y-auto rounded-lg border border-border/60 bg-background px-4 py-3">
            <Markdown content={artifact.content} />
          </div>
        )}
      </main>

      <footer className="shrink-0 border-t border-border/60 px-4 py-2 text-center text-[11px] text-muted-foreground">
        Publicado via Dexter · somente leitura
      </footer>
    </div>
  )
}
