/**
 * Botão "+" do composer: anexar + Sistemas GoWork + conectores.
 */
import * as React from "react"
import { Check, FileUp, Plus, Server } from "lucide-react"

import { ConnectionsDialog } from "@/components/chat/connections-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  fetchConnectors,
  patchConnectors,
  type ConnectorId,
  type ConnectorStatus,
} from "@/lib/connectors/api"
import { connectWithPopup } from "@/lib/connectors/oauth-popup"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/auth-provider"
import { toast } from "sonner"

type ComposerPlusMenuProps = {
  canAttach: boolean
  imageOnly: boolean
  canAttachImages: boolean
  canAttachFiles: boolean
  disabled?: boolean
  onAttachClick: () => void
}

function ConnectorMenuItem({
  status,
  busy,
  onAction,
}: {
  status: ConnectorStatus | undefined
  busy: boolean
  onAction: () => void
}) {
  const id = status?.id
  const label = status?.label ?? (id === "outlook" ? "Outlook" : "Notion")
  const initial = label.slice(0, 1)
  const configured = status?.configured ?? false
  const connected = status?.connected ?? false
  const enabled = status?.enabled ?? false

  const badge = !configured
    ? "indisponível"
    : !connected
      ? "conectar"
      : enabled
        ? "ligado"
        : "desligado"

  return (
    <DropdownMenuItem
      disabled={busy || !configured}
      className={cn(!configured && "opacity-60")}
      title={
        !configured
          ? "Conector indisponível neste ambiente."
          : !connected
            ? `Conectar ${label}`
            : enabled
              ? `Desligar ${label}`
              : `Ligar ${label}`
      }
      onSelect={(e) => {
        e.preventDefault()
        if (!configured || busy) return
        onAction()
      }}
    >
      <span className="flex size-4 items-center justify-center text-[10px] font-semibold">
        {initial}
      </span>
      {label}
      <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
        {configured && connected && enabled ? (
          <>
            <Check className="size-3 text-emerald-600" />
            ligado
          </>
        ) : (
          badge
        )}
      </span>
    </DropdownMenuItem>
  )
}

export function ComposerPlusMenu({
  canAttach,
  imageOnly,
  canAttachImages,
  canAttachFiles,
  disabled,
  onAttachClick,
}: ComposerPlusMenuProps) {
  const { refreshProfile } = useAuth()
  const [systemsOpen, setSystemsOpen] = React.useState(false)
  const [connectors, setConnectors] = React.useState<ConnectorStatus[]>([])
  const [busyId, setBusyId] = React.useState<ConnectorId | null>(null)

  const loadConnectors = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchConnectors(signal)
      if (!signal?.aborted) setConnectors(data.connectors)
    } catch {
      if (!signal?.aborted) setConnectors([])
    }
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    void loadConnectors(controller.signal)
    return () => controller.abort()
  }, [loadConnectors])

  const byId = React.useMemo(() => {
    const map = new Map<ConnectorId, ConnectorStatus>()
    for (const c of connectors) map.set(c.id, c)
    return map
  }, [connectors])

  const onConnectorAction = async (id: ConnectorId) => {
    const current = byId.get(id)
    if (!current?.configured) {
      toast.message("Conector indisponível neste ambiente.")
      return
    }
    if (!current.connected) {
      setBusyId(id)
      try {
        const result = await connectWithPopup(
          id,
          `${window.location.pathname}${window.location.search}`,
        )
        if (result === "connected") {
          const data = await fetchConnectors()
          setConnectors(data.connectors)
          await refreshProfile()
          toast.success(`${current.label} conectado`)
        } else if (result === "error") {
          toast.error(`Falha ao conectar ${current.label}.`)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
      return
    }
    const next = !current.enabled
    setBusyId(id)
    try {
      const data = await patchConnectors({ [id]: next })
      setConnectors(data.connectors)
      await refreshProfile()
      toast.success(
        next ? `${current.label} ligado` : `${current.label} desligado`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const attachLabel = imageOnly
    ? "Anexar imagem de referência"
    : canAttachFiles && canAttachImages
      ? "Anexar imagem ou PDF"
      : canAttachImages
        ? "Anexar imagem"
        : canAttachFiles
          ? "Anexar PDF"
          : "Anexar arquivo"

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void loadConnectors()
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            aria-label="Mais opções"
            title="Anexos, sistemas e conectores"
            disabled={disabled}
          >
            <Plus className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Adicionar ao Dexter
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={!canAttach}
            onSelect={(e) => {
              if (!canAttach) {
                e.preventDefault()
                toast.message(
                  imageOnly
                    ? "Este modelo de imagem não aceita referência."
                    : "Escolha um modelo com tag Visão ou Arquivos para anexar.",
                )
                return
              }
              onAttachClick()
            }}
          >
            <FileUp className="size-4" />
            {attachLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSystemsOpen(true)}>
            <Server className="size-4" />
            Sistemas GoWork
          </DropdownMenuItem>
          <ConnectorMenuItem
            status={
              byId.get("notion") ?? {
                id: "notion",
                label: "Notion",
                configured: false,
                connected: false,
                enabled: false,
                authMode: "unconfigured",
                runtimeMode: "none",
                detail: "Indisponível",
              }
            }
            busy={busyId === "notion"}
            onAction={() => void onConnectorAction("notion")}
          />
          <ConnectorMenuItem
            status={
              byId.get("outlook") ?? {
                id: "outlook",
                label: "Outlook",
                configured: false,
                connected: false,
                enabled: false,
                authMode: "unconfigured",
                runtimeMode: "none",
                detail: "Indisponível",
              }
            }
            busy={busyId === "outlook"}
            onAction={() => void onConnectorAction("outlook")}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <ConnectionsDialog
        open={systemsOpen}
        onOpenChange={setSystemsOpen}
        hideTrigger
      />
    </>
  )
}
