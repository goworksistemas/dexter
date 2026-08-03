import { ChevronsUpDown, LogOut, Settings, UserRound } from "lucide-react"
import { Link } from "react-router-dom"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { initials } from "./helpers"

export type SidebarUser = {
  name?: string
  email?: string | null
  avatarUrl?: string | null
}

/** Menu de conta reutilizado pelo rodapé da sidebar e pelo rail. */
export function UserMenuContent({
  user,
  side = "top",
  onNavigate,
  onSignOut,
}: {
  user: SidebarUser | null | undefined
  side?: "top" | "right"
  onNavigate: () => void
  onSignOut: () => void
}) {
  return (
    <DropdownMenuContent side={side} align="start" className="min-w-56">
      <DropdownMenuLabel className="font-normal">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <UserRound className="size-3.5 text-muted-foreground" />
            {user?.name || "Usuário"}
          </span>
          {user?.email ? (
            <span className="truncate text-xs text-muted-foreground">
              {user.email}
            </span>
          ) : null}
        </div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/settings" onClick={onNavigate}>
          <Settings className="size-4" />
          Configurações
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
        <LogOut className="size-4" />
        Sair
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

/** Rodapé fixo da sidebar expandida: identidade do usuário. */
export function SidebarFooter({
  user,
  onNavigate,
  onSignOut,
}: {
  user: SidebarUser | null | undefined
  onNavigate: () => void
  onSignOut: () => void
}) {
  return (
    <div className="shrink-0 border-t border-sidebar-border/60 p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            aria-label="Menu do usuário"
          >
            <Avatar size="sm">
              {user?.avatarUrl ? (
                <AvatarImage src={user.avatarUrl} alt={user.name || "Avatar"} />
              ) : null}
              <AvatarFallback>
                {initials(user?.name, user?.email)}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
              {user?.name || "Usuário"}
            </span>
            <ChevronsUpDown
              aria-hidden
              className="size-3.5 shrink-0 text-sidebar-foreground/45"
            />
          </button>
        </DropdownMenuTrigger>
        <UserMenuContent
          user={user}
          onNavigate={onNavigate}
          onSignOut={onSignOut}
        />
      </DropdownMenu>
    </div>
  )
}
