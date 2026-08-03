import * as React from "react"
import { MessageSquare, MoreHorizontal } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ChatSummary } from "@/lib/chats"
import { sidebarRowActiveClass, sidebarRowClass } from "./helpers"
import { RunningDots, SidebarNotice } from "./shared"

export type ChatRenameState = {
  id: string | null
  value: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onCommit: (id: string) => void
  onCancel: () => void
}

/**
 * Conversas recentes: uma linha por conversa, título truncado em uma linha,
 * 32px de altura. A lista é curta de propósito — o resto vive em /chats.
 */
export function ChatsSection({
  chats,
  total,
  isLoading,
  error,
  activeChatId,
  runningChatIds,
  hasQuery,
  rename,
  onRetry,
  onSelect,
  onOpenMenu,
  onNavigate,
}: {
  chats: ChatSummary[]
  total: number
  isLoading: boolean
  error: string | null
  activeChatId: string
  runningChatIds: ReadonlySet<string>
  hasQuery: boolean
  rename: ChatRenameState
  onRetry: () => void
  onSelect: (chat: ChatSummary) => void
  onOpenMenu: (event: React.MouseEvent, chat: ChatSummary) => void
  onNavigate: () => void
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {isLoading ? (
        <SidebarNotice>Carregando conversas…</SidebarNotice>
      ) : error ? (
        <div className="space-y-1 px-2 py-1.5">
          <p className="text-[13px] text-destructive">
            Não foi possível carregar as conversas.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="text-xs font-medium text-primary hover:underline"
          >
            Tentar de novo
          </button>
        </div>
      ) : chats.length === 0 ? (
        <SidebarNotice>
          {hasQuery
            ? "Nenhuma conversa encontrada."
            : "Nenhuma conversa ainda."}
        </SidebarNotice>
      ) : (
        chats.map((chat) => {
          const title = chat.title || "Sem título"
          const active = activeChatId === chat.id
          const running = runningChatIds.has(chat.id)

          if (rename.id === chat.id) {
            return (
              <div key={chat.id} className="px-0.5 py-0.5">
                <Input
                  ref={rename.inputRef}
                  value={rename.value}
                  onChange={(e) => rename.onChange(e.target.value)}
                  onBlur={() => rename.onCommit(chat.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      rename.onCommit(chat.id)
                    }
                    if (e.key === "Escape") rename.onCancel()
                  }}
                  className="h-8 text-[13px]"
                  aria-label="Novo título da conversa"
                />
              </div>
            )
          }

          return (
            <div
              key={chat.id}
              onContextMenu={(e) => onOpenMenu(e, chat)}
              className={cn(
                "group/item relative flex items-center rounded-lg pr-1 transition-colors hover:bg-sidebar-accent",
                active && "bg-sidebar-accent",
              )}
            >
              <button
                type="button"
                title={title}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(chat)}
                className={cn(
                  sidebarRowClass,
                  "flex-1 hover:bg-transparent",
                  active && sidebarRowActiveClass,
                  active && "bg-transparent",
                )}
              >
                <MessageSquare
                  aria-hidden
                  className="size-4 shrink-0 text-sidebar-foreground/45"
                />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {running ? <RunningDots /> : null}
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 shrink-0 text-sidebar-foreground/55 opacity-100 hover:bg-sidebar-border/60 hover:text-sidebar-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover/item:opacity-100"
                aria-label={`Ações da conversa ${title}`}
                aria-haspopup="menu"
                onClick={(e) => onOpenMenu(e, chat)}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </div>
          )
        })
      )}

      {!isLoading && !error && total > chats.length ? (
        <Link
          to="/chats"
          onClick={onNavigate}
          className={cn(sidebarRowClass, "text-sidebar-foreground/50")}
        >
          <span className="size-4 shrink-0" aria-hidden />
          Ver todos
        </Link>
      ) : null}
    </div>
  )
}
