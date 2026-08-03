import { LogOut, Menu, Monitor, Moon, Settings, Sun, UserRound } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/providers/theme-provider"
import { useAuth } from "@/providers/auth-provider"
import { useSidebar } from "@/hooks/use-sidebar"
import { useChats } from "@/lib/chats"
import { ModelSelector } from "@/components/chat/model-selector"
import { updateProfileTheme } from "@/lib/supabase"
import type { Theme } from "@/providers/theme-provider"

function initials(name?: string, email?: string | null): string {
  const source = (name || email || "?").trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

export function Header() {
  const { theme, setTheme } = useTheme()
  const { toggle } = useSidebar()
  const { activeChat } = useChats()
  const { user, signOut, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const tituloConversa = activeChat?.title ?? "Nova conversa"

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor

  const handleTheme = (next: Theme) => {
    setTheme(next)
    void updateProfileTheme(next)
      .then(() => refreshProfile())
      .catch(() => {
        /* local já aplicou; DB falhou — settings pode corrigir */
      })
  }

  const handleSignOut = async () => {
    try {
      await signOut()
      toast.success("Sessão encerrada.")
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao sair.")
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 text-card-foreground sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Abrir menu de conversas"
          onClick={toggle}
        >
          <Menu className="size-5" />
        </Button>
        <h1 className="truncate text-sm font-medium text-foreground">
          {tituloConversa}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <ModelSelector />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Alternar tema">
              <ThemeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => handleTheme("light")}>
              <Sun className="size-4" />
              Claro
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleTheme("dark")}>
              <Moon className="size-4" />
              Escuro
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleTheme("system")}>
              <Monitor className="size-4" />
              Sistema
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
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
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
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
            <DropdownMenuItem onSelect={() => navigate("/settings")}>
              <Settings className="size-4" />
              Configurações
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void handleSignOut()}>
              <LogOut className="size-4" />
              Sair
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
