import * as React from "react"
import { createPortal } from "react-dom"
import {
  Brain,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useSidebar } from "@/hooks/use-sidebar"
import { useChats } from "@/lib/chats"
import { useAuth } from "@/providers/auth-provider"

function initials(name?: string, email?: string | null): string {
  const source = (name || email || "?").trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

type ChatMenuState = {
  chatId: string
  title: string
  x: number
  y: number
}

function ChatActionsMenu({
  menu,
  onClose,
  onRename,
  onDelete,
}: {
  menu: ChatMenuState
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)

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
  }, [onClose])

  // Mantém o menu dentro da viewport.
  const style = React.useMemo(() => {
    const pad = 8
    const w = 176
    const h = 88
    const x = Math.min(menu.x, window.innerWidth - w - pad)
    const y = Math.min(menu.y, window.innerHeight - h - pad)
    return { left: Math.max(pad, x), top: Math.max(pad, y) }
  }, [menu.x, menu.y])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Ações da conversa"
      className="fixed z-[200] min-w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={style}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
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

export function Sidebar() {
  const { open, setOpen } = useSidebar()
  const {
    chats,
    isLoadingChats,
    chatsError,
    activeChatId,
    newChat,
    selectChat,
    renameChat,
    deleteChat,
    refreshChats,
  } = useChats()
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [query, setQuery] = React.useState("")
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState("")
  const [menu, setMenu] = React.useState<ChatMenuState | null>(null)
  const renameInputRef = React.useRef<HTMLInputElement>(null)

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chats
    return chats.filter((c) => (c.title || "").toLowerCase().includes(q))
  }, [chats, query])

  React.useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  const handleSignOut = async () => {
    try {
      await signOut()
      toast.success("Sessão encerrada.")
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao sair.")
    }
  }

  const startRename = (id: string, current: string) => {
    setRenamingId(id)
    setRenameValue(current || "")
  }

  const commitRename = async (id: string) => {
    const title = renameValue.trim()
    setRenamingId(null)
    if (!title || title.length > 120) {
      toast.error("Título deve ter entre 1 e 120 caracteres.")
      return
    }
    const atual = chats.find((c) => c.id === id)?.title
    if (title === atual) return
    try {
      await renameChat(id, title)
      toast.success("Conversa renomeada.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao renomear.")
    }
  }

  const handleDelete = async (id: string, title: string) => {
    const ok = window.confirm(
      `Excluir a conversa "${title || "sem título"}"? Esta ação não pode ser desfeita.`,
    )
    if (!ok) return
    try {
      await deleteChat(id)
      toast.success("Conversa excluída.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao excluir.")
    }
  }

  const openMenuAt = (
    e: React.MouseEvent,
    chatId: string,
    title: string,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ chatId, title, x: e.clientX, y: e.clientY })
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-foreground/20 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 md:static md:z-auto md:h-full md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex shrink-0 items-center gap-2.5 px-4 py-4">
          <span
            className="flex size-7 items-center justify-center rounded-full bg-violet-500 text-white"
            aria-hidden
          >
            <Brain className="size-3.5" strokeWidth={2.5} />
          </span>
          <span className="text-lg font-semibold text-sidebar-foreground">
            Dexter
          </span>
        </div>

        <div className="shrink-0 space-y-2 px-3 pb-2">
          <Button
            className="w-full justify-start gap-2"
            onClick={() => {
              newChat()
              setOpen(false)
            }}
          >
            <Plus className="size-4" />
            Nova conversa
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar conversas..."
              className="h-8 bg-sidebar pl-8 text-sm"
              aria-label="Buscar conversas"
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          <nav className="flex flex-col gap-0.5 px-2 py-1">
            {isLoadingChats ? (
              <p className="px-3 py-2 text-sm text-sidebar-foreground/60">
                Carregando conversas...
              </p>
            ) : chatsError ? (
              <div className="space-y-2 px-3 py-2">
                <p className="text-sm text-destructive">
                  Não foi possível carregar as conversas.
                </p>
                <button
                  type="button"
                  onClick={() => refreshChats()}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Tentar de novo
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-sidebar-foreground/60">
                {query.trim()
                  ? "Nenhuma conversa encontrada."
                  : "Nenhuma conversa ainda."}
              </p>
            ) : (
              filtered.map((chat) => {
                const title = chat.title || "Sem título"
                const active = activeChatId === chat.id
                return (
                  <div
                    key={chat.id}
                    className={cn(
                      "group flex items-start gap-0.5 rounded-md transition-colors hover:bg-sidebar-accent",
                      active && "bg-sidebar-accent",
                    )}
                    onContextMenu={(e) => openMenuAt(e, chat.id, title)}
                  >
                    {renamingId === chat.id ? (
                      <Input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(chat.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            void commitRename(chat.id)
                          }
                          if (e.key === "Escape") {
                            setRenamingId(null)
                          }
                        }}
                        className="mx-1 my-1 h-8 flex-1 text-sm"
                        aria-label="Novo título da conversa"
                      />
                    ) : (
                      <button
                        type="button"
                        title={title}
                        onClick={() => {
                          selectChat(chat.id)
                          setOpen(false)
                        }}
                        className={cn(
                          "min-w-0 flex-1 px-2.5 py-2 text-left text-sm leading-snug text-sidebar-foreground/85 break-words whitespace-normal",
                          active &&
                            "font-medium text-sidebar-accent-foreground",
                        )}
                      >
                        <span className="line-clamp-2">{title}</span>
                      </button>
                    )}

                    {renamingId !== chat.id ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="mt-1 mr-0.5 size-7 shrink-0 text-sidebar-foreground/70 opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:opacity-70 md:group-hover:opacity-100"
                        aria-label="Ações da conversa"
                        aria-haspopup="menu"
                        onClick={(e) => openMenuAt(e, chat.id, title)}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                )
              })
            )}
          </nav>
        </ScrollArea>

        <div className="flex shrink-0 flex-col gap-1 border-t border-sidebar-border px-3 py-3">
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Settings className="size-4" />
            Configurações
          </Link>
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 items-center gap-2">
              <Avatar size="sm">
                {user?.avatarUrl ? (
                  <AvatarImage src={user.avatarUrl} alt={user.name || "Avatar"} />
                ) : null}
                <AvatarFallback>
                  {initials(user?.name, user?.email)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-sidebar-foreground">
                  {user?.name || "Usuário"}
                </p>
                {user?.email ? (
                  <p className="truncate text-xs text-sidebar-foreground/60">
                    {user.email}
                  </p>
                ) : null}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Sair"
              className="shrink-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => void handleSignOut()}
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      {menu ? (
        <ChatActionsMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={() => startRename(menu.chatId, menu.title)}
          onDelete={() => void handleDelete(menu.chatId, menu.title)}
        />
      ) : null}
    </>
  )
}
