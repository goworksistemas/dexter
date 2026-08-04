import * as React from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { ChatActionsOverlays } from "@/components/chat/chat-actions"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useSidebar } from "@/hooks/use-sidebar"
import { useChatActions, useChatRuns, useChats } from "@/lib/chats"
import { useAuth } from "@/providers/auth-provider"

import { ChatsSection } from "./chats-section"
import { isNewChatShortcut } from "./helpers"
import { SidebarFooter } from "./sidebar-footer"
import { SidebarHeader } from "./sidebar-header"
import { SidebarNav } from "./sidebar-nav"
import { SidebarRail } from "./sidebar-rail"
import { SidebarSearch } from "./sidebar-search"
import { SidebarShell } from "./sidebar-shell"

/** Quantas conversas cabem na lista antes do "Ver todos". */
const RECENT_LIMIT = 15

export function Sidebar() {
  const { open, setOpen, collapsed, setCollapsed } = useSidebar()
  const {
    chats,
    isLoadingChats,
    chatsError,
    activeChatId,
    newChat,
    selectChat,
    refreshChats,
  } = useChats()
  const chatActions = useChatActions()
  const { runningChatIds } = useChatRuns()
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  /**
   * 48rem é exatamente o breakpoint `md` do Tailwind. Este booleano é a única
   * fonte de verdade do layout: nenhuma classe `md:` decide posicionamento ou
   * largura da sidebar, então rail e painel nunca coexistem.
   */
  const isDesktop = useMediaQuery("(min-width: 48rem)")
  const showRail = isDesktop && collapsed

  const [query, setQuery] = React.useState("")
  const [searchOpen, setSearchOpen] = React.useState(false)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  const filteredChats = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chats
    return chats.filter((c) => (c.title || "").toLowerCase().includes(q))
  }, [chats, query])

  const visibleChats = React.useMemo(
    () => filteredChats.slice(0, RECENT_LIMIT),
    [filteredChats],
  )

  // Foco no campo assim que a busca abre (inclusive vindo do rail).
  React.useEffect(() => {
    if (!searchOpen || showRail) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [searchOpen, showRail])

  const closeOnMobile = React.useCallback(() => setOpen(false), [setOpen])

  const handleNewChat = React.useCallback(() => {
    newChat(null)
    setOpen(false)
  }, [newChat, setOpen])

  // Atalho global de nova conversa (Ctrl/⌘ + O).
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNewChatShortcut(event)) return
      event.preventDefault()
      handleNewChat()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [handleNewChat])

  const handleSignOut = React.useCallback(async () => {
    try {
      await signOut()
      toast.success("Sessão encerrada.")
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao sair.")
    }
  }, [navigate, signOut])

  const chatMenuActions = chatActions.chatMenu
    ? chatActions.actionsForChat(
        chatActions.chatMenu.chatId,
        chatActions.chatMenu.title,
        chatActions.chatMenu.projectId,
      )
    : null

  return (
    <>
      <SidebarShell
        isDesktop={isDesktop}
        collapsed={collapsed}
        open={open}
        onOverlayClick={closeOnMobile}
      >
        {showRail ? (
          <SidebarRail
            pathname={pathname}
            hasRunningChats={runningChatIds.size > 0}
            user={user}
            onExpand={() => setCollapsed(false)}
            onNewChat={handleNewChat}
            onSearch={() => {
              setSearchOpen(true)
              setCollapsed(false)
            }}
            onSignOut={() => void handleSignOut()}
          />
        ) : (
          <>
            <SidebarHeader
              searchOpen={searchOpen}
              onCollapse={() => setCollapsed(true)}
              onToggleSearch={() => {
                setSearchOpen((v) => {
                  if (v) setQuery("")
                  return !v
                })
              }}
              onCloseMobile={closeOnMobile}
              onGoHome={handleNewChat}
            />

            {searchOpen ? (
              <SidebarSearch
                inputRef={searchInputRef}
                query={query}
                onQueryChange={setQuery}
                onClose={() => {
                  setQuery("")
                  setSearchOpen(false)
                }}
              />
            ) : null}

            <div className="pt-2 pb-1">
              <SidebarNav
                pathname={pathname}
                onNewChat={handleNewChat}
                onNavigate={closeOnMobile}
              />
            </div>

            <div
              aria-hidden
              className="mx-3 my-1 h-px shrink-0 bg-sidebar-border/70"
            />

            <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pt-1 pb-3">
              <ChatsSection
                chats={visibleChats}
                total={filteredChats.length}
                isLoading={isLoadingChats}
                error={chatsError}
                activeChatId={activeChatId}
                runningChatIds={runningChatIds}
                hasQuery={Boolean(query.trim())}
                rename={{
                  id: chatActions.renamingId,
                  value: chatActions.renameValue,
                  inputRef: chatActions.renameInputRef,
                  onChange: chatActions.setRenameValue,
                  onCommit: (id) => void chatActions.commitRename(id),
                  onCancel: chatActions.cancelRename,
                }}
                onRetry={() => refreshChats()}
                onSelect={(chat) => {
                  selectChat(chat.id)
                  closeOnMobile()
                }}
                onOpenMenu={chatActions.openChatMenu}
                onNavigate={closeOnMobile}
              />
            </div>

            <SidebarFooter
              user={user}
              onNavigate={closeOnMobile}
              onSignOut={() => void handleSignOut()}
            />
          </>
        )}
      </SidebarShell>

      <ChatActionsOverlays
        chatMenu={chatActions.chatMenu}
        onCloseChatMenu={chatActions.closeChatMenu}
        actionsForMenu={chatMenuActions}
        moveDialog={chatActions.moveDialog}
        onMoveDialogOpenChange={(open) =>
          chatActions.setMoveDialog((prev) => ({ ...prev, open }))
        }
      />
    </>
  )
}
