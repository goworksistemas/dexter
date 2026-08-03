/**
 * Ponte React sobre `chatRunsStore`: registra callback de settle (refresh da
 * lista) e expõe hooks para UI (sidebar, thread).
 */
import * as React from "react"
import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import {
  chatRunsStore,
  type ChatRunSnapshot,
  type StartChatRunParams,
} from "./chat-runs-store"
import type { RunProgress } from "./run-steps"

interface ChatRunsContextValue {
  startRun: (params: StartChatRunParams) => void
  cancelRun: (chatId: string) => void
  discardRun: (chatId: string) => void
  getRun: (chatId: string) => ChatRunSnapshot | undefined
  isRunning: (chatId: string) => boolean
  /** Ids de chats com geração em andamento (para indicador na sidebar). */
  runningChatIds: ReadonlySet<string>
  subscribe: (listener: () => void) => () => void
}

const ChatRunsContext = React.createContext<ChatRunsContextValue | null>(null)

const EMPTY_SET: ReadonlySet<string> = new Set()

function runningIdsKey(ids: string[]): string {
  return ids.slice().sort().join("|")
}

export function ChatRunsProvider({
  children,
  onRunSettled,
}: {
  children: React.ReactNode
  /** Chamado quando uma geração termina (complete/error/cancelled). */
  onRunSettled?: (chatId: string) => void
}) {
  React.useEffect(() => {
    chatRunsStore.setOnRunSettled((chatId) => {
      const run = chatRunsStore.getRun(chatId)
      if (run?.status === "error" && run.error) {
        toast.error(run.error)
      }
      onRunSettled?.(chatId)
    })
    return () => chatRunsStore.setOnRunSettled(null)
  }, [onRunSettled])

  const cacheRef = React.useRef<{ key: string; set: ReadonlySet<string> }>({
    key: "",
    set: EMPTY_SET,
  })

  const runningChatIds = useSyncExternalStore(
    chatRunsStore.subscribe,
    () => {
      const ids = chatRunsStore.getRunningChatIds()
      const key = runningIdsKey(ids)
      if (key === cacheRef.current.key) return cacheRef.current.set
      const set = ids.length === 0 ? EMPTY_SET : new Set(ids)
      cacheRef.current = { key, set }
      return set
    },
    () => EMPTY_SET,
  )

  const value = React.useMemo<ChatRunsContextValue>(
    () => ({
      startRun: (params) => chatRunsStore.startRun(params),
      cancelRun: (chatId) => chatRunsStore.cancelRun(chatId),
      discardRun: (chatId) => chatRunsStore.discardRun(chatId),
      getRun: (chatId) => chatRunsStore.getRun(chatId),
      isRunning: (chatId) => chatRunsStore.isRunning(chatId),
      runningChatIds,
      subscribe: chatRunsStore.subscribe,
    }),
    [runningChatIds],
  )

  return (
    <ChatRunsContext.Provider value={value}>{children}</ChatRunsContext.Provider>
  )
}

export function useChatRuns(): ChatRunsContextValue {
  const ctx = React.useContext(ChatRunsContext)
  if (!ctx) {
    throw new Error("useChatRuns deve ser usado dentro de <ChatRunsProvider>")
  }
  return ctx
}

/** Snapshot reativo de um chat específico (ou undefined). */
export function useChatRun(chatId: string): ChatRunSnapshot | undefined {
  const { subscribe, getRun } = useChatRuns()
  return useSyncExternalStore(
    subscribe,
    () => getRun(chatId),
    () => undefined,
  )
}

/**
 * Progresso do run do chat (timeline de tools + fase atual). A identidade do
 * objeto só muda quando chega progresso de verdade, então o painel não
 * re-renderiza a cada delta de texto.
 */
export function useChatRunProgress(chatId: string): RunProgress | undefined {
  const { subscribe, getRun } = useChatRuns()
  return useSyncExternalStore(
    subscribe,
    () => getRun(chatId)?.progress,
    () => undefined,
  )
}

export function useIsChatRunning(chatId: string): boolean {
  const { subscribe, isRunning } = useChatRuns()
  return useSyncExternalStore(
    subscribe,
    () => isRunning(chatId),
    () => false,
  )
}
