import * as React from "react"
import { createPortal } from "react-dom"
import { ChevronDown, FolderInput, Pencil, Trash2 } from "lucide-react"

import { MoveChatDialog } from "@/components/projects/move-chat-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { ChatMenuState, MoveDialogState } from "@/lib/chats/use-chat-actions"

export type ChatActionHandlers = {
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}

const contextItemClass =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"

function useDismiss(
  ref: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    const onPointer = (e: MouseEvent | PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("mousedown", onPointer)
    window.addEventListener("scroll", onClose, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mousedown", onPointer)
      window.removeEventListener("scroll", onClose, true)
    }
  }, [ref, onClose])
}

function useAnchoredPosition(x: number, y: number, w: number, h: number) {
  return React.useMemo(() => {
    const pad = 8
    const left = Math.min(x, window.innerWidth - w - pad)
    const top = Math.min(y, window.innerHeight - h - pad)
    return { left: Math.max(pad, left), top: Math.max(pad, top) }
  }, [x, y, w, h])
}

export function ChatActionDropdownItems({
  onRename,
  onMove,
  onDelete,
}: ChatActionHandlers) {
  return (
    <>
      <DropdownMenuItem onSelect={onRename}>
        <Pencil className="size-4" />
        Renomear
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onMove}>
        <FolderInput className="size-4" />
        Mover para projeto…
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 className="size-4" />
        Excluir
      </DropdownMenuItem>
    </>
  )
}

/** Menu de contexto posicionado no cursor (sidebar, lista /chats). */
export function ChatActionsContextMenu({
  menu,
  onClose,
  onRename,
  onMove,
  onDelete,
}: {
  menu: ChatMenuState
  onClose: () => void
} & ChatActionHandlers) {
  const ref = React.useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  const style = useAnchoredPosition(menu.x, menu.y, 200, 132)

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Ações da conversa"
      className="shadow-elevate-md fixed z-[200] min-w-48 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground"
      style={style}
    >
      <button
        type="button"
        role="menuitem"
        className={contextItemClass}
        onClick={() => {
          onRename()
          onClose()
        }}
      >
        <Pencil className="size-4" />
        Renomear
      </button>
      <button
        type="button"
        role="menuitem"
        className={contextItemClass}
        onClick={() => {
          onMove()
          onClose()
        }}
      >
        <FolderInput className="size-4" />
        Mover para projeto…
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none hover:bg-destructive/10"
        onClick={() => {
          onDelete()
          onClose()
        }}
      >
        <Trash2 className="size-4" />
        Excluir
      </button>
    </div>,
    document.body,
  )
}

/** Título clicável do header com dropdown de ações da conversa ativa. */
export function ChatHeaderTitle({
  title,
  subtitle,
  isRenaming,
  renameValue,
  renameInputRef,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  actions,
}: {
  title: string
  subtitle?: string
  isRenaming: boolean
  renameValue: string
  renameInputRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  actions: ChatActionHandlers
}) {
  if (isRenaming) {
    return (
      <div className="min-w-0 leading-tight">
        <Input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              onRenameCommit()
            }
            if (e.key === "Escape") onRenameCancel()
          }}
          className="h-7 max-w-xs text-sm"
          aria-label="Novo título da conversa"
        />
        {subtitle ? (
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="min-w-0 leading-tight">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "group flex max-w-full min-w-0 items-center gap-0.5 rounded-md px-1 -mx-1",
              "text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-label={`Ações da conversa ${title}`}
            aria-haspopup="menu"
          >
            <span className="truncate text-sm font-medium text-foreground/90">
              {title}
            </span>
            <ChevronDown
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <ChatActionDropdownItems {...actions} />
        </DropdownMenuContent>
      </DropdownMenu>
      {subtitle ? (
        <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

/** Portal de menu de contexto + dialog de mover conversa. */
export function ChatActionsOverlays({
  chatMenu,
  onCloseChatMenu,
  actionsForMenu,
  moveDialog,
  onMoveDialogOpenChange,
}: {
  chatMenu: ChatMenuState | null
  onCloseChatMenu: () => void
  actionsForMenu: ChatActionHandlers | null
  moveDialog: MoveDialogState
  onMoveDialogOpenChange: (open: boolean) => void
}) {
  return (
    <>
      {chatMenu && actionsForMenu ? (
        <ChatActionsContextMenu
          menu={chatMenu}
          onClose={onCloseChatMenu}
          {...actionsForMenu}
        />
      ) : null}
      <MoveChatDialog
        open={moveDialog.open}
        onOpenChange={onMoveDialogOpenChange}
        chatId={moveDialog.chatId}
        chatTitle={moveDialog.title}
        currentProjectId={moveDialog.projectId}
      />
    </>
  )
}
