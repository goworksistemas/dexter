import * as React from "react"
import { createPortal } from "react-dom"
import { FolderInput, Pencil, Trash2 } from "lucide-react"

export type ChatMenuState = {
  chatId: string
  title: string
  projectId: string | null
  x: number
  y: number
}

const menuItemClass =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"

/** Fecha o menu ao pressionar Esc, clicar fora ou rolar a página. */
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

/** Mantém o menu dentro da viewport a partir da posição do cursor. */
function useAnchoredPosition(x: number, y: number, w: number, h: number) {
  return React.useMemo(() => {
    const pad = 8
    const left = Math.min(x, window.innerWidth - w - pad)
    const top = Math.min(y, window.innerHeight - h - pad)
    return { left: Math.max(pad, left), top: Math.max(pad, top) }
  }, [x, y, w, h])
}

export function ChatActionsMenu({
  menu,
  onClose,
  onRename,
  onMove,
  onDelete,
}: {
  menu: ChatMenuState
  onClose: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}) {
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
        className={menuItemClass}
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
        className={menuItemClass}
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
