import * as React from "react"
import { ArrowUp } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Composer da página do projeto: abre uma conversa nova já dentro do projeto
 * e envia a primeira mensagem. Sem anexos — o clipe vive no composer do chat,
 * onde os arquivos são anexados à conversa.
 */
export function ProjectComposer({
  projectName,
  onSend,
}: {
  projectName: string
  onSend: (text: string) => void
}) {
  const [text, setText] = React.useState("")
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const enviar = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText("")
    onSend(trimmed)
  }

  return (
    <form
      className="focus-glow shadow-elevate-sm surface-sheen flex w-full flex-col gap-2 rounded-2xl border border-input bg-card p-3 transition-shadow"
      onSubmit={(e) => {
        e.preventDefault()
        enviar()
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            enviar()
          }
        }}
        rows={2}
        placeholder="Escreva uma mensagem…"
        aria-label={`Nova conversa em ${projectName}`}
        className="min-h-14 w-full resize-none bg-transparent px-2.5 py-2 text-sm text-card-foreground outline-none placeholder:text-muted-foreground"
      />

      <div className="flex items-end justify-between gap-2 px-1">
        <p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
          <span className="line-clamp-2">
            A conversa nasce dentro de{" "}
            <span className="font-medium text-foreground/80">{projectName}</span>
            , com as instruções e os arquivos do projeto.
          </span>
        </p>
        <Button
          type="submit"
          size="icon"
          disabled={!text.trim()}
          aria-label="Iniciar conversa"
          className={cn(
            "size-10 shrink-0 rounded-xl sm:size-9",
            "bg-[linear-gradient(135deg,var(--primary),color-mix(in_srgb,var(--secondary)_35%,var(--primary)))]",
            "transition-transform hover:scale-105 disabled:hover:scale-100",
          )}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </form>
  )
}
