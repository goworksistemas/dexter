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
  type KeyboardEvent,
} from "react"
import type { AssistantRuntime, ThreadMessage } from "@assistant-ui/react"
import { ArrowDown, ArrowUp, Bot, Square } from "lucide-react"

import { renderMarkdownLite } from "@/components/chat/markdown-lite"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { useComposerState, useThreadState } from "@/lib/runtime/use-thread-state"

/** Sugestões exibidas no estado vazio (nenhuma mensagem ainda). */
const SUGESTOES = [
  "Como conectar um formulário do Gravity Forms ao HubSpot?",
  "Qual a diferença entre gowork e gocorporate?",
  "Onde eu registro um card de dev no Notion da S&D?",
  "Me ajuda a investigar um vazamento de lead no portal.",
]

/** Distância (px) do fundo do viewport a partir da qual consideramos que o
 * usuário "está no final" e deve continuar acompanhando o streaming. */
const LIMIAR_PROXIMO_DO_FIM = 80

export function Thread({ runtime }: { runtime: AssistantRuntime }) {
  const threadState = useThreadState(runtime)
  const composerState = useComposerState(runtime)

  const viewportRef = useRef<HTMLDivElement>(null)
  const [pertoDoFim, setPertoDoFim] = useState(true)

  const rolarParaFim = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    setPertoDoFim(true)
  }, [])

  // Acompanha o streaming automaticamente, mas só se o usuário já estava
  // perto do final (não "puxa" a rolagem se ele subiu pra ler algo antigo).
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
            {vazio ? (
              <EmptyState onSuggestion={enviarSugestao} />
            ) : (
              threadState.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))
            )}
          </div>
        </div>

        {!pertoDoFim && !vazio && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              variant="secondary"
              size="icon-sm"
              className="pointer-events-auto rounded-full border border-border shadow-md"
              onClick={() => rolarParaFim()}
              aria-label="Ir para o final"
            >
              <ArrowDown className="size-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-border bg-background px-4 py-3">
        <Composer runtime={runtime} composerState={composerState} isRunning={threadState.isRunning} />
      </div>
    </div>
  )
}

/** Estado vazio: título + sugestões clicáveis que já disparam a mensagem. */
function EmptyState({ onSuggestion }: { onSuggestion: (texto: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-foreground">
          Como posso ajudar?
        </h2>
        <p className="text-sm text-muted-foreground">
          Pergunte sobre sistemas GoWork, formulários, integrações ou
          processos internos.
        </p>
      </div>

      <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGESTOES.map((sugestao) => (
          <button
            key={sugestao}
            type="button"
            onClick={() => onSuggestion(sugestao)}
            className="rounded-lg border border-border bg-card px-3 py-2.5 text-left text-sm text-card-foreground transition-colors hover:bg-muted"
          >
            {sugestao}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Extrai o texto plano (partes "text") de uma mensagem. */
function textoDaMensagem(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

function MessageBubble({ message }: { message: ThreadMessage }) {
  const texto = textoDaMensagem(message)

  if (message.role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {texto}
        </div>
      </div>
    )
  }

  // Assistente (e, por segurança, "system" cai no mesmo layout à esquerda).
  const streaming = message.role === "assistant" && message.status.type === "running"

  return (
    <div className="flex w-full items-start gap-3">
      <Avatar className="mt-0.5 shrink-0">
        <AvatarFallback className="bg-primary/10 text-primary">
          <Bot className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 max-w-[80%] rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-2.5 text-card-foreground">
        {texto.length === 0 && streaming ? (
          <TypingIndicator />
        ) : (
          <>
            <div className="break-words text-sm leading-relaxed">
              {renderMarkdownLite(texto)}
            </div>
            {streaming && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-current align-middle"
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Indicador de "digitando" (3 pontinhos), mostrado enquanto o assistente
 * ainda não emitiu nenhum token de texto. */
function TypingIndicator() {
  return (
    <span
      role="status"
      aria-label="Dexter está digitando"
      className="inline-flex items-center gap-1 py-1"
    >
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
    </span>
  )
}

interface ComposerProps {
  runtime: AssistantRuntime
  composerState: ReturnType<typeof useComposerState>
  isRunning: boolean
}

/** Composer: textarea auto-resize + botão enviar/parar. */
function Composer({ runtime, composerState, isRunning }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize: ajusta a altura ao conteúdo sempre que o texto mudar.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [composerState.text])

  const enviar = () => {
    if (!composerState.canSend) return
    runtime.thread.composer.send()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      enviar()
    }
  }

  return (
    <form
      className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border border-input bg-card p-2 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault()
        enviar()
      }}
    >
      <textarea
        ref={textareaRef}
        value={composerState.text}
        onChange={(e) => runtime.thread.composer.setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Pergunte algo ao Dexter..."
        rows={1}
        className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-card-foreground outline-none placeholder:text-muted-foreground"
      />

      {isRunning ? (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="shrink-0 rounded-lg"
          aria-label="Parar resposta"
          onClick={() => runtime.thread.composer.cancel()}
        >
          <Square className="size-3.5 fill-current" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          className="shrink-0 rounded-lg"
          aria-label="Enviar mensagem"
          disabled={!composerState.canSend}
        >
          <ArrowUp className="size-4" />
        </Button>
      )}
    </form>
  )
}
