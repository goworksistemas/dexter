/**
 * Thread de chat do Dexter: lista de mensagens (usuário/assistente) +
 * composer no rodapé.
 *
 * IMPORTANTE — por que isto NÃO usa ThreadPrimitive/ComposerPrimitive/
 * MessagePrimitive do assistant-ui: a versão instalada tem um bug (já
 * corrigido no repositório upstream, ainda não publicado no npm) onde o
 * client reativo interno ("aui", usado por `useAuiState`) para de refletir
 * atualizações após o primeiro commit — mensagens, texto do composer e
 * estado vazio ficam "congelados". Ver `@/lib/runtime/use-thread-state` para
 * os detalhes e o link do commit da correção.
 *
 * Em vez disso, este componente lê e comanda o runtime diretamente pela API
 * imperativa (`runtime.thread` / `runtime.thread.composer`), que funciona
 * corretamente, e renderiza tudo manualmente (bolhas, streaming, composer).
 * Quando a correção for publicada, dá pra voltar a usar os primitivos.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import type { AssistantRuntime, ThreadMessage } from "@assistant-ui/react"
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  FileText,
  ImageIcon,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { ARTIFACT_SPLIT_QUERY } from "@/components/artifacts/artifact-panel"
import { AgentActivity } from "@/components/chat/agent-progress"
import { ComposerPlusMenu } from "@/components/chat/composer-plus-menu"
import { ImageGenPlaceholder } from "@/components/chat/image-gen-placeholder"
import { Markdown } from "@/components/chat/markdown"
import { ModelSelector } from "@/components/chat/model-selector"
import { modelCaps, useModels } from "@/lib/models"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { useMediaQuery } from "@/hooks/use-media-query"
import { detectArtifactBlocks, useArtifactsOptional } from "@/lib/artifacts"
import type { RunProgress, RunStep } from "@/lib/chats"
import { cn } from "@/lib/utils"
import type { ChatAttachment } from "@/lib/agentcore/contract"
import {
  ACCEPT_ANEXOS,
  type PendingAttachment,
  type PendingAttachmentsController,
} from "@/lib/runtime/pending-attachments"
import { nextGreeting, pickGreeting } from "@/lib/greetings"
import { useComposerState, useThreadState } from "@/lib/runtime/use-thread-state"
import { useVoiceDictation } from "@/lib/speech/use-voice-dictation"
import { useAuth } from "@/providers/auth-provider"

/** Sugestões exibidas no estado vazio (nenhuma mensagem ainda). */
const SUGESTOES = [
  { label: "Sistemas", text: "Qual a diferença entre gowork e gocorporate?" },
  { label: "Integrações", text: "Como conectar um formulário do Gravity Forms ao HubSpot?" },
  { label: "Notion", text: "Onde eu registro um card de dev no Notion da S&D?" },
  { label: "Leads", text: "Me ajuda a investigar um vazamento de lead no portal." },
]

/** Texto para clipboard: troca data URLs enormes por marcador legível. */
function textoParaCopiar(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/gi, (_, alt: string) =>
      alt?.trim() ? `[imagem: ${alt}]` : "[imagem]",
    )
    .trim()
}

async function copiarTexto(raw: string): Promise<boolean> {
  const text = textoParaCopiar(raw)
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Distância (px) do fundo do viewport a partir da qual consideramos que o
 * usuário "está no final" e deve continuar acompanhando o streaming. */
const LIMIAR_PROXIMO_DO_FIM = 80

interface ThreadProps {
  runtime: AssistantRuntime
  pendingAttachments: PendingAttachmentsController
  /** Anexos já enviados, por id da mensagem do usuário — pra bolha mostrar
   * as miniaturas do que foi mandado (ver `@/lib/runtime/pending-attachments`). */
  attachmentsByMessageId: Record<string, ChatAttachment[]>
  /** true se o store (background) ou o runtime local está gerando. */
  storeRunning?: boolean
  /** Baixando histórico — nunca mostrar EmptyState/home neste intervalo. */
  isLoadingHistory?: boolean
  /** Deep-link / conversa da sidebar — proíbe splash de “nova conversa”. */
  expectsThread?: boolean
  historyError?: string | null
  onRetryHistory?: () => void
  hasMoreHistory?: boolean
  isLoadingOlderHistory?: boolean
  onLoadOlderHistory?: () => void
  /** Troca de conversa → pin imediato no fim. */
  chatId?: string
  /** Progresso do run desta conversa (timeline de tools + fase atual). */
  runProgress?: RunProgress
  /** Passos já persistidos, por id da mensagem do assistente (histórico). */
  stepsByMessageId?: Record<string, RunStep[]>
  onStop: () => void
  onEditUserMessage: (messageId: string, newText: string) => void | Promise<void>
  onRetryLastExchange: () => void | Promise<void>
}

/** Distância do topo para pedir mensagens mais antigas. */
const LIMIAR_CARREGAR_ANTIGAS = 120

export function Thread({
  runtime,
  pendingAttachments,
  attachmentsByMessageId,
  storeRunning = false,
  isLoadingHistory = false,
  expectsThread = false,
  historyError = null,
  onRetryHistory,
  hasMoreHistory = false,
  isLoadingOlderHistory = false,
  onLoadOlderHistory,
  chatId,
  runProgress,
  stepsByMessageId,
  onStop,
  onEditUserMessage,
  onRetryLastExchange,
}: ThreadProps) {
  const threadState = useThreadState(runtime)
  const composerState = useComposerState(runtime)
  const isRunning = threadState.isRunning || storeRunning

  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [pertoDoFim, setPertoDoFim] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  /**
   * Esconde a lista até colar no fim — sem isso o browser pinta o topo e o
   * usuário vê a conversa “scrolando” pra baixo.
   */
  const [viewportPronto, setViewportPronto] = useState(false)
  /** Ao abrir/trocar chat, cola no fim até o usuário rolar pra cima. */
  const pinBottomRef = useRef(true)
  const pertoDoFimRef = useRef(true)
  /** scrollTop programático dispara onScroll — não pode soltar o pin. */
  const ignoreScrollRef = useRef(false)
  /** Após abrir, ignora “unpin” por um instante (eventos espúrios). */
  const pinGraceUntilRef = useRef(0)
  const prevChatIdRef = useRef(chatId)
  const prevOldestIdRef = useRef<string | null>(null)
  const prevScrollHeightRef = useRef(0)
  const restoringOlderRef = useRef(false)

  const colarNoFim = useCallback((el: HTMLDivElement) => {
    // Nunca usar behavior:"smooth" aqui — é exatamente o scroll animado do topo.
    ignoreScrollRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      ignoreScrollRef.current = false
    })
  }, [])

  const rolarParaFim = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = viewportRef.current
    if (!el) return
    pinBottomRef.current = true
    pertoDoFimRef.current = true
    setPertoDoFim(true)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    } else {
      colarNoFim(el)
    }
  }, [colarNoFim])

  // Troca de conversa: esconde → cola no fim → só então revela.
  useLayoutEffect(() => {
    if (chatId === prevChatIdRef.current) return
    prevChatIdRef.current = chatId
    pinBottomRef.current = true
    pertoDoFimRef.current = true
    setPertoDoFim(true)
    setEditingId(null)
    prevOldestIdRef.current = null
    prevScrollHeightRef.current = 0
    restoringOlderRef.current = false
    pinGraceUntilRef.current = Date.now() + 400
    setViewportPronto(false)
  }, [chatId])

  const oldestId = threadState.messages[0]?.id ?? null
  const lastMessage = threadState.messages[threadState.messages.length - 1]
  const lastMsgLen =
    lastMessage?.role === "assistant" ? textoDaMensagem(lastMessage).length : 0
  const messageCount = threadState.messages.length

  // Prefixo antigo / pin no fim — sempre instantâneo (layout, antes do paint).
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return

    if (
      restoringOlderRef.current &&
      oldestId &&
      oldestId !== prevOldestIdRef.current &&
      prevScrollHeightRef.current > 0
    ) {
      ignoreScrollRef.current = true
      const delta = el.scrollHeight - prevScrollHeightRef.current
      el.scrollTop += delta
      requestAnimationFrame(() => {
        ignoreScrollRef.current = false
      })
      restoringOlderRef.current = false
      prevOldestIdRef.current = oldestId
      prevScrollHeightRef.current = el.scrollHeight
      return
    }

    prevOldestIdRef.current = oldestId
    prevScrollHeightRef.current = el.scrollHeight

    if (pinBottomRef.current && messageCount > 0) {
      pinGraceUntilRef.current = Date.now() + 400
      colarNoFim(el)
      pertoDoFimRef.current = true
      setPertoDoFim(true)
      setViewportPronto(true)
    } else if (messageCount === 0 && (isLoadingHistory || historyError)) {
      setViewportPronto(true)
    } else if (messageCount === 0 && !expectsThread) {
      setViewportPronto(true)
    }
  }, [
    oldestId,
    messageCount,
    chatId,
    isLoadingHistory,
    historyError,
    expectsThread,
    colarNoFim,
  ])

  // Altura muda (markdown, imagem, activity) → re-cola enquanto o pin vale.
  useEffect(() => {
    const el = viewportRef.current
    const content = contentRef.current
    if (!el || !content || messageCount === 0) return

    const ro = new ResizeObserver(() => {
      if (!pinBottomRef.current && !pertoDoFimRef.current) return
      colarNoFim(el)
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [messageCount, chatId, colarNoFim])

  // Streaming: acompanha o fim sem animar.
  useEffect(() => {
    if (!pinBottomRef.current && !pertoDoFimRef.current) return
    const el = viewportRef.current
    if (!el || messageCount === 0) return
    colarNoFim(el)
  }, [lastMsgLen, isRunning, colarNoFim, messageCount])

  const handleScroll = () => {
    const el = viewportRef.current
    if (!el) return
    if (ignoreScrollRef.current) return
    if (!viewportPronto && pinBottomRef.current) return

    const distancia = el.scrollHeight - el.scrollTop - el.clientHeight
    const noFim = distancia < LIMIAR_PROXIMO_DO_FIM

    // No grace da abertura, scroll espúrio não descola o pin.
    if (Date.now() < pinGraceUntilRef.current) {
      if (pinBottomRef.current && !noFim) {
        colarNoFim(el)
      }
      return
    }

    pertoDoFimRef.current = noFim
    setPertoDoFim(noFim)
    if (!noFim) pinBottomRef.current = false

    if (
      el.scrollTop < LIMIAR_CARREGAR_ANTIGAS &&
      hasMoreHistory &&
      !isLoadingOlderHistory &&
      !isLoadingHistory &&
      onLoadOlderHistory
    ) {
      restoringOlderRef.current = true
      prevScrollHeightRef.current = el.scrollHeight
      onLoadOlderHistory()
    }
  }

  const enviarSugestao = (texto: string) => {
    runtime.thread.composer.setText(texto)
    runtime.thread.composer.send()
  }

  const vazio = threadState.messages.length === 0
  // Home/sugestões só em conversa nova de verdade — nunca em /c/:id nem
  // enquanto carrega/falha o histórico (senão o refresh vira “nova conversa”).
  const mostrarHome =
    vazio && !isLoadingHistory && !expectsThread && !historyError

  const lastAssistantId = (() => {
    for (let i = threadState.messages.length - 1; i >= 0; i--) {
      if (threadState.messages[i]!.role === "assistant") {
        return threadState.messages[i]!.id
      }
    }
    return null
  })()

  const { models, selectedModelId } = useModels()
  const selectedModel = models.find((m) => m.id === selectedModelId)
  const capsSelected = modelCaps(selectedModel)
  const imageGenSelected =
    capsSelected.imageGeneration &&
    /image|imagen|dall-e|gpt-image/i.test(selectedModel?.id ?? "")

  const composer = (
    <Composer
      runtime={runtime}
      composerState={composerState}
      isRunning={isRunning}
      composerLocked={isLoadingHistory}
      pendingAttachments={pendingAttachments}
      onStop={onStop}
      centered={mostrarHome}
    />
  )

  if (mostrarHome) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col bg-transparent">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-10">
          <EmptyState onSuggestion={enviarSugestao} composer={composer} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-transparent">
      <div className="relative min-h-0 flex-1">
        {!vazio && (hasMoreHistory || isLoadingOlderHistory) ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
            <span className="rounded-full bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm">
              {isLoadingOlderHistory
                ? "Carregando mensagens anteriores…"
                : "Role para cima para ver o início"}
            </span>
          </div>
        ) : null}
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className={cn(
            // NÃO usar scroll-smooth aqui — anima scrollTop e “abre no topo”.
            "scroll-thin h-full overflow-y-auto",
            !viewportPronto && messageCount > 0 && "invisible",
          )}
        >
          <div
            ref={contentRef}
            className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6"
          >
            {vazio && isLoadingHistory ? <HistorySkeleton /> : null}
            {vazio && !isLoadingHistory && historyError ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <p className="max-w-sm text-sm text-muted-foreground">
                  Não foi possível abrir esta conversa.
                  {historyError ? ` ${historyError}` : ""}
                </p>
                {onRetryHistory ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onRetryHistory}
                  >
                    Tentar novamente
                  </Button>
                ) : null}
              </div>
            ) : null}
            {threadState.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                attachments={attachmentsByMessageId[message.id]}
                isRunning={isRunning}
                forceStreaming={
                  isRunning &&
                  message.role === "assistant" &&
                  message.id === lastAssistantId
                }
                showImagePlaceholder={
                  Boolean(imageGenSelected) ||
                  /gerando imagem|criando imagem/i.test(
                    runProgress?.statusText ?? "",
                  )
                }
                isEditing={editingId === message.id}
                canRetry={
                  !isRunning &&
                  message.role === "assistant" &&
                  message.id === lastAssistantId
                }
                progress={
                  message.role === "assistant" && message.id === lastAssistantId
                    ? runProgress
                    : undefined
                }
                historicalSteps={
                  message.role === "assistant"
                    ? stepsByMessageId?.[message.id]
                    : undefined
                }
                onStartEdit={() => setEditingId(message.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={async (text) => {
                  await onEditUserMessage(message.id, text)
                  setEditingId(null)
                }}
                onRetry={() => void onRetryLastExchange()}
              />
            ))}
          </div>
        </div>

        {!pertoDoFim && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <Button
              variant="secondary"
              size="icon-sm"
              className="shadow-elevate-md pointer-events-auto rounded-full border border-border/70 backdrop-blur transition-transform hover:-translate-y-0.5"
              onClick={() => rolarParaFim()}
              aria-label="Ir para o final"
            >
              <ArrowDown className="size-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="px-4 pb-4 pt-1 sm:px-6">{composer}</div>
    </div>
  )
}

/** Placeholder discreto enquanto o histórico baixa (sem overlay / sem home). */
function HistorySkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Carregando mensagens"
    >
      <div className="flex justify-end">
        <div className="h-10 w-[42%] max-w-xs animate-pulse rounded-2xl rounded-br-md bg-muted/70" />
      </div>
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted/70" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <div className="h-3.5 w-[88%] animate-pulse rounded bg-muted/60" />
          <div className="h-3.5 w-[70%] animate-pulse rounded bg-muted/50" />
          <div className="h-3.5 w-[54%] animate-pulse rounded bg-muted/40" />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="h-10 w-[36%] max-w-xs animate-pulse rounded-2xl rounded-br-md bg-muted/70" />
      </div>
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted/70" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <div className="h-3.5 w-[80%] animate-pulse rounded bg-muted/60" />
          <div className="h-3.5 w-[62%] animate-pulse rounded bg-muted/45" />
        </div>
      </div>
    </div>
  )
}

/** Empty state: hero do Dexter com fade + saudação dinâmica. */
function EmptyState({
  onSuggestion,
  composer,
}: {
  onSuggestion: (texto: string) => void
  composer: ReactNode
}) {
  const { user } = useAuth()
  const [greeting, setGreeting] = useState(() =>
    pickGreeting({ name: user?.name }),
  )
  const [greetingVisible, setGreetingVisible] = useState(true)

  useEffect(() => {
    setGreeting(pickGreeting({ name: user?.name }))
  }, [user?.name])

  // Rotaciona a linha a cada ~11s (fade out/in). Clique troca na hora.
  useEffect(() => {
    const id = window.setInterval(() => {
      setGreetingVisible(false)
      window.setTimeout(() => {
        setGreeting((cur) => nextGreeting({ name: user?.name }, cur))
        setGreetingVisible(true)
      }, 280)
    }, 11_000)
    return () => window.clearInterval(id)
  }, [user?.name])

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-6 animate-[fade-up_0.45s_ease-out] sm:gap-7">
      <div className="relative flex h-36 w-44 items-end justify-center sm:h-40 sm:w-48">
        {/* Glow de pedestal — esconde o corte duro do PNG. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-6 bottom-0 h-16 rounded-[100%] bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--primary)_28%,transparent),transparent_70%)] blur-md"
        />
        <img
          src="/dexter.png"
          alt="Dexter"
          className="relative h-full w-auto max-w-full object-contain object-bottom drop-shadow-[0_12px_28px_rgba(0,0,0,0.35)]"
          style={{
            maskImage:
              "linear-gradient(to bottom, #000 0%, #000 58%, transparent 96%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, #000 0%, #000 58%, transparent 96%)",
          }}
        />
      </div>

      <button
        type="button"
        className="group max-w-xl px-2 text-center outline-none"
        title="Trocar saudação"
        onClick={() => {
          setGreetingVisible(false)
          window.setTimeout(() => {
            setGreeting((cur) => nextGreeting({ name: user?.name }, cur))
            setGreetingVisible(true)
          }, 180)
        }}
      >
        <h2
          className={cn(
            "font-display text-[1.55rem] leading-snug tracking-tight text-foreground transition-all duration-300 sm:text-[1.9rem]",
            greetingVisible
              ? "translate-y-0 opacity-100"
              : "translate-y-1 opacity-0",
          )}
        >
          {greeting}
        </h2>
      </button>

      <div className="w-full">{composer}</div>

      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        {SUGESTOES.map((sugestao) => (
          <button
            key={sugestao.label}
            type="button"
            onClick={() => onSuggestion(sugestao.text)}
            className="rounded-full border border-border/70 bg-card/80 px-3.5 py-1.5 text-sm text-foreground/80 transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card hover:text-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-primary/80" />
              {sugestao.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Extrai o texto plano (partes "text") de uma mensagem. */
function textoDaMensagem(message: ThreadMessage): string {
  const raw = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
  // Apêndice legado de artefatos nunca deve aparecer na bolha do usuário.
  if (message.role !== "user") return raw
  const marker = "\n\n---\nArtefatos editados nesta conversa"
  const idx = raw.indexOf(marker)
  return idx < 0 ? raw : raw.slice(0, idx).trimEnd()
}

interface MessageBubbleProps {
  message: ThreadMessage
  attachments?: ChatAttachment[]
  isRunning: boolean
  /** Garante bolinhas/processando ao voltar num chat com run em background. */
  forceStreaming?: boolean
  isEditing: boolean
  canRetry: boolean
  /** Quadro shimmer enquanto gera imagem. */
  showImagePlaceholder?: boolean
  /** Progresso do run ao vivo (ou já encerrado) desta resposta. */
  progress?: RunProgress
  /** Passos persistidos desta resposta (conversa recarregada). */
  historicalSteps?: RunStep[]
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (text: string) => void | Promise<void>
  onRetry: () => void
}

function MessageBubble({
  message,
  attachments,
  isRunning,
  forceStreaming = false,
  isEditing,
  canRetry,
  showImagePlaceholder = false,
  progress,
  historicalSteps,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRetry,
}: MessageBubbleProps) {
  const texto = textoDaMensagem(message)
  const artifacts = useArtifactsOptional()
  const autoOpenedRef = useRef(false)
  // Sem espaço para o split, abrir sozinho esconderia a conversa inteira: no
  // mobile o artefato só abre pelo botão "Abrir artefato".
  const canAutoOpenArtifact = useMediaQuery(ARTIFACT_SPLIT_QUERY)
  const streaming =
    forceStreaming ||
    (message.role === "assistant" && message.status?.type === "running")
  // Run ao vivo desta sessão tem prioridade sobre o que veio da auditoria.
  const passosConcluidos =
    progress && progress.steps.length > 0 ? progress.steps : (historicalSteps ?? [])

  useEffect(() => {
    if (message.role !== "assistant") return
    if (!canAutoOpenArtifact) return
    if (streaming || !artifacts || autoOpenedRef.current || !texto) return
    // Não passa megabytes de base64 no detector de artefatos.
    const textoLeve = texto.includes("data:image/")
      ? texto.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, "[imagem]")
      : texto
    const blocks = detectArtifactBlocks(textoLeve).filter((b) => b.substantial)
    if (blocks.length === 0) return
    autoOpenedRef.current = true
    void artifacts.ensureFromBlock(blocks[0]!, message.id)
  }, [canAutoOpenArtifact, streaming, texto, artifacts, message.id, message.role])

  const openArtifact = useCallback(
    (block: Parameters<NonNullable<typeof artifacts>["ensureFromBlock"]>[0]) => {
      void artifacts?.ensureFromBlock(block, message.id)
    },
    [artifacts, message.id],
  )

  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    const ok = await copiarTexto(texto)
    if (!ok) {
      toast.error("Não foi possível copiar")
      return
    }
    setCopied(true)
    toast.success("Mensagem copiada")
    window.setTimeout(() => setCopied(false), 1600)
  }, [texto])

  if (message.role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="flex max-w-[82%] flex-col gap-2 items-end">
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {attachments.map((anexo, i) => (
                <AttachmentThumb key={`${message.id}-${i}`} attachment={anexo} />
              ))}
            </div>
          )}
          {isEditing ? (
            <UserEditForm
              initialText={texto}
              onCancel={onCancelEdit}
              onSave={onSaveEdit}
            />
          ) : (
            <>
              {texto.length > 0 && (
                <div className="shadow-elevate-sm rounded-2xl rounded-br-md bg-[linear-gradient(135deg,var(--primary),color-mix(in_srgb,var(--secondary)_35%,var(--primary)))] px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
                  {texto}
                </div>
              )}
              {!isRunning && (
                <div className="flex items-center gap-1">
                  {texto.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void onCopy()}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="Copiar mensagem"
                    >
                      {copied ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      {copied ? "Copiado" : "Copiar"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onStartEdit}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Editar mensagem"
                  >
                    <Pencil className="size-3" />
                    Editar
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full items-start gap-3">
      <Avatar className="mt-0.5 shrink-0 ring-2 ring-background">
        <AvatarImage src="/dexter.png" alt="Dexter" className="object-cover object-top" />
        <AvatarFallback className="bg-muted text-xs font-medium">Dx</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-[min(100%,42rem)] flex-1 flex-col gap-1.5">
        {streaming && showImagePlaceholder ? (
          <ImageGenPlaceholder
            label={
              progress?.statusText?.trim() &&
              !/^pensando$/i.test(progress.statusText.trim())
                ? progress.statusText
                : "Criando imagem"
            }
          />
        ) : streaming ? (
          <AgentActivity
            running
            steps={progress?.steps ?? []}
            statusText={progress?.statusText}
            startedAt={progress?.startedAt}
          />
        ) : (
          passosConcluidos.length > 0 && (
            <AgentActivity
              running={false}
              steps={passosConcluidos}
              startedAt={progress?.startedAt}
              finishedAt={progress?.finishedAt}
            />
          )
        )}
        {texto.length > 0 && (
          <div className="min-w-0 text-card-foreground">
            <Markdown
              content={texto}
              streaming={streaming}
              onOpenArtifact={streaming ? undefined : openArtifact}
            />
          </div>
        )}
        {!streaming && texto.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pl-1">
            <button
              type="button"
              onClick={() => void onCopy()}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Copiar mensagem"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copiado" : "Copiar"}
            </button>
            {canRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Tentar novamente"
              >
                <RefreshCw className="size-3" />
                Tentar novamente
              </button>
            )}
          </div>
        )}
        {canRetry && (streaming || texto.length === 0) && (
          <div className="flex items-center gap-1 pl-1">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Tentar novamente"
            >
              <RefreshCw className="size-3" />
              Tentar novamente
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function UserEditForm({
  initialText,
  onCancel,
  onSave,
}: {
  initialText: string
  onCancel: () => void
  onSave: (text: string) => void | Promise<void>
}) {
  const [text, setText] = useState(initialText)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  const salvar = async () => {
    if (saving || !text.trim()) return
    setSaving(true)
    try {
      await onSave(text)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="shadow-elevate-sm flex w-full min-w-[16rem] flex-col gap-2 rounded-2xl border border-border/70 bg-card p-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const el = e.target
          el.style.height = "auto"
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            void salvar()
          }
        }}
        rows={2}
        className="max-h-48 min-h-16 w-full resize-none rounded-xl bg-background px-3 py-2 text-sm text-foreground outline-none ring-1 ring-border focus:ring-primary/40"
        aria-label="Editar mensagem"
      />
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          <X className="size-3.5" />
          Cancelar
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void salvar()}
          disabled={saving || !text.trim()}
        >
          <Check className="size-3.5" />
          Salvar e regenerar
        </Button>
      </div>
    </div>
  )
}

function dataUrl(attachment: ChatAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`
}

function AttachmentThumb({ attachment }: { attachment: ChatAttachment }) {
  if (attachment.type === "image") {
    return (
      <img
        src={dataUrl(attachment)}
        alt={attachment.name}
        className="shadow-elevate-sm size-16 rounded-lg border border-border/50 object-cover"
      />
    )
  }
  return (
    <span className="shadow-elevate-sm flex max-w-[10rem] items-center gap-1.5 rounded-lg border border-border/50 bg-card px-2.5 py-1.5 text-xs text-card-foreground">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{attachment.name}</span>
    </span>
  )
}

interface ComposerProps {
  runtime: AssistantRuntime
  composerState: ReturnType<typeof useComposerState>
  isRunning: boolean
  /** Carregando histórico — desabilita envio, sem mostrar botão Parar. */
  composerLocked?: boolean
  pendingAttachments: PendingAttachmentsController
  onStop: () => void
  /** Composer mais generoso no empty state (estilo Claude). */
  centered?: boolean
}

function Composer({
  runtime,
  composerState,
  isRunning,
  composerLocked = false,
  pendingAttachments,
  onStop,
  centered = false,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { models, selectedModelId } = useModels()
  const selected = models.find((m) => m.id === selectedModelId)
  const caps = modelCaps(selected)
  const imageGenModel =
    caps.imageGeneration &&
    (/image|imagen|dall-e|gpt-image/i.test(selected?.id ?? "") ||
      (!caps.files && caps.imageGeneration))
  const imageOnly = imageGenModel
  // Geração (Nano Banana / gpt-image): anexa só imagem de referência.
  const canAttachImages = caps.vision
  const canAttachFiles = caps.files && !imageOnly
  const canAttach = canAttachImages || canAttachFiles

  const acceptAnexos = [
    canAttachImages ? "image/png,image/jpeg,image/webp,image/gif" : "",
    canAttachFiles ? "application/pdf" : "",
  ]
    .filter(Boolean)
    .join(",")

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, centered ? 200 : 160)}px`
  }, [composerState.text, centered])

  // Troca de modelo → remove anexos que o modelo atual não aceita.
  useEffect(() => {
    const pending = pendingAttachments.attachments
    if (!pending.length) return
    const invalid = pending.some(
      (a) =>
        (a.type === "image" && !canAttachImages) ||
        (a.type === "document" && !canAttachFiles),
    )
    if (!invalid) return
    pendingAttachments.clear()
    toast.message("Anexos removidos: o modelo atual não os suporta.")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao mudar caps/modelo
  }, [selectedModelId, canAttachImages, canAttachFiles])

  const enviar = () => {
    if (!composerState.canSend || isRunning || composerLocked) return
    runtime.thread.composer.send()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      enviar()
    }
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const { files } = e.target
    if (files && files.length > 0) void pendingAttachments.addFiles(files)
    e.target.value = ""
  }

  const dictationBaseRef = useRef("")
  const voice = useVoiceDictation({
    disabled: isRunning || composerLocked,
    onRecordingStart: () => {
      dictationBaseRef.current = composerState.text ?? ""
    },
    onTranscript: (dictated) => {
      const base = dictationBaseRef.current
      const next =
        base && dictated && !/\s$/.test(base) && !/^\s/.test(dictated)
          ? `${base} ${dictated}`
          : `${base}${dictated}`
      runtime.thread.composer.setText(next)
      textareaRef.current?.focus()
    },
  })

  const placeholder = imageOnly
    ? canAttachImages
      ? "Descreva a imagem… Anexe uma referência se quiser editar."
      : "Descreva a imagem que deseja gerar…"
    : canAttach
      ? "Pergunte ao Dexter — pode anexar imagem ou PDF…"
      : "Pergunte ao Dexter sobre sistemas, processos ou integrações…"

  return (
    <form
      className={cn(
        "focus-glow shadow-elevate-sm surface-sheen mx-auto flex w-full flex-col gap-2 border border-input bg-card transition-shadow",
        centered
          ? "max-w-2xl rounded-[1.6rem] p-3 sm:p-3.5"
          : "max-w-3xl rounded-2xl p-2",
      )}
      onSubmit={(e) => {
        e.preventDefault()
        enviar()
      }}
    >
      {pendingAttachments.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pt-1">
          {pendingAttachments.attachments.map((anexo) => (
            <PendingAttachmentChip
              key={anexo.id}
              attachment={anexo}
              onRemove={() => pendingAttachments.remove(anexo.id)}
            />
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={composerState.text}
        onChange={(e) => runtime.thread.composer.setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={centered ? 2 : 1}
        className={cn(
          "w-full resize-none bg-transparent px-2.5 text-sm text-card-foreground outline-none placeholder:text-muted-foreground",
          centered ? "min-h-14 py-2" : "max-h-40 min-h-9 py-1.5",
        )}
      />

      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptAnexos || ACCEPT_ANEXOS}
            multiple
            hidden
            onChange={handleFileChange}
          />
          <ComposerPlusMenu
            canAttach={canAttach}
            imageOnly={Boolean(imageOnly)}
            canAttachImages={canAttachImages}
            canAttachFiles={canAttachFiles}
            disabled={isRunning || composerLocked}
            onAttachClick={() => fileInputRef.current?.click()}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "size-8 shrink-0 rounded-xl",
              voice.isRecording
                ? "bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-label={
              voice.isRecording
                ? "Parar ditado"
                : voice.isTranscribing
                  ? "Finalizando transcrição…"
                  : "Ditar por voz (ao vivo)"
            }
            title={
              voice.isRecording
                ? "Clique para parar — o texto vai se corrigindo enquanto você fala"
                : voice.isTranscribing
                  ? "Finalizando a transcrição…"
                  : "Clique para falar — o texto aparece e se corrige ao vivo"
            }
            disabled={
              isRunning ||
              composerLocked ||
              voice.isTranscribing ||
              !voice.supported
            }
            onClick={() => voice.toggle()}
          >
            {voice.isTranscribing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : voice.isRecording ? (
              <Square className="size-3.5 fill-current" />
            ) : (
              <Mic className="size-4" />
            )}
          </Button>
          {voice.isRecording ? (
            <span className="hidden items-center gap-1 text-[11px] font-medium text-destructive sm:inline-flex">
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              Ouvindo…
            </span>
          ) : voice.isTranscribing ? (
            <span className="hidden items-center gap-1 text-[11px] font-medium text-muted-foreground sm:inline-flex">
              Transcrevendo…
            </span>
          ) : null}
          {imageOnly ? (
            <span
              className="inline-flex items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-300"
              title="Modelo só de imagem — para perguntas de chat (Notion, sistemas), troque o modelo no seletor"
            >
              <ImageIcon className="size-3.5" />
              Só imagem — troque o modelo p/ chat
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 items-center gap-0.5">
          <ModelSelector />
          {isRunning ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-8 shrink-0 rounded-xl"
              aria-label="Parar resposta"
              onClick={onStop}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className={cn(
                "size-8 shrink-0 rounded-xl bg-[linear-gradient(135deg,var(--primary),color-mix(in_srgb,var(--secondary)_35%,var(--primary)))] transition-transform hover:scale-105 disabled:hover:scale-100",
              )}
              aria-label={imageOnly ? "Gerar imagem" : "Enviar mensagem"}
              disabled={!composerState.canSend || composerLocked}
            >
              {imageOnly ? (
                <ImageIcon className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

function PendingAttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment
  onRemove: () => void
}) {
  return (
    <div className="group relative flex items-center gap-1.5 rounded-lg border border-border/70 bg-secondary/40 py-1 pr-1.5 pl-1">
      {attachment.type === "image" ? (
        <img
          src={dataUrl(attachment)}
          alt={attachment.name}
          className="size-8 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-card">
          <FileText className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="max-w-24 truncate text-xs text-card-foreground">{attachment.name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remover ${attachment.name}`}
        className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
