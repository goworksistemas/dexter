import { Menu, Monitor, Moon, Sun } from "lucide-react"
import { Link, useLocation } from "react-router-dom"

import { ConnectionsDialog } from "@/components/chat/connections-dialog"
import { ModelSelector } from "@/components/chat/model-selector"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/hooks/use-sidebar"
import { useChats } from "@/lib/chats"
import { useProjects } from "@/lib/projects"
import { updateProfileTheme } from "@/lib/supabase"
import { useAuth } from "@/providers/auth-provider"
import { useTheme, type Theme } from "@/providers/theme-provider"

const PAGE_TITLES: Record<string, string> = {
  "/chats": "Conversas",
  "/projects": "Projetos",
  "/artifacts": "Artefatos",
  "/settings": "Configurações",
}

/**
 * Header da área principal: contexto da rota atual + ferramentas do chat.
 * Conta e configurações vivem na sidebar; o controle de colapso também —
 * aqui fica apenas o abridor do drawer no mobile.
 */
export function Header() {
  const { theme, setTheme } = useTheme()
  const { toggle } = useSidebar()
  const { activeChat } = useChats()
  const { projects, activeProject } = useProjects()
  const { refreshProfile } = useAuth()
  const { pathname } = useLocation()

  const projectDetailId = pathname.match(/^\/projects\/([^/]+)/)?.[1]
  const detailProject = projectDetailId
    ? projects.find((p) => p.id === projectDetailId)
    : undefined
  const pageTitle = PAGE_TITLES[pathname]
  const isChatRoute = !pageTitle && !projectDetailId

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor

  const handleTheme = (next: Theme) => {
    setTheme(next)
    void updateProfileTheme(next)
      .then(() => refreshProfile())
      .catch(() => {
        /* local já aplicou */
      })
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-1 shrink-0 md:hidden"
          aria-label="Abrir menu de conversas"
          onClick={toggle}
        >
          <Menu className="size-5" />
        </Button>

        {projectDetailId ? (
          <nav
            aria-label="Trilha de navegação"
            className="flex min-w-0 items-center gap-1.5 text-sm"
          >
            <Link
              to="/projects"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              Projetos
            </Link>
            <span aria-hidden className="text-muted-foreground/50">
              /
            </span>
            <span className="min-w-0 truncate font-medium text-foreground/90">
              {detailProject?.name ?? "Projeto"}
            </span>
          </nav>
        ) : pageTitle ? (
          <h1 className="truncate text-sm font-medium text-foreground/90">
            {pageTitle}
          </h1>
        ) : (
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-sm font-medium text-foreground/90">
              {activeChat?.title ?? "Nova conversa"}
            </h1>
            {activeProject ? (
              <p className="truncate text-[11px] text-muted-foreground">
                {activeProject.name}
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isChatRoute ? (
          <>
            <ConnectionsDialog />
            <ModelSelector />
          </>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Alternar tema">
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
      </div>
    </header>
  )
}
