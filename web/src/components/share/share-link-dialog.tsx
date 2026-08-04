import * as React from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  Globe,
  Link2,
  Loader2,
  Search,
  Share2,
  UserPlus,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  fetchArtifactShareStatus,
  fetchChatShareStatus,
  fetchChatUserShares,
  fetchShareableColleagues,
  inviteChatUserShare,
  publicArtifactUrl,
  publicChatUrl,
  publishArtifactShare,
  publishChatShare,
  revokeArtifactShare,
  revokeChatShare,
  revokeUserChatShare,
  type ChatUserShare,
  type ShareableColleague,
  type ShareLinkStatus,
} from "@/lib/share/api"
import { cn } from "@/lib/utils"

type ShareResource = "chat" | "artifact"

const PUBLIC_WARNING =
  "Este conteúdo pode conter dados internos da empresa (clientes, operações, finanças, pessoas). Links públicos podem ser abertos por qualquer pessoa com a URL. A GoWork não recomenda esse uso — prefira compartilhar com um colega via Dexter."

async function loadPublicStatus(
  resource: ShareResource,
  resourceId: string,
): Promise<ShareLinkStatus> {
  return resource === "chat"
    ? fetchChatShareStatus(resourceId)
    : fetchArtifactShareStatus(resourceId)
}

async function publishPublic(
  resource: ShareResource,
  resourceId: string,
): Promise<ShareLinkStatus> {
  return resource === "chat"
    ? publishChatShare(resourceId)
    : publishArtifactShare(resourceId)
}

async function revokePublic(
  resource: ShareResource,
  resourceId: string,
): Promise<void> {
  return resource === "chat"
    ? revokeChatShare(resourceId)
    : revokeArtifactShare(resourceId)
}

function buildUrl(resource: ShareResource, token: string): string {
  return resource === "chat" ? publicChatUrl(token) : publicArtifactUrl(token)
}

function PublicRiskBanner({ className }: { className?: string }) {
  return (
    <div
      className={
        className ??
        "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-950 dark:text-amber-100"
      }
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="space-y-1">
        <p className="font-medium">Atenção — dados internos da empresa</p>
        <p className="text-xs leading-relaxed opacity-90">{PUBLIC_WARNING}</p>
      </div>
    </div>
  )
}

function initials(name: string | null, email: string | null): string {
  const base = (name || email || "?").trim()
  const parts = base.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  }
  return base.slice(0, 2).toUpperCase()
}

function ColleagueTab({
  chatId,
  open,
}: {
  chatId: string
  open: boolean
}) {
  const [colleagues, setColleagues] = React.useState<ShareableColleague[]>([])
  const [shares, setShares] = React.useState<ChatUserShare[]>([])
  const [query, setQuery] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [workingId, setWorkingId] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const [people, invites] = await Promise.all([
        fetchShareableColleagues(),
        fetchChatUserShares(chatId),
      ])
      setColleagues(people)
      setShares(invites)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao carregar.")
    } finally {
      setLoading(false)
    }
  }, [chatId])

  React.useEffect(() => {
    if (!open) return
    setQuery("")
    void reload()
  }, [open, reload])

  const shareByUserId = React.useMemo(() => {
    const map = new Map<string, ChatUserShare>()
    for (const s of shares) map.set(s.toUserId, s)
    return map
  }, [shares])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return colleagues
    return colleagues.filter((c) => {
      const name = (c.fullName || "").toLowerCase()
      const email = (c.email || "").toLowerCase()
      return name.includes(q) || email.includes(q)
    })
  }, [colleagues, query])

  const handleInvite = async (colleague: ShareableColleague) => {
    setWorkingId(colleague.id)
    try {
      const share = await inviteChatUserShare(chatId, { userId: colleague.id })
      setShares((prev) => [share, ...prev.filter((s) => s.id !== share.id)])
      toast.success(
        `Convite enviado para ${share.toName || share.toEmail || "o colega"}. Ele pode criar a cópia em Conversas.`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao compartilhar.")
    } finally {
      setWorkingId(null)
    }
  }

  const handleRevoke = async (shareId: string) => {
    setWorkingId(shareId)
    try {
      await revokeUserChatShare(shareId)
      setShares((prev) => prev.filter((s) => s.id !== shareId))
      toast.success("Convite revogado.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao revogar.")
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Escolha um colega Dexter. Ele poderá criar um <strong>fork</strong>{" "}
        (cópia própria) — a conversa original continua só com você.
      </p>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nome ou e-mail…"
          aria-label="Buscar colega"
          className="h-8 pl-8 text-sm"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Carregando usuários…
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {colleagues.length === 0
            ? "Nenhum outro usuário Dexter disponível."
            : "Nenhum colega nesse filtro."}
        </p>
      ) : (
        <ul className="max-h-[min(22rem,45dvh)] divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {filtered.map((c) => {
            const existing = shareByUserId.get(c.id)
            const pending = existing?.status === "pending"
            const forked = existing?.status === "forked"
            const busy = workingId === c.id || workingId === existing?.id
            return (
              <li
                key={c.id}
                className="flex items-center gap-2.5 px-3 py-2.5"
              >
                <Avatar size="sm" className="size-8 shrink-0">
                  {c.avatarUrl ? (
                    <AvatarImage src={c.avatarUrl} alt="" />
                  ) : null}
                  <AvatarFallback className="text-[10px]">
                    {initials(c.fullName, c.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {c.fullName || c.email || "Usuário"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.email}
                    {pending
                      ? " · convite pendente"
                      : forked
                        ? " · já criou cópia"
                        : ""}
                  </p>
                </div>
                {pending ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 gap-1 text-xs"
                    disabled={busy}
                    onClick={() => void handleRevoke(existing!.id)}
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                    Revogar
                  </Button>
                ) : forked ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-800 dark:text-emerald-200",
                    )}
                  >
                    Copiou
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 text-xs"
                    disabled={busy}
                    onClick={() => void handleInvite(c)}
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <UserPlus className="size-3.5" />
                    )}
                    Compartilhar
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function PublicTab({
  resource,
  resourceId,
  open,
}: {
  resource: ShareResource
  resourceId: string
  open: boolean
}) {
  const [status, setStatus] = React.useState<ShareLinkStatus | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [ackRisk, setAckRisk] = React.useState(false)

  React.useEffect(() => {
    if (!open || !resourceId) return
    let cancelled = false
    setLoading(true)
    setStatus(null)
    setCopied(false)
    setAckRisk(false)
    void loadPublicStatus(resource, resourceId)
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Falha ao carregar.")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, resource, resourceId])

  const publicUrl =
    status?.shareToken ? buildUrl(resource, status.shareToken) : ""

  const handlePublish = async () => {
    if (!ackRisk) {
      toast.error("Confirme o aviso sobre dados internos antes de continuar.")
      return
    }
    setWorking(true)
    try {
      const next = await publishPublic(resource, resourceId)
      setStatus(next)
      toast.success(
        resource === "chat"
          ? "Link público criado. Use com extremo cuidado."
          : "Artefato publicado. Use com extremo cuidado.",
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao publicar.")
    } finally {
      setWorking(false)
    }
  }

  const handleRevoke = async () => {
    const ok = window.confirm(
      "Revogar o link público? Quem já tiver a URL deixará de acessar.",
    )
    if (!ok) return
    setWorking(true)
    try {
      await revokePublic(resource, resourceId)
      setStatus({ shared: false, shareToken: null, sharedAt: null })
      setAckRisk(false)
      toast.success("Link público revogado.")
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Carregando…
      </div>
    )
  }

  if (status?.shared && status.shareToken) {
    return (
      <div className="space-y-3">
        <PublicRiskBanner />
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <Globe className="mt-0.5 size-4 shrink-0" />
          <span>
            Link público ativo — qualquer pessoa com a URL pode visualizar. Não
            recomendamos manter isso ativo com dados sensíveis.
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            readOnly
            value={publicUrl}
            aria-label="Link público"
            className="font-mono text-xs"
          />
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
        </DialogFooter>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PublicRiskBanner />
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={ackRisk}
          onChange={(e) => setAckRisk(e.target.checked)}
          className="mt-0.5 size-4 accent-amber-600"
        />
        <span>
          Entendo que o link é público, pode expor dados internos da empresa e{" "}
          <strong>a GoWork não recomenda</strong> esse uso.
        </span>
      </label>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={working || !ackRisk}
          onClick={() => void handlePublish()}
        >
          {working ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Criando…
            </>
          ) : (
            <>
              <Link2 className="size-4" />
              Criar link público mesmo assim
            </>
          )}
        </Button>
      </DialogFooter>
    </div>
  )
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
  const [tab, setTab] = React.useState<"colleague" | "public">(
    resource === "chat" ? "colleague" : "public",
  )

  React.useEffect(() => {
    if (!open) return
    setTab(resource === "chat" ? "colleague" : "public")
  }, [open, resource])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,40rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-4 py-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-4" />
            {resource === "chat" ? "Compartilhar conversa" : "Publicar artefato"}
          </DialogTitle>
          <DialogDescription>
            {resource === "chat"
              ? "Envie para um colega (ele cria um fork) ou, se realmente necessário, gere um link público."
              : "Gere um link público somente se for inevitável — preferimos não expor artefatos com dados internos."}
          </DialogDescription>
        </DialogHeader>

        {resource === "chat" ? (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "colleague" | "public")}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="shrink-0 border-b border-border px-3 pt-2">
              <TabsList variant="line" className="w-full justify-start">
                <TabsTrigger value="colleague" className="flex-none px-3">
                  <UserPlus className="size-3.5" />
                  Com colega
                </TabsTrigger>
                <TabsTrigger value="public" className="flex-none px-3">
                  <Globe className="size-3.5" />
                  Link público
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <TabsContent value="colleague" className="mt-0">
                <ColleagueTab chatId={resourceId} open={open && tab === "colleague"} />
              </TabsContent>
              <TabsContent value="public" className="mt-0">
                <PublicTab
                  resource={resource}
                  resourceId={resourceId}
                  open={open && tab === "public"}
                />
              </TabsContent>
            </div>
          </Tabs>
        ) : (
          <div className="overflow-y-auto px-4 py-4">
            <PublicTab resource={resource} resourceId={resourceId} open={open} />
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
