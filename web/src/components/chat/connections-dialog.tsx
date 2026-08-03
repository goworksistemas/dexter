import * as React from "react"
import { Database, Loader2, Plug, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  fetchConnections,
  type ConnectionInfo,
  type ConnectionStatus,
} from "@/lib/connections/api"
import { cn } from "@/lib/utils"

function statusLabel(status: ConnectionStatus): string {
  if (status === "connected") return "Conectado"
  if (status === "no_access") return "Sem acesso"
  return "Indisponível"
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "connected" && "status-dot-live bg-emerald-500",
        status === "no_access" && "bg-amber-500",
        status === "unavailable" && "bg-muted-foreground/40",
      )}
      aria-hidden
    />
  )
}

function ConnectionRow({ item }: { item: ConnectionInfo }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 transition-colors hover:border-border">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Database className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {item.label}
          </p>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot status={item.status} />
            {statusLabel(item.status)}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{item.slug}</p>
        {item.status === "connected" && (item.role || item.fullName) ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {[item.fullName, item.role].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </div>
    </li>
  )
}

export function ConnectionsDialog() {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [items, setItems] = React.useState<ConnectionInfo[]>([])
  const [connectedCount, setConnectedCount] = React.useState(0)

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchConnections(signal)
      setItems(data.connections)
      setConnectedCount(data.connectedCount)
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setItems([])
      setConnectedCount(0)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  // Contagem no botão: busca leve ao montar.
  React.useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-lg text-muted-foreground"
          aria-label="Ver conexões com bancos de dados"
        >
          <Plug className="size-4" />
          <span className="hidden sm:inline">Conexões</span>
          {connectedCount > 0 ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              <span className="status-dot-live size-1.5 rounded-full bg-emerald-500" aria-hidden />
              {connectedCount}
            </span>
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conexões</DialogTitle>
          <DialogDescription>
            Bancos de dados GoWork que o Dexter pode consultar com o seu acesso.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {loading
              ? "Verificando..."
              : `${connectedCount} conectado${connectedCount === 1 ? "" : "s"}`}
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Atualizar conexões"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Carregando conexões...
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhum sistema configurado no AgentCore.
          </p>
        ) : (
          <ul className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto pr-1">
            {items.map((item) => (
              <ConnectionRow key={item.slug} item={item} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
