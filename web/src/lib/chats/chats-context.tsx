/**
 * Estado real de conversas do Dexter: lista via `GET /api/chats`,
 * troca de conversa ativa, criação, rename/delete e deep-link `/c/:chatId`.
 *
 * `registerRuntime`: o AssistantRuntime é criado por `useDexterRuntime`
 * dentro de `ChatThread`; este provider guarda a referência e chama
 * `runtime.thread.reset(...)`.
 */
import * as React from "react"
import type { AssistantRuntime, ThreadMessageLike } from "@assistant-ui/react"
import { useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "@/providers/auth-provider"
import {
  deleteChat as deleteChatApi,
  fetchChatMessages,
  fetchChats,
  renameChat as renameChatApi,
} from "./api"
import type { ChatMessageRecord, ChatSummary } from "./types"

interface ChatsContextValue {
  chats: ChatSummary[]
  isLoadingChats: boolean
  chatsError: string | null
  activeChatId: string
  activeChat: ChatSummary | undefined
  isLoadingHistory: boolean
  newChat: () => void
  selectChat: (id: string) => void
  renameChat: (id: string, title: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  refreshChats: () => void
  registerRuntime: (runtime: AssistantRuntime | null) => void
}

const ChatsContext = React.createContext<ChatsContextValue | null>(null)

function paraThreadMessageLike(msg: ChatMessageRecord): ThreadMessageLike {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    createdAt: msg.created_at ? new Date(msg.created_at) : undefined,
  }
}

function chatIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/c\/([^/]+)$/)
  return m?.[1] ?? null
}

export function ChatsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [chats, setChats] = React.useState<ChatSummary[]>([])
  const [isLoadingChats, setIsLoadingChats] = React.useState(true)
  const [chatsError, setChatsError] = React.useState<string | null>(null)
  const [activeChatId, setActiveChatId] = React.useState<string>(() => {
    const fromUrl =
      typeof window !== "undefined" ? chatIdFromPath(window.location.pathname) : null
    return fromUrl ?? crypto.randomUUID()
  })
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(false)

  const runtimeRef = React.useRef<AssistantRuntime | null>(null)
  const pendingHistoryRef = React.useRef<readonly ThreadMessageLike[] | null>(null)
  const skipUrlSyncRef = React.useRef(false)

  const registerRuntime = React.useCallback((runtime: AssistantRuntime | null) => {
    runtimeRef.current = runtime
    if (runtime && pendingHistoryRef.current) {
      runtime.thread.reset(pendingHistoryRef.current)
      pendingHistoryRef.current = null
    }
  }, [])

  const refreshChats = React.useCallback(() => {
    if (!isAuthenticated) {
      setChats([])
      setChatsError(null)
      setIsLoadingChats(false)
      return
    }

    setIsLoadingChats(true)
    setChatsError(null)
    fetchChats()
      .then((lista) => setChats(lista))
      .catch((err) => {
        setChatsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setIsLoadingChats(false))
  }, [isAuthenticated])

  React.useEffect(() => {
    if (isAuthLoading) return
    refreshChats()
  }, [isAuthLoading, refreshChats])

  const loadHistory = React.useCallback((id: string) => {
    setIsLoadingHistory(true)
    pendingHistoryRef.current = null
    runtimeRef.current?.thread.cancelRun()

    fetchChatMessages(id)
      .then((mensagens) => {
        const historico = mensagens.map(paraThreadMessageLike)
        if (runtimeRef.current) {
          runtimeRef.current.thread.reset(historico)
        } else {
          pendingHistoryRef.current = historico
        }
      })
      .catch((err) => {
        console.error(`Falha ao carregar histórico da conversa ${id}:`, err)
      })
      .finally(() => setIsLoadingHistory(false))
  }, [])

  const newChat = React.useCallback(() => {
    const id = crypto.randomUUID()
    pendingHistoryRef.current = null
    setActiveChatId(id)
    runtimeRef.current?.thread.cancelRun()
    runtimeRef.current?.thread.reset([])
    skipUrlSyncRef.current = true
    if (location.pathname !== "/") {
      navigate("/", { replace: false })
    }
  }, [navigate, location.pathname])

  const selectChat = React.useCallback(
    (id: string) => {
      setActiveChatId(id)
      loadHistory(id)
      const target = `/c/${id}`
      if (location.pathname !== target) {
        skipUrlSyncRef.current = true
        navigate(target, { replace: false })
      }
    },
    [loadHistory, navigate, location.pathname],
  )

  // Deep-link: URL → estado (ex.: refresh em /c/:id ou link externo).
  React.useEffect(() => {
    if (skipUrlSyncRef.current) {
      skipUrlSyncRef.current = false
      return
    }
    const fromUrl = chatIdFromPath(location.pathname)
    if (fromUrl) {
      if (fromUrl !== activeChatId) {
        setActiveChatId(fromUrl)
        loadHistory(fromUrl)
      }
      return
    }
    if (location.pathname === "/") {
      // Mantém o activeChatId atual (conversa nova) — não força outro UUID.
    }
  }, [location.pathname, activeChatId, loadHistory])

  // Sync inverso: se activeChatId é conversa conhecida e URL está em /, sobe /c/:id
  // (ex.: após primeira mensagem + refreshChats). Não aplica a conversas novas.
  React.useEffect(() => {
    if (location.pathname !== "/") return
    const known = chats.some((c) => c.id === activeChatId)
    if (known) {
      skipUrlSyncRef.current = true
      navigate(`/c/${activeChatId}`, { replace: true })
    }
  }, [chats, activeChatId, location.pathname, navigate])

  const renameChat = React.useCallback(
    async (id: string, title: string) => {
      const updated = await renameChatApi(id, title)
      setChats((prev) =>
        prev
          .map((c) => (c.id === id ? { ...c, title: updated.title, updated_at: updated.updated_at } : c))
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
      )
    },
    [],
  )

  const deleteChat = React.useCallback(
    async (id: string) => {
      await deleteChatApi(id)
      setChats((prev) => prev.filter((c) => c.id !== id))
      if (activeChatId === id) {
        newChat()
      }
    },
    [activeChatId, newChat],
  )

  const activeChat = chats.find((c) => c.id === activeChatId)

  const value = React.useMemo<ChatsContextValue>(
    () => ({
      chats,
      isLoadingChats,
      chatsError,
      activeChatId,
      activeChat,
      isLoadingHistory,
      newChat,
      selectChat,
      renameChat,
      deleteChat,
      refreshChats,
      registerRuntime,
    }),
    [
      chats,
      isLoadingChats,
      chatsError,
      activeChatId,
      activeChat,
      isLoadingHistory,
      newChat,
      selectChat,
      renameChat,
      deleteChat,
      refreshChats,
      registerRuntime,
    ],
  )

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
}

export function useChats(): ChatsContextValue {
  const ctx = React.useContext(ChatsContext)
  if (!ctx) {
    throw new Error("useChats deve ser usado dentro de <ChatsProvider>")
  }
  return ctx
}
