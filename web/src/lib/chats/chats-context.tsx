/**
 * Estado real de conversas do Dexter: lista via `GET /api/chats`,
 * troca de conversa ativa, criação, rename/delete/move e deep-link
 * `/c/:chatId` ou `/p/:projectId/c/:chatId`.
 *
 * Gerações em andamento vivem no `chatRunsStore` — trocar de conversa
 * desanexa a UI mas NÃO aborta o SSE.
 */
import * as React from "react"
import type { AssistantRuntime, ThreadMessageLike } from "@assistant-ui/react"
import { useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "@/providers/auth-provider"
import { useProjects } from "@/lib/projects"
import { stripArtifactAppendix } from "@/lib/artifacts/context-inject"
import {
  deleteChat as deleteChatApi,
  fetchChatMessages,
  fetchChats,
  moveChatToProject as moveChatToProjectApi,
  renameChat as renameChatApi,
} from "./api"
import { chatRunsStore, runSnapshotToThreadMessages } from "./chat-runs-store"
import type { ChatMessageRecord, ChatSummary } from "./types"

interface ChatsContextValue {
  chats: ChatSummary[]
  isLoadingChats: boolean
  chatsError: string | null
  activeChatId: string
  activeChat: ChatSummary | undefined
  isLoadingHistory: boolean
  /** Cria conversa nova; opcionalmente já associada a um projeto. */
  newChat: (projectId?: string | null) => void
  /**
   * Cria conversa nova já com a primeira mensagem — usado por composers fora
   * do chat (ex.: página do projeto). O texto fica pendente até o ChatThread
   * montar na rota da conversa e disparar o run.
   */
  newChatWithMessage: (projectId: string | null, text: string) => void
  /** Consome (uma única vez) a primeira mensagem pendente da conversa. */
  consumePendingFirstMessage: (
    chatId: string,
  ) => { text: string; projectId: string | null } | null
  selectChat: (id: string) => void
  renameChat: (id: string, title: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  moveChatToProject: (id: string, projectId: string | null) => Promise<void>
  refreshChats: () => void
  registerRuntime: (runtime: AssistantRuntime | null) => void
}

const ChatsContext = React.createContext<ChatsContextValue | null>(null)

function paraThreadMessageLike(msg: ChatMessageRecord): ThreadMessageLike {
  const content =
    msg.role === "user" ? stripArtifactAppendix(msg.content) : msg.content
  return {
    id: msg.id,
    role: msg.role,
    content,
    createdAt: msg.created_at ? new Date(msg.created_at) : undefined,
  }
}

function parseChatRoute(pathname: string): {
  chatId: string | null
  projectId: string | null
} {
  const withProject = pathname.match(/^\/p\/([^/]+)\/c\/([^/]+)$/)
  if (withProject) {
    return { projectId: withProject[1]!, chatId: withProject[2]! }
  }
  const projectOnly = pathname.match(/^\/p\/([^/]+)$/)
  if (projectOnly) {
    return { projectId: projectOnly[1]!, chatId: null }
  }
  const chatOnly = pathname.match(/^\/c\/([^/]+)$/)
  if (chatOnly) {
    return { projectId: null, chatId: chatOnly[1]! }
  }
  return { projectId: null, chatId: null }
}

function pathForChat(
  chatId: string,
  projectId: string | null | undefined,
): string {
  if (projectId) return `/p/${projectId}/c/${chatId}`
  return `/c/${chatId}`
}

function applyHistory(
  runtime: AssistantRuntime | null,
  pendingRef: React.MutableRefObject<readonly ThreadMessageLike[] | null>,
  historico: readonly ThreadMessageLike[],
): void {
  if (runtime) {
    runtime.thread.reset(historico)
    pendingRef.current = null
  } else {
    pendingRef.current = historico
  }
}

export function ChatsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const { activeProjectId } = useProjects()
  const navigate = useNavigate()
  const location = useLocation()

  const [chats, setChats] = React.useState<ChatSummary[]>([])
  const [isLoadingChats, setIsLoadingChats] = React.useState(true)
  const [chatsError, setChatsError] = React.useState<string | null>(null)
  const [activeChatId, setActiveChatId] = React.useState<string>(() => {
    const fromUrl =
      typeof window !== "undefined"
        ? parseChatRoute(window.location.pathname).chatId
        : null
    return fromUrl ?? crypto.randomUUID()
  })
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(false)

  const runtimeRef = React.useRef<AssistantRuntime | null>(null)
  const pendingHistoryRef = React.useRef<readonly ThreadMessageLike[] | null>(
    null,
  )
  const skipUrlSyncRef = React.useRef(false)
  /** projectId pendente para conversa nova ainda não persistida. */
  const pendingProjectIdRef = React.useRef<string | null>(null)
  /** Evita aplicar histórico atrasado de um chat que já não é o ativo. */
  const historyRequestRef = React.useRef(0)
  /** Primeira mensagem digitada fora do chat, aguardando o ChatThread montar. */
  const pendingFirstMessageRef = React.useRef<{
    chatId: string
    projectId: string | null
    text: string
  } | null>(null)

  const registerRuntime = React.useCallback(
    (runtime: AssistantRuntime | null) => {
      runtimeRef.current = runtime
      if (runtime && pendingHistoryRef.current) {
        runtime.thread.reset(pendingHistoryRef.current)
        pendingHistoryRef.current = null
      }
    },
    [],
  )

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
    const requestId = ++historyRequestRef.current
    setIsLoadingHistory(true)
    pendingHistoryRef.current = null

    // Desanexa o run local da conversa anterior — NÃO cancela o store.
    runtimeRef.current?.thread.cancelRun()

    const live = chatRunsStore.getRun(id)
    if (live?.status === "running") {
      applyHistory(
        runtimeRef.current,
        pendingHistoryRef,
        runSnapshotToThreadMessages(live),
      )
      setIsLoadingHistory(false)
      return
    }

    fetchChatMessages(id)
      .then((mensagens) => {
        if (requestId !== historyRequestRef.current) return

        // Se uma geração começou/terminou enquanto o fetch rodava, prioriza
        // o snapshot live (evita perder resposta ainda não commitada na API).
        const liveNow = chatRunsStore.getRun(id)
        if (liveNow?.status === "running") {
          applyHistory(
            runtimeRef.current,
            pendingHistoryRef,
            runSnapshotToThreadMessages(liveNow),
          )
          return
        }
        if (liveNow && liveNow.messages.length > mensagens.length) {
          applyHistory(
            runtimeRef.current,
            pendingHistoryRef,
            runSnapshotToThreadMessages(liveNow),
          )
          return
        }

        const historico = mensagens.map(paraThreadMessageLike)
        applyHistory(runtimeRef.current, pendingHistoryRef, historico)
        chatRunsStore.discardRun(id)
      })
      .catch((err) => {
        if (requestId !== historyRequestRef.current) return
        console.error(`Falha ao carregar histórico da conversa ${id}:`, err)
        const liveNow = chatRunsStore.getRun(id)
        if (liveNow) {
          applyHistory(
            runtimeRef.current,
            pendingHistoryRef,
            runSnapshotToThreadMessages(liveNow),
          )
        }
      })
      .finally(() => {
        if (requestId === historyRequestRef.current) {
          setIsLoadingHistory(false)
        }
      })
  }, [])

  /** Abre uma conversa nova e devolve o id/projeto resolvidos. */
  const abrirConversaNova = React.useCallback(
    (projectId?: string | null) => {
      const id = crypto.randomUUID()
      const pid = projectId === undefined ? activeProjectId : projectId
      pendingProjectIdRef.current = pid
      pendingHistoryRef.current = null
      setActiveChatId(id)
      // Só desanexa a UI; gerações de outros chats seguem em background.
      runtimeRef.current?.thread.cancelRun()
      runtimeRef.current?.thread.reset([])
      skipUrlSyncRef.current = true
      const target = pid ? `/p/${pid}` : "/"
      if (location.pathname !== target) {
        navigate(target, { replace: false })
      }
      return { id, projectId: pid }
    },
    [navigate, location.pathname, activeProjectId],
  )

  const newChat = React.useCallback(
    (projectId?: string | null) => {
      abrirConversaNova(projectId)
    },
    [abrirConversaNova],
  )

  const newChatWithMessage = React.useCallback(
    (projectId: string | null, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const nova = abrirConversaNova(projectId)
      pendingFirstMessageRef.current = {
        chatId: nova.id,
        projectId: nova.projectId,
        text: trimmed,
      }
    },
    [abrirConversaNova],
  )

  /**
   * Entrega o texto pendente uma única vez — o ref é limpo aqui, então o
   * duplo efeito do StrictMode (ou um re-render) não reenvia a mensagem.
   */
  const consumePendingFirstMessage = React.useCallback((chatId: string) => {
    const pendente = pendingFirstMessageRef.current
    if (!pendente || pendente.chatId !== chatId) return null
    pendingFirstMessageRef.current = null
    return { text: pendente.text, projectId: pendente.projectId }
  }, [])

  const selectChat = React.useCallback(
    (id: string) => {
      const chat = chats.find((c) => c.id === id)
      const projectId = chat?.project_id ?? null
      pendingProjectIdRef.current = projectId
      setActiveChatId(id)
      loadHistory(id)
      const target = pathForChat(id, projectId)
      if (location.pathname !== target) {
        skipUrlSyncRef.current = true
        navigate(target, { replace: false })
      }
    },
    [chats, loadHistory, navigate, location.pathname],
  )

  // Deep-link: URL → estado
  React.useEffect(() => {
    if (skipUrlSyncRef.current) {
      skipUrlSyncRef.current = false
      return
    }
    const { chatId: fromUrl, projectId } = parseChatRoute(location.pathname)
    if (fromUrl) {
      pendingProjectIdRef.current = projectId
      if (fromUrl !== activeChatId) {
        setActiveChatId(fromUrl)
        loadHistory(fromUrl)
      }
      return
    }
    if (location.pathname === "/" || /^\/p\/[^/]+$/.test(location.pathname)) {
      if (/^\/p\/[^/]+$/.test(location.pathname) && projectId) {
        pendingProjectIdRef.current = projectId
      } else if (location.pathname === "/") {
        pendingProjectIdRef.current = null
      }
    }
  }, [location.pathname, activeChatId, loadHistory])

  // Sync inverso: conversa conhecida em / ou /p/:id → sobe path com /c/:id
  React.useEffect(() => {
    const isHome =
      location.pathname === "/" || /^\/p\/[^/]+$/.test(location.pathname)
    if (!isHome) return
    const known = chats.find((c) => c.id === activeChatId)
    if (known) {
      skipUrlSyncRef.current = true
      navigate(pathForChat(activeChatId, known.project_id), { replace: true })
      pendingProjectIdRef.current = known.project_id
    }
  }, [chats, activeChatId, location.pathname, navigate])

  const renameChat = React.useCallback(async (id: string, title: string) => {
    const updated = await renameChatApi(id, title)
    setChats((prev) =>
      prev
        .map((c) =>
          c.id === id
            ? {
                ...c,
                title: updated.title,
                project_id: updated.project_id,
                updated_at: updated.updated_at,
              }
            : c,
        )
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
    )
  }, [])

  const deleteChat = React.useCallback(
    async (id: string) => {
      chatRunsStore.cancelRun(id)
      chatRunsStore.discardRun(id)
      await deleteChatApi(id)
      setChats((prev) => prev.filter((c) => c.id !== id))
      if (activeChatId === id) {
        newChat(activeProjectId)
      }
    },
    [activeChatId, newChat, activeProjectId],
  )

  const moveChatToProject = React.useCallback(
    async (id: string, projectId: string | null) => {
      const updated = await moveChatToProjectApi(id, projectId)
      setChats((prev) =>
        prev
          .map((c) => (c.id === id ? { ...c, ...updated } : c))
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
      )
      if (activeChatId === id) {
        pendingProjectIdRef.current = projectId
        skipUrlSyncRef.current = true
        navigate(pathForChat(id, projectId), { replace: true })
      }
    },
    [activeChatId, navigate],
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
      newChatWithMessage,
      consumePendingFirstMessage,
      selectChat,
      renameChat,
      deleteChat,
      moveChatToProject,
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
      newChatWithMessage,
      consumePendingFirstMessage,
      selectChat,
      renameChat,
      deleteChat,
      moveChatToProject,
      refreshChats,
      registerRuntime,
    ],
  )

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
}

/** projectId a enviar no context do chat (conversa nova ou ativa). */
export function useActiveChatProjectId(): string | null {
  const { activeChat, activeChatId } = useChats()
  const { activeProjectId } = useProjects()
  if (activeChat?.project_id) return activeChat.project_id
  if (!activeChat) {
    return activeProjectId
  }
  void activeChatId
  return null
}

export function useChats(): ChatsContextValue {
  const ctx = React.useContext(ChatsContext)
  if (!ctx) {
    throw new Error("useChats deve ser usado dentro de <ChatsProvider>")
  }
  return ctx
}
