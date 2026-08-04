import * as React from "react"
import {
  GitFork,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Share2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  ChatActionDropdownItems,
  ChatActionsOverlays,
} from "@/components/chat/chat-actions"
import { ChatCostInfo } from "@/components/chat/cost-info"
import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useChatActions, useChatRuns, useChats } from "@/lib/chats"
import { formatRelative } from "@/lib/dates"
import { useProjects } from "@/lib/projects"
import { RunningDots } from "@/components/layout/sidebar/shared"
import {
  fetchPendingChatShares,
  forkChatShare,
  revokeUserChatShare,
  type ChatUserShare,
} from "@/lib/share/api"

function PendingSharesSection({
  onForked,
}: {
  onForked: (chatId: string) => void
}) {
  const [shares, setShares] = React.useState<ChatUserShare[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      setShares(await fetchPendingChatShares())
    } catch {
      setShares([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload])

  if (loading || shares.length === 0) return null

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-violet-500/30 bg-violet-500/5">
      <div className="flex items-center gap-2 border-b border-violet-500/20 px-4 py-2.5">
        <Share2 className="size-4 text-violet-700 dark:text-violet-300" />
        <p className="text-sm font-medium text-violet-900 dark:text-violet-100">
          Compartilhadas com você
        </p>
        <span className="text-xs text-violet-700/80 dark:text-violet-300/80">
          {shares.length}
        </span>
      </div>
      <ul className="divide-y divide-violet-500/15">
        {shares.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-2 px-4 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {s.chatTitle?.trim() || "Conversa sem título"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                De {s.fromName || s.fromEmail || "colega"}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={busyId === s.id}
              onClick={() => {
                setBusyId(s.id)
                void forkChatShare(s.id)
                  .then(({ chatId }) => {
                    setShares((prev) => prev.filter((x) => x.id !== s.id))
                    toast.success("Cópia criada — a conversa é sua agora.")
                    onForked(chatId)
                  })
                  .catch((err) => {
                    toast.error(
                      err instanceof Error ? err.message : "Falha ao criar cópia.",
                    )
                  })
                  .finally(() => setBusyId(null))
              }}
            >
              {busyId === s.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <GitFork className="size-3.5" />
              )}
              Criar cópia
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8"
              aria-label="Recusar convite"
              disabled={busyId === s.id}
              onClick={() => {
                setBusyId(s.id)
                void revokeUserChatShare(s.id)
                  .then(() => {
                    setShares((prev) => prev.filter((x) => x.id !== s.id))
                    toast.success("Convite recusado.")
                  })
                  .catch((err) => {
                    toast.error(
                      err instanceof Error ? err.message : "Falha ao recusar.",
                    )
                  })
                  .finally(() => setBusyId(null))
              }}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ChatsPage() {
  const {
    chats,
    isLoadingChats,
    chatsError,
    activeChatId,
    selectChat,
    newChat,
    refreshChats,
  } = useChats()
  const chatActions = useChatActions()
  const { runningChatIds } = useChatRuns()
  const { projects } = useProjects()
  const [query, setQuery] = React.useState("")

  const projectName = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const project of projects) map.set(project.id, project.name)
    return map
  }, [projects])

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chats
    return chats.filter((c) => (c.title || "").toLowerCase().includes(q))
  }, [chats, query])

  const chatMenuActions = chatActions.chatMenu
    ? chatActions.actionsForChat(
        chatActions.chatMenu.chatId,
        chatActions.chatMenu.title,
        chatActions.chatMenu.projectId,
      )
    : null

  return (
    <PageShell>
      <PageHeading
        title="Conversas"
        description={`${chats.length} ${chats.length === 1 ? "conversa" : "conversas"}`}
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => newChat(null)}>
            <Plus className="size-4" />
            Nova conversa
          </Button>
        }
      />

      <PendingSharesSection
        onForked={(chatId) => {
          refreshChats()
          selectChat(chatId)
        }}
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
          aria-label="Buscar conversas"
          className="h-9 pl-9 text-sm"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
        {isLoadingChats ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 rounded-md" />
            ))}
          </div>
        ) : chatsError ? (
          <div className="space-y-2 p-6">
            <p className="text-sm text-destructive">
              Não foi possível carregar as conversas.
            </p>
            <Button variant="outline" size="sm" onClick={() => refreshChats()}>
              Tentar de novo
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {query.trim()
              ? "Nenhuma conversa encontrada."
              : "Nenhuma conversa ainda."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((chat) => {
              const active = chat.id === activeChatId
              const title = chat.title || "Sem título"
              const project = chat.project_id
                ? projectName.get(chat.project_id)
                : undefined
              const actions = chatActions.actionsForChat(
                chat.id,
                title,
                chat.project_id,
              )

              if (chatActions.renamingId === chat.id) {
                return (
                  <li key={chat.id} className="px-4 py-2">
                    <Input
                      ref={chatActions.renameInputRef}
                      value={chatActions.renameValue}
                      onChange={(e) =>
                        chatActions.setRenameValue(e.target.value)
                      }
                      onBlur={() => void chatActions.commitRename(chat.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void chatActions.commitRename(chat.id)
                        }
                        if (e.key === "Escape") chatActions.cancelRename()
                      }}
                      className="h-8 text-sm"
                      aria-label="Novo título da conversa"
                    />
                  </li>
                )
              }

              return (
                <li
                  key={chat.id}
                  className="group/row flex items-center"
                  onContextMenu={(e) => chatActions.openChatMenu(e, chat)}
                >
                  <button
                    type="button"
                    onClick={() => selectChat(chat.id)}
                    aria-current={active ? "page" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <MessageSquare
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                      {title}
                    </span>
                    {runningChatIds.has(chat.id) ? <RunningDots /> : null}
                    <ChatCostInfo costUsd={chat.cost_usd} />
                    {project ? (
                      <span className="hidden max-w-40 shrink-0 truncate rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
                        {project}
                      </span>
                    ) : null}
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                      {formatRelative(chat.updated_at)}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="mr-2 size-8 shrink-0 opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100"
                        aria-label={`Ações da conversa ${title}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                      <ChatActionDropdownItems {...actions} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <ChatActionsOverlays
        chatMenu={chatActions.chatMenu}
        onCloseChatMenu={chatActions.closeChatMenu}
        actionsForMenu={chatMenuActions}
        moveDialog={chatActions.moveDialog}
        onMoveDialogOpenChange={(open) =>
          chatActions.setMoveDialog((prev) => ({ ...prev, open }))
        }
        shareDialog={chatActions.shareDialog}
        onShareDialogOpenChange={(open) =>
          chatActions.setShareDialog((prev) => ({ ...prev, open }))
        }
      />
    </PageShell>
  )
}
