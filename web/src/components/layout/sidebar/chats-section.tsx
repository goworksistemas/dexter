import * as React from "react"
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react"
import { Link } from "react-router-dom"

import { ChatSelectCheckbox } from "@/components/chat/bulk-actions"
import { ChatCostInfo } from "@/components/chat/cost-info"
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

/** Seleção em massa da sidebar — controlada pelo Sidebar (dono da barra). */
export type ChatSelectionState = {
  /** Checkboxes visíveis em todas as linhas (há algo selecionado). */
  ativa: boolean
  selecionadas: ReadonlySet<string>
  onToggle: (id: string) => void
}

/**
 * Conversas recentes: uma linha por conversa, título truncado em uma linha,
 * 32px de altura. A lista é curta de propósito — o resto vive em /chats.
 * No hover (desktop) o ícone vira checkbox para selecionar várias; a seção
 * "Arquivadas" fica colapsada no rodapé da lista.
 */
export function ChatsSection({
  chats,
  archivedChats,
  total,
  isLoading,
  error,
  activeChatId,
  runningChatIds,
  hasQuery,
  rename,
  selection,
  onRetry,
  onSelect,
  onOpenMenu,
  onNavigate,
  onUnarchive,
}: {
  /** Conversas ativas (não arquivadas) já filtradas/limitadas. */
  chats: ChatSummary[]
  /** Conversas arquivadas (seção colapsada por padrão). */
  archivedChats: ChatSummary[]
  total: number
  isLoading: boolean
  error: string | null
  activeChatId: string
  runningChatIds: ReadonlySet<string>
  hasQuery: boolean
  rename: ChatRenameState
  selection: ChatSelectionState
  onRetry: () => void
  onSelect: (chat: ChatSummary) => void
  onOpenMenu: (event: React.MouseEvent, chat: ChatSummary) => void
  onNavigate: () => void
  onUnarchive: (chat: ChatSummary) => void
}) {
  const [arquivadasAbertas, setArquivadasAbertas] = React.useState(false)

  const renderRow = (chat: ChatSummary, arquivada: boolean) => {
    const title = chat.title || "Sem título"
    const active = activeChatId === chat.id
    const running = runningChatIds.has(chat.id)
    const marcada = selection.selecionadas.has(chat.id)

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
          marcada && "bg-sidebar-accent/70",
        )}
      >
        {/* Slot do ícone fora do botão da linha (botão aninhado é inválido):
            vira checkbox quando há seleção ou no hover em desktop. */}
        <span className="ml-2 flex size-4 shrink-0 items-center justify-center">
          {selection.ativa ? (
            <ChatSelectCheckbox
              checked={marcada}
              title={title}
              onToggle={() => selection.onToggle(chat.id)}
            />
          ) : (
            <>
              <MessageSquare
                aria-hidden
                className="size-4 text-sidebar-foreground/45 md:group-hover/item:hidden"
              />
              <ChatSelectCheckbox
                checked={false}
                title={title}
                onToggle={() => selection.onToggle(chat.id)}
                className="hidden md:group-hover/item:flex"
              />
            </>
          )}
        </span>
        <button
          type="button"
          title={title}
          aria-current={active && !selection.ativa ? "page" : undefined}
          onClick={() =>
            selection.ativa ? selection.onToggle(chat.id) : onSelect(chat)
          }
          className={cn(
            sidebarRowClass,
            "min-w-0 flex-1 hover:bg-transparent",
            active && sidebarRowActiveClass,
            active && "bg-transparent",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {running ? <RunningDots /> : null}
        </button>
        {arquivada ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 text-sidebar-foreground/55 opacity-100 hover:bg-sidebar-border/60 hover:text-sidebar-foreground md:opacity-0 md:group-hover/item:opacity-100"
            aria-label={`Desarquivar a conversa ${title}`}
            title="Desarquivar"
            onClick={() => onUnarchive(chat)}
          >
            <ArchiveRestore className="size-3.5" />
          </Button>
        ) : null}
        <ChatCostInfo
          costUsd={chat.cost_usd}
          compact
          className="opacity-100 md:opacity-0 md:group-hover/item:opacity-100"
        />
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
  }

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
      ) : chats.length === 0 && archivedChats.length === 0 ? (
        <SidebarNotice>
          {hasQuery
            ? "Nenhuma conversa encontrada."
            : "Nenhuma conversa ainda."}
        </SidebarNotice>
      ) : (
        chats.map((chat) => renderRow(chat, false))
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

      {!isLoading && !error && archivedChats.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setArquivadasAbertas((v) => !v)}
            aria-expanded={arquivadasAbertas}
            className={cn(sidebarRowClass, "mt-1 text-sidebar-foreground/60")}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 shrink-0 transition-transform",
                arquivadasAbertas && "rotate-90",
              )}
            />
            <Archive aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Arquivadas</span>
            <span className="text-[11px] text-sidebar-foreground/45">
              {archivedChats.length}
            </span>
          </button>
          {arquivadasAbertas
            ? archivedChats.map((chat) => renderRow(chat, true))
            : null}
        </>
      ) : null}
    </div>
  )
}
