/**
 * Visualização pública de uma conversa compartilhada (somente leitura).
 */
import * as React from "react"
import { Link } from "react-router-dom"
import { Loader2, MessageSquare } from "lucide-react"

import { Markdown } from "@/components/chat/markdown"
import { Button } from "@/components/ui/button"
import { fetchPublicChat, type PublicChatMessage } from "@/lib/share/api"
import { cn } from "@/lib/utils"

function PublicMessage({ message }: { message: PublicChatMessage }) {
  const isUser = message.role === "user"
  return (
    <article
      className={cn(
        "flex w-full gap-3 px-4 py-4 sm:px-6",
        isUser ? "bg-muted/30" : "bg-background",
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-emerald-600 text-white dark:bg-emerald-700",
        )}
        aria-hidden
      >
        {isUser ? "Você" : "AI"}
      </div>
      <div className="min-w-0 flex-1 text-[15px] leading-relaxed">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {isUser ? "Usuário" : "Assistente"}
        </p>
        <Markdown content={message.content} />
      </div>
    </article>
  )
}

export function ShareChatPage() {
  const token = window.location.pathname.split("/").pop() ?? ""
  const [payload, setPayload] = React.useState<Awaited<
    ReturnType<typeof fetchPublicChat>
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
    void fetchPublicChat(token, ac.signal)
      .then((data) => {
        setPayload(data)
        document.title = `${data.title?.trim() || "Conversa"} · Dexter`
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
        Carregando conversa…
      </div>
    )
  }

  if (error || !payload) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <MessageSquare className="size-10 text-muted-foreground/50" />
        <div>
          <h1 className="text-lg font-medium">Conversa indisponível</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {error ?? "O link pode ter sido revogado ou expirado."}
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
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Conversa compartilhada
          </p>
          <h1 className="truncate text-base font-semibold">
            {payload.title?.trim() || "Conversa sem título"}
          </h1>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link to="/login">Usar Dexter</Link>
        </Button>
      </header>

      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {payload.messages.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            Esta conversa ainda não tem mensagens visíveis.
          </p>
        ) : (
          payload.messages.map((m) => <PublicMessage key={m.id} message={m} />)
        )}
      </main>

      <footer className="shrink-0 border-t border-border/60 px-4 py-2 text-center text-[11px] text-muted-foreground">
        Compartilhado via Dexter · somente leitura
      </footer>
    </div>
  )
}
