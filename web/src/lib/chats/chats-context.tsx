/**
 * Estado real de conversas do Dexter: lista via `GET /api/chats`,
 * troca de conversa ativa, criação, rename/delete/move e deep-link
 * `/c/:chatId` ou `/p/:projectId/c/:chatId`.
 *
 * Gerações em andamento vivem no `chatRunsStore` — trocar de conversa
 * desanexa a UI mas NÃO aborta o SSE.
 */
import * as React from "react"
import type {
  AssistantRuntime,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react"
import { useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "@/providers/auth-provider"
import { useProjects } from "@/lib/projects"
import { stripArtifactAppendix } from "@/lib/artifacts/context-inject"
import {
  deleteChat as deleteChatApi,
  fetchChatMessages,
  fetchChatMessagesWithRetry,
  fetchChats,
  fetchChatTail,
  moveChatToProject as moveChatToProjectApi,
  renameChat as renameChatApi,
  setChatModel as setChatModelApi,
} from "./api"
import { chatRunsStore, runSnapshotToThreadMessages } from "./chat-runs-store"
import {
  clearCachedHistory,
  getCachedHistory,
  mergeHistoryPage,
  setCachedHistory,
} from "./history-cache"
import type { ChatMessageRecord, ChatSummary } from "./types"

/** Janela inicial ao abrir conversa — o resto sobe sob demanda. */
const HISTORY_PAGE_SIZE = 40
/** Cauda pedida após um run — cobre user+assistant do último turno com folga. */
const HISTORY_TAIL_SIZE = 8

interface ChatsContextValue {
  chats: ChatSummary[]
  isLoadingChats: boolean
  chatsError: string | null
  activeChatId: string
  activeChat: ChatSummary | undefined
  isLoadingHistory: boolean
  /** URL /c/:id ou conversa conhecida — nunca mostrar empty-state de "nova". */
  expectsThread: boolean
  /** Falha ao carregar histórico (após retries). */
  historyError: string | null
  /** Recarrega o histórico da conversa ativa. */
  reloadHistory: () => void
  /**
   * Ressincroniza só a cauda depois que um run assenta — troca os ids locais
   * (nanoid do composer / uuid do store) pelos ids do banco, sem os quais
   * "Editar" e "Tentar novamente" batem 400/404 no truncate. Preserva as
   * mensagens antigas já paginadas; recarrega tudo só se a cauda não casar.
   * `onRemapearIds` recebe os pares (id local → id do banco) trocados — quem
   * indexa dados por id de mensagem (miniaturas de anexo) re-chaveia com eles.
   */
  syncHistoryAfterRun: (
    chatId: string,
    onRemapearIds?: (pares: ReadonlyArray<readonly [string, string]>) => void,
  ) => void
  /** Ainda há mensagens mais antigas no servidor. */
  hasMoreHistory: boolean
  isLoadingOlderHistory: boolean
  /** Carrega página anterior (rolar pra cima). `false` = não carregou nada. */
  loadOlderHistory: () => Promise<boolean>
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
  /** Pina o modelo de UMA conversa existente — não vaza para as outras. */
  setChatModel: (id: string, model: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  moveChatToProject: (id: string, projectId: string | null) => Promise<void>
  refreshChats: () => void
  registerRuntime: (runtime: AssistantRuntime | null) => void
}

const ChatsContext = React.createContext<ChatsContextValue | null>(null)

function paraThreadMessageLike(msg: ChatMessageRecord): ThreadMessageLike {
  const content =
    msg.role === "user" ? stripArtifactAppendix(msg.content) : msg.content
  const custom: Record<string, unknown> = {}
  if (msg.cost_usd != null) custom.cost_usd = msg.cost_usd
  if (msg.tokens_in != null) custom.tokens_in = msg.tokens_in
  if (msg.tokens_out != null) custom.tokens_out = msg.tokens_out
  if (msg.model) custom.model = msg.model
  return {
    id: msg.id,
    role: msg.role,
    content,
    createdAt: msg.created_at ? new Date(msg.created_at) : undefined,
    ...(Object.keys(custom).length > 0
      ? { metadata: { custom } }
      : {}),
  }
}

/** Mensagem já na thread → ThreadMessageLike (partes achatadas em texto). */
function paraMensagemLocal(msg: ThreadMessage): ThreadMessageLike {
  const custom = msg.metadata?.custom
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
    createdAt: msg.createdAt,
    ...(custom && Object.keys(custom).length > 0
      ? { metadata: { custom } }
      : {}),
  }
}

interface ReconciliacaoCauda {
  messages: readonly ThreadMessageLike[]
  hasMore: boolean
  /** Pares (id local → id do banco) das mensagens que trocaram de id. */
  remaps: Array<readonly [string, string]>
}

/** Pares de troca de id entre dois trechos já alinhados posicionalmente. */
function paresDeRemap(
  locais: readonly ThreadMessageLike[],
  cauda: readonly ThreadMessageLike[],
  inicioLocais: number,
  inicioCauda: number,
  tamanho: number,
): Array<readonly [string, string]> {
  const pares: Array<readonly [string, string]> = []
  for (let i = 0; i < tamanho; i++) {
    const antigo = locais[inicioLocais + i]!.id
    const novo = cauda[inicioCauda + i]!.id
    if (antigo && novo && antigo !== novo) pares.push([antigo, novo])
  }
  return pares
}

/**
 * Casa a cauda do banco com o que já está na thread: troca as últimas
 * mensagens locais (ids de composer/store) pelas do banco e preserva o que o
 * usuário já paginou pra cima, junto com o `hasMoreHistory` conhecido.
 * `null` = não deu para casar com segurança → quem chama recarrega tudo.
 */
function reconciliarCauda(
  locais: readonly ThreadMessageLike[],
  cauda: readonly ThreadMessageLike[],
  caudaHasMore: boolean,
  hasMoreAtual: boolean,
): ReconciliacaoCauda | null {
  // Cauda vazia com histórico local é sinal de dessincronia — reload decide.
  if (cauda.length === 0) return null
  // A cauda é a conversa inteira (chat novo/curto). Substituir só é seguro se
  // a thread não tiver nada que o banco não tenha: bolha de erro que o
  // servidor não persistiu (e o "Tentar novamente" com ela) ou thread de outra
  // conversa ainda na tela morreriam em silêncio.
  if (!caudaHasMore) {
    if (locais.length > cauda.length) return null
    const deslocamento = cauda.length - locais.length
    for (let i = 0; i < locais.length; i++) {
      if (locais[i]!.role !== cauda[deslocamento + i]!.role) return null
    }
    return {
      messages: cauda,
      hasMore: false,
      remaps: paresDeRemap(locais, cauda, 0, deslocamento, locais.length),
    }
  }
  // Menos mensagens locais que a cauda (e há histórico antes) — a thread está
  // incompleta: recarregar a janela inteira é melhor que encolher para N.
  if (locais.length < cauda.length) return null

  const inicio = locais.length - cauda.length
  const posPorId = new Map<string, number>()
  cauda.forEach((m, i) => {
    if (m.id) posPorId.set(m.id, i)
  })
  for (let i = 0; i < cauda.length; i++) {
    const local = locais[inicio + i]!
    if (local.role !== cauda[i]!.role) return null
    // Id do banco que aparece em outra posição = janelas desalinhadas.
    const pos = local.id ? posPorId.get(local.id) : undefined
    if (pos !== undefined && pos !== i) return null
  }

  const antigas = locais
    .slice(0, inicio)
    .filter((m) => !m.id || !posPorId.has(m.id))
  return {
    messages: [...antigas, ...cauda],
    // Prefixo preservado → quem sabe do começo da conversa é o estado atual.
    hasMore: antigas.length > 0 ? hasMoreAtual : caudaHasMore,
    remaps: paresDeRemap(locais, cauda, inicio, 0, cauda.length),
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
  const [historyError, setHistoryError] = React.useState<string | null>(null)
  const [hasMoreHistory, setHasMoreHistory] = React.useState(false)
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] =
    React.useState(false)

  const runtimeRef = React.useRef<AssistantRuntime | null>(null)
  const pendingHistoryRef = React.useRef<readonly ThreadMessageLike[] | null>(
    null,
  )
  /** Conversa ativa lida de forma síncrona por `registerRuntime`. */
  const activeChatIdRef = React.useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  const skipUrlSyncRef = React.useRef(false)
  /** projectId pendente para conversa nova ainda não persistida. */
  const pendingProjectIdRef = React.useRef<string | null>(null)
  /** Evita aplicar histórico atrasado de um chat que já não é o ativo. */
  const historyRequestRef = React.useRef(0)
  const historyAbortRef = React.useRef<AbortController | null>(null)
  const olderAbortRef = React.useRef<AbortController | null>(null)
  const hasMoreHistoryRef = React.useRef(false)
  const loadingOlderRef = React.useRef(false)
  /** chatIds cujo GET messages já concluiu com sucesso nesta sessão. */
  const historyReadyRef = React.useRef(new Set<string>())
  /** Evita loop de auto-retry quando o backend continua fora. */
  const historyAutoRetryRef = React.useRef<string | null>(null)
  /** Garante load no mount quando a URL já traz /c/:id (refresh/deep-link). */
  const mountHistoryLoadedRef = React.useRef(false)
  /** Primeira mensagem digitada fora do chat, aguardando o ChatThread montar. */
  const pendingFirstMessageRef = React.useRef<{
    chatId: string
    projectId: string | null
    text: string
  } | null>(null)

  const registerRuntime = React.useCallback(
    (runtime: AssistantRuntime | null) => {
      runtimeRef.current = runtime
      if (!runtime) return
      if (pendingHistoryRef.current) {
        runtime.thread.reset(pendingHistoryRef.current)
        pendingHistoryRef.current = null
        return
      }
      // ChatThread remontou sem trocar de conversa (voltar de /settings, /admin
      // etc.: o shell desmonta a thread nessas rotas). O runtime novo nasce
      // vazio e nenhum efeito chamaria loadHistory de novo — sem repor daqui a
      // conversa fica em branco até o usuário clicá-la na sidebar.
      if (runtime.thread.getState().messages.length > 0) return
      const id = activeChatIdRef.current
      const live = chatRunsStore.getRun(id)
      if (live) {
        runtime.thread.reset(runSnapshotToThreadMessages(live))
        return
      }
      const cached = getCachedHistory(id)
      if (cached && cached.messages.length > 0) {
        runtime.thread.reset(cached.messages)
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
    historyAbortRef.current?.abort()
    olderAbortRef.current?.abort()
    const abort = new AbortController()
    historyAbortRef.current = abort

    const requestId = ++historyRequestRef.current
    setIsLoadingHistory(true)
    setHistoryError(null)
    setIsLoadingOlderHistory(false)
    loadingOlderRef.current = false
    pendingHistoryRef.current = null

    // Desanexa o run local da conversa anterior — NÃO cancela o store.
    // Mantém as bolhas atuais até o histórico novo chegar (troca atômica).
    runtimeRef.current?.thread.cancelRun()

    const live = chatRunsStore.getRun(id)
    if (live?.status === "running") {
      applyHistory(
        runtimeRef.current,
        pendingHistoryRef,
        runSnapshotToThreadMessages(live),
      )
      // O snapshot não sabe o tamanho real do histórico — preserva o hasMore
      // já conhecido, senão a paginação morre até o F5.
      const hasMoreConhecido = getCachedHistory(id)?.hasMore ?? false
      hasMoreHistoryRef.current = hasMoreConhecido
      setHasMoreHistory(hasMoreConhecido)
      historyReadyRef.current.add(id)
      setIsLoadingHistory(false)
      return
    }

    // Paint imediato se já abrimos este chat nesta sessão.
    const cached = getCachedHistory(id)
    if (cached) {
      applyHistory(runtimeRef.current, pendingHistoryRef, cached.messages)
      hasMoreHistoryRef.current = cached.hasMore
      setHasMoreHistory(cached.hasMore)
      // Continua revalidando em background — não liberar "home" cedo demais.
    } else {
      hasMoreHistoryRef.current = false
      setHasMoreHistory(false)
    }

    void fetchChatMessagesWithRetry(id, {
      signal: abort.signal,
      limit: HISTORY_PAGE_SIZE,
    })
      .then((page) => {
        if (requestId !== historyRequestRef.current) return

        const liveNow = chatRunsStore.getRun(id)
        if (liveNow?.status === "running") {
          applyHistory(
            runtimeRef.current,
            pendingHistoryRef,
            runSnapshotToThreadMessages(liveNow),
          )
          // Snapshot no lugar da página: mantém o hasMore da página, que é
          // quem sabe se ainda tem começo de conversa no servidor.
          hasMoreHistoryRef.current = page.hasMore
          setHasMoreHistory(page.hasMore)
          historyReadyRef.current.add(id)
          setHistoryError(null)
          return
        }
        if (liveNow && liveNow.messages.length > page.messages.length) {
          const snap = runSnapshotToThreadMessages(liveNow)
          applyHistory(runtimeRef.current, pendingHistoryRef, snap)
          setCachedHistory(id, snap, page.hasMore)
          hasMoreHistoryRef.current = page.hasMore
          setHasMoreHistory(page.hasMore)
          historyReadyRef.current.add(id)
          setHistoryError(null)
          return
        }

        const historico = page.messages.map(paraThreadMessageLike)
        const merged = mergeHistoryPage(
          getCachedHistory(id),
          historico,
          page.hasMore,
        )
        setCachedHistory(id, merged.messages, merged.hasMore)
        applyHistory(runtimeRef.current, pendingHistoryRef, merged.messages)
        hasMoreHistoryRef.current = merged.hasMore
        setHasMoreHistory(merged.hasMore)
        historyReadyRef.current.add(id)
        setHistoryError(null)
        if (liveNow) {
          chatRunsStore.discardRun(id)
        }
      })
      .catch((err) => {
        if (requestId !== historyRequestRef.current) return
        if (err instanceof DOMException && err.name === "AbortError") return
        if (err instanceof Error && /aborted|AbortError/i.test(err.message)) return
        console.error(`Falha ao carregar histórico da conversa ${id}:`, err)
        const liveNow = chatRunsStore.getRun(id)
        if (liveNow) {
          applyHistory(
            runtimeRef.current,
            pendingHistoryRef,
            runSnapshotToThreadMessages(liveNow),
          )
          historyReadyRef.current.add(id)
          setHistoryError(null)
          return
        }
        if (getCachedHistory(id)) {
          // Cache já na tela — avisa sem cair em "nova conversa".
          setHistoryError(null)
          return
        }
        setHistoryError(
          err instanceof Error
            ? err.message
            : "Não foi possível carregar esta conversa.",
        )
      })
      .finally(() => {
        if (requestId === historyRequestRef.current) {
          setIsLoadingHistory(false)
        }
      })
  }, [])

  /**
   * `true` só quando a página anterior realmente entrou na thread — quem chama
   * usa isso para saber se deve restaurar a posição do scroll.
   */
  const loadOlderHistory = React.useCallback(async (): Promise<boolean> => {
    const id = activeChatId
    if (!id || !hasMoreHistoryRef.current || loadingOlderRef.current) {
      return false
    }

    const runtime = runtimeRef.current
    if (!runtime) return false
    const current = runtime.thread.getState().messages
    const oldest = current[0]
    if (!oldest?.id) return false

    olderAbortRef.current?.abort()
    const abort = new AbortController()
    olderAbortRef.current = abort
    loadingOlderRef.current = true
    setIsLoadingOlderHistory(true)

    try {
      const page = await fetchChatMessages(id, {
        signal: abort.signal,
        limit: HISTORY_PAGE_SIZE,
        before: oldest.id,
      })
      if (abort.signal.aborted) return false
      if (historyAbortRef.current?.signal.aborted) return false

      const older = page.messages.map(paraThreadMessageLike)
      const existing = new Set(current.map((m) => m.id))
      const unique = older.filter((m) => m.id && !existing.has(m.id))
      const kept = current.map(paraMensagemLocal)
      const merged = [...unique, ...kept]
      applyHistory(runtime, pendingHistoryRef, merged)
      hasMoreHistoryRef.current = page.hasMore
      setHasMoreHistory(page.hasMore)
      setCachedHistory(id, merged, page.hasMore)
      return true
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return false
      if (err instanceof Error && /aborted|AbortError/i.test(err.message)) {
        return false
      }
      console.error(`Falha ao carregar mensagens antigas de ${id}:`, err)
      return false
    } finally {
      if (olderAbortRef.current === abort) {
        loadingOlderRef.current = false
        setIsLoadingOlderHistory(false)
      }
    }
  }, [activeChatId])

  /** Abre uma conversa nova e devolve o id/projeto resolvidos. */
  const abrirConversaNova = React.useCallback(
    (projectId?: string | null) => {
      const id = crypto.randomUUID()
      const pid = projectId === undefined ? activeProjectId : projectId
      // Histórico em voo do chat anterior não pode cair aqui dentro: abortar
      // não basta (o GET pode já ter resolvido), o bump do requestId é o que
      // invalida o `.then` atrasado.
      historyAbortRef.current?.abort()
      olderAbortRef.current?.abort()
      historyRequestRef.current++
      setIsLoadingHistory(false)
      setHistoryError(null)
      loadingOlderRef.current = false
      pendingProjectIdRef.current = pid
      pendingHistoryRef.current = null
      setActiveChatId(id)
      hasMoreHistoryRef.current = false
      setHasMoreHistory(false)
      setIsLoadingOlderHistory(false)
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

  // Refresh/deep-link: URL já tem chatId no 1º paint — precisa carregar 1x.
  React.useEffect(() => {
    if (mountHistoryLoadedRef.current) return
    const { chatId: fromUrl } = parseChatRoute(location.pathname)
    if (!fromUrl) {
      mountHistoryLoadedRef.current = true
      return
    }
    mountHistoryLoadedRef.current = true
    loadHistory(fromUrl)
  }, [location.pathname, loadHistory])

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

  // Boot race: lista de chats chegou e o 1º GET messages falhou (server ainda
  // subindo) → tenta de novo uma vez sem o usuário precisar clicar.
  React.useEffect(() => {
    if (!chats.some((c) => c.id === activeChatId)) return
    if (historyReadyRef.current.has(activeChatId)) return
    if (isLoadingHistory) return
    if (historyAutoRetryRef.current === activeChatId) return
    historyAutoRetryRef.current = activeChatId
    loadHistory(activeChatId)
  }, [chats, activeChatId, isLoadingHistory, loadHistory])

  const reloadHistory = React.useCallback(() => {
    historyAutoRetryRef.current = null
    historyReadyRef.current.delete(activeChatId)
    loadHistory(activeChatId)
  }, [activeChatId, loadHistory])

  /**
   * Run assentou: em vez do histórico inteiro, busca só a cauda (últimas
   * mensagens + `hasMore`) e troca as bolhas locais pelas do banco — sem os
   * ids reais "Editar" e "Tentar novamente" batem 400/404 no truncate.
   * Mensagens antigas já paginadas e o `hasMoreHistory` ficam de pé; se a
   * cauda não casar com a thread, cai no reload completo de antes.
   */
  const syncHistoryAfterRun = React.useCallback(
    (
      id: string,
      onRemapearIds?: (
        pares: ReadonlyArray<readonly [string, string]>,
      ) => void,
    ) => {
      if (!id) return

      const recarregarTudo = () => {
        historyAutoRetryRef.current = null
        historyReadyRef.current.delete(id)
        loadHistory(id)
      }

      const runtime = runtimeRef.current
      const locais = runtime
        ? runtime.thread.getState().messages.map(paraMensagemLocal)
        : getCachedHistory(id)?.messages
      // Nada na tela nem no cache para casar — histórico completo resolve.
      if (!locais || locais.length === 0) {
        recarregarTudo()
        return
      }

      historyAbortRef.current?.abort()
      olderAbortRef.current?.abort()
      const abort = new AbortController()
      historyAbortRef.current = abort
      // Invalida histórico em voo (e é invalidado por troca de conversa). O
      // `.finally` do load invalidado não roda, então zera os loadings aqui.
      const requestId = ++historyRequestRef.current
      setIsLoadingHistory(false)
      loadingOlderRef.current = false
      setIsLoadingOlderHistory(false)

      void fetchChatTail(id, { signal: abort.signal, limit: HISTORY_TAIL_SIZE })
        .then((tail) => {
          if (requestId !== historyRequestRef.current) return
          // Run novo já streamando: não pisar nas bolhas ao vivo.
          const live = chatRunsStore.getRun(id)
          if (live?.status === "running") return

          // Nenhum id do run na thread = ela ainda mostra OUTRA conversa
          // (troca de chat com loadHistory em voo, que este sync abortou).
          // Reconciliar aí gravaria o conteúdo errado no cache desta conversa.
          if (live) {
            const idsDoRun = new Set(live.messages.map((m) => m.id))
            if (!locais.some((m) => m.id && idsDoRun.has(m.id))) {
              recarregarTudo()
              return
            }
          }

          // Erro/cancelamento antes do 1º token não gera linha de assistente
          // no banco (o servidor só grava com texto): trocar a thread pela
          // cauda apagaria a bolha de erro — e o "Tentar novamente" com ela,
          // que depende de haver uma mensagem de assistente na tela. Mantém o
          // snapshot ao vivo (e o run, que é a fonte dele).
          const ultimaCauda = tail.messages[tail.messages.length - 1]
          if (live && ultimaCauda?.role !== "assistant") {
            applyHistory(
              runtimeRef.current,
              pendingHistoryRef,
              runSnapshotToThreadMessages(live),
            )
            historyReadyRef.current.add(id)
            setHistoryError(null)
            return
          }

          const merged = reconciliarCauda(
            locais,
            tail.messages.map(paraThreadMessageLike),
            tail.hasMore,
            hasMoreHistoryRef.current,
          )
          if (!merged) {
            recarregarTudo()
            return
          }

          setCachedHistory(id, merged.messages, merged.hasMore)
          applyHistory(runtimeRef.current, pendingHistoryRef, merged.messages)
          // Miniaturas de anexo (e afins) são indexadas pelo id da mensagem —
          // sem re-chavear, os chips somem da bolha do usuário no settle.
          if (merged.remaps.length > 0) onRemapearIds?.(merged.remaps)
          hasMoreHistoryRef.current = merged.hasMore
          setHasMoreHistory(merged.hasMore)
          historyReadyRef.current.add(id)
          setHistoryError(null)
          // Snapshot do store já virou histórico do banco — pode sair.
          if (chatRunsStore.getRun(id)) {
            chatRunsStore.discardRun(id)
          }
          // Atualiza custo agregado na sidebar / lista de chats.
          refreshChats()
        })
        .catch((err) => {
          if (requestId !== historyRequestRef.current) return
          if (abort.signal.aborted) return
          if (err instanceof DOMException && err.name === "AbortError") return
          if (err instanceof Error && /aborted|AbortError/i.test(err.message)) {
            return
          }
          console.error(`Falha ao sincronizar a cauda da conversa ${id}:`, err)
          recarregarTudo()
        })
    },
    [loadHistory, refreshChats],
  )

  const routeChatId = parseChatRoute(location.pathname).chatId
  const expectsThread = Boolean(
    routeChatId || chats.some((c) => c.id === activeChatId),
  )

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

  const setChatModel = React.useCallback(async (id: string, model: string) => {
    // Otimista: o seletor reflete a troca na hora; o PATCH confirma atrás.
    setChats((prev) =>
      prev.map((c) => (c.id === id ? { ...c, model } : c)),
    )
    const updated = await setChatModelApi(id, model)
    setChats((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updated } : c)),
    )
  }, [])

  const deleteChat = React.useCallback(
    async (id: string) => {
      chatRunsStore.cancelRun(id)
      chatRunsStore.discardRun(id)
      clearCachedHistory(id)
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
      expectsThread,
      historyError,
      reloadHistory,
      syncHistoryAfterRun,
      hasMoreHistory,
      isLoadingOlderHistory,
      loadOlderHistory,
      newChat,
      newChatWithMessage,
      consumePendingFirstMessage,
      selectChat,
      renameChat,
      setChatModel,
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
      expectsThread,
      historyError,
      reloadHistory,
      syncHistoryAfterRun,
      hasMoreHistory,
      isLoadingOlderHistory,
      loadOlderHistory,
      newChat,
      newChatWithMessage,
      consumePendingFirstMessage,
      selectChat,
      renameChat,
      setChatModel,
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
