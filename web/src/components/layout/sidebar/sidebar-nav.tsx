import {
  Blocks,
  FolderKanban,
  MessagesSquare,
  Plus,
  Settings,
} from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"
import {
  newChatShortcut,
  sidebarRowActiveClass,
  sidebarRowClass,
} from "./helpers"

type NavItem = {
  to: string
  label: string
  icon: typeof MessagesSquare
  isActive: (pathname: string) => boolean
}

/** Só destinos que existem de verdade — nada de item decorativo. */
const NAV_ITEMS: NavItem[] = [
  {
    to: "/chats",
    label: "Conversas",
    icon: MessagesSquare,
    isActive: (p) =>
      p === "/chats" || p === "/" || p.startsWith("/c/") || p.startsWith("/p/"),
  },
  {
    to: "/projects",
    label: "Projetos",
    icon: FolderKanban,
    isActive: (p) => p.startsWith("/projects"),
  },
  {
    to: "/artifacts",
    label: "Artefatos",
    icon: Blocks,
    isActive: (p) => p.startsWith("/artifacts"),
  },
  {
    to: "/settings",
    label: "Configurações",
    icon: Settings,
    isActive: (p) => p.startsWith("/settings"),
  },
]

export function SidebarNav({
  pathname,
  onNewChat,
  onNavigate,
}: {
  pathname: string
  onNewChat: () => void
  onNavigate: () => void
}) {
  return (
    <div className="shrink-0 px-2">
      <button
        type="button"
        onClick={onNewChat}
        className="flex h-9 w-full items-center gap-2.5 rounded-lg bg-sidebar-accent px-2 text-[13px] font-medium text-sidebar-accent-foreground transition-colors outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
      >
        <Plus
          aria-hidden
          className="size-4 shrink-0 text-primary"
          strokeWidth={2.4}
        />
        Novo
        <kbd className="ml-auto rounded border border-sidebar-border/80 px-1.5 py-0.5 font-sans text-[10px] font-normal text-sidebar-foreground/45">
          {newChatShortcut}
        </kbd>
      </button>

      <nav className="mt-1 flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(pathname)
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(sidebarRowClass, active && sidebarRowActiveClass)}
            >
              <item.icon
                aria-hidden
                className="size-4 shrink-0 text-sidebar-foreground/60"
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
