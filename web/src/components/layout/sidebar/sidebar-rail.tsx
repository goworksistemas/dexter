import {
  Blocks,
  FolderKanban,
  MessagesSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
} from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { initials, railItemActiveClass, railItemClass } from "./helpers"
import { UserMenuContent, type SidebarUser } from "./sidebar-footer"
import { DexterMark, SidebarTip } from "./shared"

/**
 * Rail (sidebar recolhida, só desktop). Mesmos destinos da navegação
 * expandida, em alvos de 40x40 com tooltip. Nenhuma conversa vira ícone.
 */
export function SidebarRail({
  pathname,
  hasRunningChats,
  user,
  onExpand,
  onNewChat,
  onSearch,
  onSignOut,
}: {
  pathname: string
  hasRunningChats: boolean
  user: SidebarUser | null | undefined
  onExpand: () => void
  onNewChat: () => void
  onSearch: () => void
  onSignOut: () => void
}) {
  const links = [
    {
      to: "/chats",
      label: "Conversas",
      icon: MessagesSquare,
      active:
        pathname === "/chats" ||
        pathname === "/" ||
        pathname.startsWith("/c/") ||
        pathname.startsWith("/p/"),
      badge: hasRunningChats,
    },
    {
      to: "/projects",
      label: "Projetos",
      icon: FolderKanban,
      active: pathname.startsWith("/projects"),
      badge: false,
    },
    {
      to: "/artifacts",
      label: "Artefatos",
      icon: Blocks,
      active: pathname.startsWith("/artifacts"),
      badge: false,
    },
  ]

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-14 w-full shrink-0 items-center justify-center">
        <SidebarTip label="Dexter">
          <span className="flex size-10 items-center justify-center">
            <DexterMark className="size-7 rounded-lg" />
          </span>
        </SidebarTip>
      </div>

      <div className="scroll-thin flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        <SidebarTip label="Expandir menu">
          <button
            type="button"
            aria-label="Expandir menu"
            onClick={onExpand}
            className={railItemClass}
          >
            <PanelLeft className="size-4.5" />
          </button>
        </SidebarTip>

        <SidebarTip label="Nova conversa">
          <button
            type="button"
            aria-label="Nova conversa"
            onClick={onNewChat}
            className={cn(railItemClass, "bg-sidebar-accent text-primary")}
          >
            <Plus className="size-4.5" strokeWidth={2.4} />
          </button>
        </SidebarTip>

        <SidebarTip label="Buscar">
          <button
            type="button"
            aria-label="Buscar conversas"
            onClick={onSearch}
            className={railItemClass}
          >
            <Search className="size-4.5" />
          </button>
        </SidebarTip>

        <span
          aria-hidden
          className="my-1.5 h-px w-6 rounded-full bg-sidebar-border/80"
        />

        {links.map((link) => (
          <SidebarTip key={link.to} label={link.label}>
            <Link
              to={link.to}
              aria-label={link.label}
              aria-current={link.active ? "page" : undefined}
              className={cn(railItemClass, link.active && railItemActiveClass)}
            >
              <link.icon className="size-4.5" />
              {link.badge ? (
                <span
                  aria-hidden
                  className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-sidebar"
                />
              ) : null}
            </Link>
          </SidebarTip>
        ))}
      </div>

      <div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-sidebar-border/60 px-2 py-3">
        <SidebarTip label="Configurações">
          <Link
            to="/settings"
            aria-label="Configurações"
            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
            className={cn(
              railItemClass,
              pathname.startsWith("/settings") && railItemActiveClass,
            )}
          >
            <Settings className="size-4.5" />
          </Link>
        </SidebarTip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Menu do usuário"
              className={railItemClass}
            >
              <Avatar size="sm">
                {user?.avatarUrl ? (
                  <AvatarImage
                    src={user.avatarUrl}
                    alt={user.name || "Avatar"}
                  />
                ) : null}
                <AvatarFallback>
                  {initials(user?.name, user?.email)}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <UserMenuContent
            user={user}
            side="right"
            onNavigate={() => {}}
            onSignOut={onSignOut}
          />
        </DropdownMenu>
      </div>
    </div>
  )
}
