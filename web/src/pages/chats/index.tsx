import * as React from "react"
import { MessageSquare, Plus, Search } from "lucide-react"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useChatRuns, useChats } from "@/lib/chats"
import { formatRelative } from "@/lib/dates"
import { useProjects } from "@/lib/projects"
import { RunningDots } from "@/components/layout/sidebar/shared"

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
              const project = chat.project_id
                ? projectName.get(chat.project_id)
                : undefined
              return (
                <li key={chat.id}>
                  <button
                    type="button"
                    onClick={() => selectChat(chat.id)}
                    aria-current={active ? "page" : undefined}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <MessageSquare
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                      {chat.title || "Sem título"}
                    </span>
                    {runningChatIds.has(chat.id) ? <RunningDots /> : null}
                    {project ? (
                      <span className="hidden max-w-40 shrink-0 truncate rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
                        {project}
                      </span>
                    ) : null}
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                      {formatRelative(chat.updated_at)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </PageShell>
  )
}
