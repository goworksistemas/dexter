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
import {
  disconnectConnector,
  fetchConnectors,
  patchConnectors,
  type ConnectorId,
  type ConnectorStatus,
} from "@/lib/connectors/api"
import { connectWithPopup } from "@/lib/connectors/oauth-popup"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/auth-provider"
import { toast } from "sonner"

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

function ConnectorRow({
  item,
  busy,
  onConnect,
  onToggle,
  onDisconnect,
}: {
  item: ConnectorStatus
  busy: boolean
  onConnect: () => void
  onToggle: () => void
  onDisconnect: () => void
}) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">
        {item.label.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {item.label}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {!item.configured ? (
              <span className="text-xs text-muted-foreground">Indisponível</span>
            ) : !item.connected ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={onConnect}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  "Conectar"
                )}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant={item.enabled ? "secondary" : "outline"}
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={onToggle}
                >
                  {item.enabled ? "Ligado" : "Ligar"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  disabled={busy}
                  onClick={onDisconnect}
                >
                  Desconectar
                </Button>
              </>
            )}
          </div>
        </div>
        {item.configured && item.connected ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {item.enabled ? "Conectado" : "Conectado · desligado"}
            {typeof item.meta?.workspace_name === "string"
              ? ` · ${item.meta.workspace_name}`
              : ""}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** Conteúdo reutilizável (dialog do composer / header legado). */
export function ConnectionsPanel() {
  const { refreshProfile } = useAuth()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [items, setItems] = React.useState<ConnectionInfo[]>([])
  const [connectedCount, setConnectedCount] = React.useState(0)
  const [connectors, setConnectors] = React.useState<ConnectorStatus[]>([])
  const [busyConnector, setBusyConnector] = React.useState<string | null>(null)

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const [data, conn] = await Promise.all([
        fetchConnections(signal),
        fetchConnectors(signal),
      ])
      setItems(data.connections)
      setConnectedCount(data.connectedCount)
      setConnectors(conn.connectors)
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setItems([])
      setConnectedCount(0)
      setConnectors([])
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const connectConnector = async (item: ConnectorStatus) => {
    if (!item.configured) {
      toast.message("Conector indisponível neste ambiente.")
      return
    }
    setBusyConnector(item.id)
    try {
      const result = await connectWithPopup(
        item.id as ConnectorId,
        `${window.location.pathname}${window.location.search}`,
      )
      if (result === "connected") {
        const data = await fetchConnectors()
        setConnectors(data.connectors)
        await refreshProfile()
        toast.success(`${item.label} conectado`)
      } else if (result === "error") {
        toast.error(`Falha ao conectar ${item.label}.`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyConnector(null)
    }
  }

  const toggleConnector = async (item: ConnectorStatus) => {
    if (!item.configured) {
      toast.message("Conector indisponível neste ambiente.")
      return
    }
    if (!item.connected) {
      await connectConnector(item)
      return
    }
    setBusyConnector(item.id)
    try {
      const data = await patchConnectors({ [item.id]: !item.enabled })
      setConnectors(data.connectors)
      await refreshProfile()
      toast.success(
        !item.enabled ? `${item.label} ligado` : `${item.label} desligado`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyConnector(null)
    }
  }

  const disconnect = async (item: ConnectorStatus) => {
    setBusyConnector(item.id)
    try {
      const data = await disconnectConnector(item.id as ConnectorId)
      setConnectors(data.connectors)
      await refreshProfile()
      toast.success(`${item.label} desconectado`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyConnector(null)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {loading
            ? "Verificando..."
            : `${connectedCount} sistema${connectedCount === 1 ? "" : "s"} · ${
                connectors.filter((c) => c.connected && c.enabled).length
              } conector(es)`}
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
      ) : loading && items.length === 0 && connectors.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Carregando conexões...
        </div>
      ) : (
        <div className="flex max-h-[50dvh] flex-col gap-4 overflow-y-auto pr-1">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Sistemas GoWork
            </h3>
            {items.length === 0 ? (
              <p className="py-2 text-center text-sm text-muted-foreground">
                Nenhum sistema configurado.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <ConnectionRow key={item.slug} item={item} />
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Conectores
            </h3>
            <ul className="flex flex-col gap-2">
              {connectors.map((item) => (
                <ConnectorRow
                  key={item.id}
                  item={item}
                  busy={busyConnector === item.id}
                  onConnect={() => void connectConnector(item)}
                  onToggle={() => void toggleConnector(item)}
                  onDisconnect={() => void disconnect(item)}
                />
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  )
}

type ConnectionsDialogProps = {
  /** Modo controlado (ex.: menu + do composer). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Esconde o botão trigger (só o dialog). */
  hideTrigger?: boolean
}

export function ConnectionsDialog({
  open: openControlled,
  onOpenChange,
  hideTrigger = false,
}: ConnectionsDialogProps = {}) {
  const [openUncontrolled, setOpenUncontrolled] = React.useState(false)
  const open = openControlled ?? openUncontrolled
  const setOpen = onOpenChange ?? setOpenUncontrolled

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {hideTrigger ? null : (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 rounded-lg text-muted-foreground"
            aria-label="Ver conexões"
          >
            <Plug className="size-4" />
            <span className="hidden sm:inline">Conexões</span>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conexões</DialogTitle>
          <DialogDescription>
            Sistemas GoWork e contas Notion / Outlook. Clique em Conectar e
            autorize.
          </DialogDescription>
        </DialogHeader>
        <ConnectionsPanel />
      </DialogContent>
    </Dialog>
  )
}
