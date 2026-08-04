import * as React from "react"
import { Menu, Monitor, Moon, Sun } from "lucide-react"
import { Link, useLocation } from "react-router-dom"

import { ChatHeaderTitle, ChatActionsOverlays } from "@/components/chat/chat-actions"
import { ShareLinkButton } from "@/components/share/share-link-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/hooks/use-sidebar"
import { useChatActions, useChats } from "@/lib/chats"
import { useProjects } from "@/lib/projects"
import { updateProfileTheme } from "@/lib/supabase"
import { useAuth } from "@/providers/auth-provider"
import { useTheme, type Theme } from "@/providers/theme-provider"

/**
 * Rotas que já renderizam o próprio H1 no corpo da página — o header não
 * repete o título (evitava dois <h1> concorrentes por rota).
 */
const OWN_HEADING_ROUTES = new Set([
  "/chats",
  "/projects",
  "/artifacts",
  "/settings",
])

/**
 * Header da área principal: contexto da rota atual + ferramentas do chat.
 * Conta e configurações vivem na sidebar; o controle de colapso também —
 * aqui fica apenas o abridor do drawer no mobile.
 */
export function Header() {
  const { theme, setTheme } = useTheme()
  const { open: drawerOpen, toggle } = useSidebar()
  const { activeChat } = useChats()
  const chatActions = useChatActions()
  const { projects, activeProject } = useProjects()
  const { refreshProfile } = useAuth()
  const { pathname } = useLocation()

  const projectDetailId = pathname.match(/^\/projects\/([^/]+)/)?.[1]
  const detailProject = projectDetailId
    ? projects.find((p) => p.id === projectDetailId)
    : undefined
  const hasOwnHeading = OWN_HEADING_ROUTES.has(pathname)

  const menuButtonRef = React.useRef<HTMLButtonElement>(null)
  const drawerWasOpenRef = React.useRef(false)

  // Drawer fechou: o foco volta pro botão que o abriu (não fica no vazio).
  React.useEffect(() => {
    if (drawerOpen) {
      drawerWasOpenRef.current = true
      return
    }
    if (!drawerWasOpenRef.current) return
    drawerWasOpenRef.current = false
    menuButtonRef.current?.focus()
  }, [drawerOpen])

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor
  const themeLabel =
    theme === "dark" ? "escuro" : theme === "light" ? "claro" : "sistema"

  const handleTheme = (next: Theme) => {
    setTheme(next)
    void updateProfileTheme(next)
      .then(() => refreshProfile())
      .catch(() => {
        /* local já aplicou */
      })
  }

  const chatTitle = activeChat?.title ?? "Nova conversa"
  const chatMenuActions = chatActions.chatMenu
    ? chatActions.actionsForChat(
        chatActions.chatMenu.chatId,
        chatActions.chatMenu.title,
        chatActions.chatMenu.projectId,
      )
    : null

  const onChatRoute =
    pathname === "/" ||
    pathname.startsWith("/c/") ||
    /^\/p\/[^/]+(\/c\/[^/]+)?$/.test(pathname)

  return (
    <>
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          ref={menuButtonRef}
          variant="ghost"
          size="icon-sm"
          className="-ml-1 shrink-0 md:hidden"
          aria-label="Abrir menu de conversas"
          aria-expanded={drawerOpen}
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
        ) : hasOwnHeading ? null : activeChat ? (
          <ChatHeaderTitle
            title={chatTitle}
            subtitle={activeProject?.name}
            isRenaming={chatActions.renamingId === activeChat.id}
            renameValue={chatActions.renameValue}
            renameInputRef={chatActions.renameInputRef}
            onRenameChange={chatActions.setRenameValue}
            onRenameCommit={() => void chatActions.commitRename(activeChat.id)}
            onRenameCancel={chatActions.cancelRename}
            actions={chatActions.actionsForChat(
              activeChat.id,
              chatTitle,
              activeChat.project_id,
            )}
          />
        ) : (
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-sm font-medium text-foreground/90">
              {chatTitle}
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
        {activeChat && onChatRoute ? (
          <ShareLinkButton
            resource="chat"
            resourceId={activeChat.id}
            label="Compartilhar"
            size="sm"
            variant="ghost"
            className="hidden h-8 gap-1.5 sm:inline-flex"
          />
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Tema: ${themeLabel}`}
            >
              <ThemeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => handleTheme(value as Theme)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="size-4" />
                Claro
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="size-4" />
                Escuro
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="size-4" />
                Sistema
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

    <ChatActionsOverlays
      chatMenu={chatActions.chatMenu}
      onCloseChatMenu={chatActions.closeChatMenu}
      actionsForMenu={chatMenuActions}
      moveDialog={chatActions.moveDialog}
      onMoveDialogOpenChange={(open) =>
        chatActions.setMoveDialog((prev) => ({ ...prev, open }))
      }
      shareDialog={chatActions.shareDialog}
      onShareDialogOpenChange={(open) =>
        chatActions.setShareDialog((prev) => ({ ...prev, open }))
      }
    />
    </>
  )
}
