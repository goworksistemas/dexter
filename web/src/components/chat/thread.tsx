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
  Bot,
  Check,
  FileText,
  Paperclip,
  Pencil,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from "lucide-react"

import { ARTIFACT_SPLIT_QUERY } from "@/components/artifacts/artifact-panel"
import { AgentActivity } from "@/components/chat/agent-progress"
import { Markdown } from "@/components/chat/markdown"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { useComposerState, useThreadState } from "@/lib/runtime/use-thread-state"
import { useAuth } from "@/providers/auth-provider"

/** Sugestões exibidas no estado vazio (nenhuma mensagem ainda). */
const SUGESTOES = [
  { label: "Sistemas", text: "Qual a diferença entre gowork e gocorporate?" },
  { label: "Integrações", text: "Como conectar um formulário do Gravity Forms ao HubSpot?" },
  { label: "Notion", text: "Onde eu registro um card de dev no Notion da S&D?" },
  { label: "Leads", text: "Me ajuda a investigar um vazamento de lead no portal." },
]

function saudacao(nome?: string): string {
  const h = new Date().getHours()
  const primeiro = nome?.trim().split(/\s+/)[0]
  const quem = primeiro ? `, ${primeiro}` : ""
  if (h < 12) return `Bom dia${quem}. Em que posso ajudar?`
  if (h < 18) return `Boa tarde${quem}. Em que posso ajudar?`
  return `Boa noite${quem}. Em que posso ajudar?`
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
  /** Progresso do run desta conversa (timeline de tools + fase atual). */
  runProgress?: RunProgress
  /** Passos já persistidos, por id da mensagem do assistente (histórico). */
  stepsByMessageId?: Record<string, RunStep[]>
  onStop: () => void
  onEditUserMessage: (messageId: string, newText: string) => void | Promise<void>
  onRetryLastExchange: () => void | Promise<void>
}

export function Thread({
  runtime,
  pendingAttachments,
  attachmentsByMessageId,
  storeRunning = false,
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
  const [pertoDoFim, setPertoDoFim] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)

  const rolarParaFim = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    setPertoDoFim(true)
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el || !pertoDoFim) return
    el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadState])

  const handleScroll = () => {
    const el = viewportRef.current
    if (!el) return
    const distancia = el.scrollHeight - el.scrollTop - el.clientHeight
    setPertoDoFim(distancia < LIMIAR_PROXIMO_DO_FIM)
  }

  const enviarSugestao = (texto: string) => {
    runtime.thread.composer.setText(texto)
    runtime.thread.composer.send()
  }

  const vazio = threadState.messages.length === 0

  const lastAssistantId = (() => {
    for (let i = threadState.messages.length - 1; i >= 0; i--) {
      if (threadState.messages[i]!.role === "assistant") {
        return threadState.messages[i]!.id
      }
    }
    return null
  })()

  const composer = (
    <Composer
      runtime={runtime}
      composerState={composerState}
      isRunning={isRunning}
      pendingAttachments={pendingAttachments}
      onStop={onStop}
      centered={vazio}
    />
  )

  if (vazio) {
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
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className="scroll-thin h-full overflow-y-auto scroll-smooth"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
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

/** Empty state estilo Claude: saudação tipográfica + composer central + atalhos. */
function EmptyState({
  onSuggestion,
  composer,
}: {
  onSuggestion: (texto: string) => void
  composer: ReactNode
}) {
  const { user } = useAuth()
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-8 animate-[fade-up_0.45s_ease-out]">
      <h2 className="font-display px-2 text-center text-[1.65rem] leading-snug tracking-tight text-foreground sm:text-[2rem]">
        {saudacao(user?.name)}
      </h2>

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
    const blocks = detectArtifactBlocks(texto).filter((b) => b.substantial)
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
        <AvatarFallback className="bg-[linear-gradient(140deg,var(--primary),color-mix(in_srgb,var(--secondary)_60%,var(--primary)))] text-primary-foreground">
          <Bot className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-[min(100%,42rem)] flex-1 flex-col gap-1.5">
        {streaming ? (
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
            <Markdown content={texto} onOpenArtifact={openArtifact} />
          </div>
        )}
        {canRetry && (
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
  pendingAttachments: PendingAttachmentsController
  onStop: () => void
  /** Composer mais generoso no empty state (estilo Claude). */
  centered?: boolean
}

function Composer({
  runtime,
  composerState,
  isRunning,
  pendingAttachments,
  onStop,
  centered = false,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, centered ? 200 : 160)}px`
  }, [composerState.text, centered])

  const enviar = () => {
    if (!composerState.canSend || isRunning) return
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
        placeholder="Pergunte ao Dexter sobre sistemas, processos ou integrações…"
        rows={centered ? 2 : 1}
        className={cn(
          "w-full resize-none bg-transparent px-2.5 text-sm text-card-foreground outline-none placeholder:text-muted-foreground",
          centered ? "min-h-14 py-2" : "max-h-40 min-h-9 py-1.5",
        )}
      />

      <div className="flex items-center justify-between gap-2 px-0.5">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ANEXOS}
          multiple
          hidden
          onChange={handleFileChange}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
          aria-label="Anexar arquivo"
          disabled={isRunning}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="size-4" />
        </Button>

        <div className="flex items-center gap-1.5">
          {isRunning ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="shrink-0 rounded-xl"
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
                "shrink-0 rounded-xl bg-[linear-gradient(135deg,var(--primary),color-mix(in_srgb,var(--secondary)_35%,var(--primary)))] transition-transform hover:scale-105 disabled:hover:scale-100",
              )}
              aria-label="Enviar mensagem"
              disabled={!composerState.canSend}
            >
              <ArrowUp className="size-4" />
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
