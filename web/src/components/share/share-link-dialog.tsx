import * as React from "react"
import { Check, Copy, Globe, Link2, Loader2, Share2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  fetchArtifactShareStatus,
  fetchChatShareStatus,
  publicArtifactUrl,
  publicChatUrl,
  publishArtifactShare,
  publishChatShare,
  revokeArtifactShare,
  revokeChatShare,
  type ShareLinkStatus,
} from "@/lib/share/api"

type ShareResource = "chat" | "artifact"

const COPY_LABEL: Record<ShareResource, string> = {
  chat: "Compartilhar conversa",
  artifact: "Publicar artefato",
}

const COPY_DESC: Record<ShareResource, string> = {
  chat:
    "Qualquer pessoa com o link pode ver esta conversa (somente leitura). Você pode revogar o acesso a qualquer momento.",
  artifact:
    "Qualquer pessoa com o link pode ver este artefato (somente leitura). Você pode revogar o acesso a qualquer momento.",
}

async function loadStatus(
  resource: ShareResource,
  resourceId: string,
): Promise<ShareLinkStatus> {
  return resource === "chat"
    ? fetchChatShareStatus(resourceId)
    : fetchArtifactShareStatus(resourceId)
}

async function publish(
  resource: ShareResource,
  resourceId: string,
): Promise<ShareLinkStatus> {
  return resource === "chat"
    ? publishChatShare(resourceId)
    : publishArtifactShare(resourceId)
}

async function revoke(resource: ShareResource, resourceId: string): Promise<void> {
  return resource === "chat"
    ? revokeChatShare(resourceId)
    : revokeArtifactShare(resourceId)
}

function buildUrl(resource: ShareResource, token: string): string {
  return resource === "chat" ? publicChatUrl(token) : publicArtifactUrl(token)
}

export function ShareLinkDialog({
  resource,
  resourceId,
  open,
  onOpenChange,
}: {
  resource: ShareResource
  resourceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [status, setStatus] = React.useState<ShareLinkStatus | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!open || !resourceId) return
    let cancelled = false
    setLoading(true)
    setStatus(null)
    setCopied(false)
    void loadStatus(resource, resourceId)
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Falha ao carregar.")
          onOpenChange(false)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, resource, resourceId, onOpenChange])

  const publicUrl =
    status?.shareToken ? buildUrl(resource, status.shareToken) : ""

  const handlePublish = async () => {
    setWorking(true)
    try {
      const next = await publish(resource, resourceId)
      setStatus(next)
      toast.success(
        resource === "chat" ? "Link de compartilhamento criado." : "Artefato publicado.",
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao publicar.")
    } finally {
      setWorking(false)
    }
  }

  const handleRevoke = async () => {
    const ok = window.confirm(
      "Revogar o link? Quem já tiver o link deixará de acessar.",
    )
    if (!ok) return
    setWorking(true)
    try {
      await revoke(resource, resourceId)
      setStatus({ shared: false, shareToken: null, sharedAt: null })
      toast.success("Link revogado.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao revogar.")
    } finally {
      setWorking(false)
    }
  }

  const handleCopy = async () => {
    if (!publicUrl) return
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      toast.success("Link copiado.")
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Não foi possível copiar o link.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-4" />
            {COPY_LABEL[resource]}
          </DialogTitle>
          <DialogDescription>{COPY_DESC[resource]}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Carregando…
          </div>
        ) : status?.shared && status.shareToken ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
              <Globe className="mt-0.5 size-4 shrink-0" />
              <span>Link público ativo — qualquer pessoa pode visualizar.</span>
            </div>
            <div className="flex gap-2">
              <Input readOnly value={publicUrl} aria-label="Link público" className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copiar link"
                onClick={() => void handleCopy()}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="destructive"
                disabled={working}
                onClick={() => void handleRevoke()}
              >
                Revogar link
              </Button>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Fechar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Ainda não há link público para este conteúdo.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="button" disabled={working} onClick={() => void handlePublish()}>
                {working ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Criando…
                  </>
                ) : (
                  <>
                    <Link2 className="size-4" />
                    Criar link público
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Botão compacto que abre o dialog de compartilhamento. */
export function ShareLinkButton({
  resource,
  resourceId,
  disabled,
  variant = "ghost",
  size = "icon-sm",
  className,
  label = "Compartilhar",
}: {
  resource: ShareResource
  resourceId: string | null | undefined
  disabled?: boolean
  variant?: "ghost" | "outline" | "secondary"
  size?: "icon-sm" | "sm"
  className?: string
  label?: string
}) {
  const [open, setOpen] = React.useState(false)

  if (!resourceId) return null

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={disabled}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <Share2 className="size-4" />
        {size === "sm" ? <span>{label}</span> : null}
      </Button>
      <ShareLinkDialog
        resource={resource}
        resourceId={resourceId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}
