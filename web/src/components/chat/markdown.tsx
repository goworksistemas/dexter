/**
 * Renderizador de markdown para respostas do assistente.
 * Blocos ```html / ```md / ```markdown ganham ação "Abrir artefato".
 */
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { FileCode2, Loader2, PanelRightOpen } from "lucide-react"
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"

import { MessageImage } from "@/components/chat/message-image"
import { detectArtifactBlocks, type DetectedArtifactBlock } from "@/lib/artifacts"
import { cn } from "@/lib/utils"

const DATA_IMAGE_MD =
  /!\[([^\]]*)\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)\)/gi

/** Tira data URLs enormes do markdown antes do parser (evita travar o main thread). */
function extractInlineDataImages(content: string): {
  markdown: string
  images: string[]
} {
  const images: string[] = []
  const markdown = content.replace(DATA_IMAGE_MD, (_full, alt: string, dataUrl: string) => {
    const idx = images.length
    images.push(dataUrl.replace(/\s+/g, ""))
    return `![${alt}](dexter-img://${idx})`
  })
  return { markdown, images }
}

function markdownUrlTransform(url: string, images: string[]): string {
  if (url.startsWith("dexter-img://")) {
    const idx = Number(url.slice("dexter-img://".length))
    return images[idx] || ""
  }
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) return url
  return defaultUrlTransform(url)
}

function isBlockCode(className?: string): boolean {
  return /(?:^|\s)(language-|hljs)/.test(className ?? "")
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (typeof node === "object" && "props" in node) {
    const props = node.props as { children?: ReactNode }
    return extractText(props.children)
  }
  return ""
}

function langFromClass(className?: string): string | null {
  const m = className?.match(/language-([\w-]+)/)
  return m?.[1]?.toLowerCase() ?? null
}

function isArtifactLang(lang: string | null): lang is "html" | "htm" | "markdown" | "md" | "xhtml" {
  return (
    lang === "html" ||
    lang === "htm" ||
    lang === "markdown" ||
    lang === "md" ||
    lang === "xhtml"
  )
}

/**
 * Card compacto do artefato no chat (estilo Claude): o código NÃO fica aberto
 * na conversa — visualizar/editar é no painel (botão `</>`).
 */
function ArtifactCard({
  block,
  creating,
  onOpen,
}: {
  block: DetectedArtifactBlock
  creating: boolean
  onOpen?: (block: DetectedArtifactBlock) => void
}) {
  const kindLabel = block.kind === "html" ? "HTML" : "Markdown"
  return (
    <div className="my-3">
      <button
        type="button"
        disabled={creating || !onOpen}
        onClick={() => onOpen?.(block)}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3 text-left transition-colors",
          !creating && onOpen
            ? "cursor-pointer hover:border-primary/40 hover:bg-primary/5"
            : "cursor-default",
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background">
          {creating ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <FileCode2 className="size-4 text-primary" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {block.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {creating
              ? `Criando artefato ${kindLabel}…`
              : `Artefato ${kindLabel} · clique para abrir`}
          </span>
        </span>
        {!creating && onOpen ? (
          <PanelRightOpen className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
      </button>
    </div>
  )
}

function buildComponents(
  onOpenArtifact?: (block: DetectedArtifactBlock) => void,
  images: string[] = [],
  streaming = false,
): Components {
  return {
    h1: ({ className, ...props }) => (
      <h1
        className={cn(
          "mt-6 mb-3 border-b border-border/60 pb-2 text-xl font-semibold tracking-tight text-foreground first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    h2: ({ className, ...props }) => (
      <h2
        className={cn(
          "mt-5 mb-2.5 text-lg font-semibold tracking-tight text-foreground first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    h3: ({ className, ...props }) => (
      <h3
        className={cn(
          "mt-4 mb-2 text-base font-semibold text-foreground first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    h4: ({ className, ...props }) => (
      <h4
        className={cn(
          "mt-3.5 mb-1.5 text-sm font-semibold text-foreground first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    h5: ({ className, ...props }) => (
      <h5
        className={cn(
          "mt-3 mb-1.5 text-sm font-semibold text-muted-foreground uppercase tracking-wide first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    h6: ({ className, ...props }) => (
      <h6
        className={cn(
          "mt-3 mb-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    p: ({ className, ...props }) => (
      <p className={cn("mb-3 leading-relaxed last:mb-0", className)} {...props} />
    ),
    ul: ({ className, ...props }) => (
      <ul
        className={cn(
          "mb-3 list-outside list-disc space-y-1 pl-6 marker:text-muted-foreground/60 last:mb-0",
          className,
        )}
        {...props}
      />
    ),
    ol: ({ className, ...props }) => (
      <ol
        className={cn(
          "mb-3 list-outside list-decimal space-y-1 pl-6 marker:font-medium marker:text-muted-foreground/70 last:mb-0",
          className,
        )}
        {...props}
      />
    ),
    li: ({ className, ...props }) => (
      <li
        className={cn(
          "pl-1 leading-relaxed [&>ol]:mt-1.5 [&>ol]:mb-0 [&>p]:mb-1.5 [&>ul]:mt-1.5 [&>ul]:mb-0",
          className,
        )}
        {...props}
      />
    ),
    blockquote: ({ className, ...props }) => (
      <blockquote
        className={cn(
          "my-3 border-l-2 border-primary/40 pl-4 text-muted-foreground italic [&>p]:mb-1.5 [&>p:last-child]:mb-0",
          className,
        )}
        {...props}
      />
    ),
    hr: ({ className, ...props }) => (
      <hr className={cn("my-4 border-border/70", className)} {...props} />
    ),
    a: ({ className, ...props }) => (
      <a
        target="_blank"
        rel="noreferrer"
        className={cn(
          "font-medium text-primary underline decoration-primary/30 underline-offset-4 transition-colors hover:decoration-primary/70",
          className,
        )}
        {...props}
      />
    ),
    strong: ({ className, ...props }) => (
      <strong className={cn("font-semibold text-foreground", className)} {...props} />
    ),
    em: ({ className, ...props }) => (
      <em className={cn("italic", className)} {...props} />
    ),
    del: ({ className, ...props }) => (
      <del className={cn("text-muted-foreground/80", className)} {...props} />
    ),
    img: ({ className, src, alt, title }) => {
      let resolved = typeof src === "string" ? src : ""
      if (resolved.startsWith("dexter-img://")) {
        const idx = Number(resolved.slice("dexter-img://".length))
        resolved = images[idx] || ""
      }
      if (!resolved) return null
      return (
        <MessageImage
          src={resolved}
          alt={typeof alt === "string" ? alt : undefined}
          title={typeof title === "string" ? title : undefined}
          className={className}
        />
      )
    },
    table: ({ className, ...props }) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-border">
        <table className={cn("w-full border-collapse text-sm", className)} {...props} />
      </div>
    ),
    thead: ({ className, ...props }) => (
      <thead className={cn("bg-muted/70", className)} {...props} />
    ),
    tr: ({ className, ...props }) => (
      <tr
        className={cn(
          "border-b border-border/70 last:border-0 [tbody_&]:transition-colors [tbody_&]:hover:bg-muted/40",
          className,
        )}
        {...props}
      />
    ),
    th: ({ className, ...props }) => (
      <th
        className={cn(
          "border-b border-border px-3 py-2 text-left font-semibold text-foreground",
          className,
        )}
        {...props}
      />
    ),
    td: ({ className, ...props }) => (
      <td className={cn("px-3 py-2 align-top", className)} {...props} />
    ),
    pre: ({ className, children, ...props }) => {
      const child = Array.isArray(children) ? children[0] : children
      const childProps =
        child && typeof child === "object" && "props" in child
          ? (child.props as { className?: string; children?: ReactNode })
          : null
      const lang = langFromClass(childProps?.className)
      const codeText = extractText(childProps?.children ?? children).replace(/\n$/, "")
      const artifact =
        (onOpenArtifact || streaming) && isArtifactLang(lang)
          ? detectArtifactBlocks(
              `\`\`\`${lang}\n${codeText}\n\`\`\``,
            )[0]
          : null

      // Artefato de verdade vira card compacto (código só no painel, aba </>).
      // Snippets pequenos continuam como bloco de código normal.
      if (artifact?.substantial) {
        return (
          <ArtifactCard
            block={artifact}
            creating={streaming}
            onOpen={onOpenArtifact}
          />
        )
      }

      return (
        <div className="group/code relative my-3">
          {artifact && onOpenArtifact ? (
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {artifact.kind === "html" ? "HTML" : "Markdown"}
              </span>
              <button
                type="button"
                onClick={() => onOpenArtifact(artifact)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <PanelRightOpen className="size-3.5" />
                Abrir artefato
              </button>
            </div>
          ) : null}
          <pre
            className={cn(
              "overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3.5 text-[0.85em] leading-relaxed",
              className,
            )}
            {...props}
          >
            {children}
          </pre>
        </div>
      )
    },
    code: ({ className, ...props }) => {
      if (isBlockCode(className)) {
        return (
          <code
            className={cn("font-mono text-[0.95em] leading-relaxed", className)}
            {...props}
          />
        )
      }
      return (
        <code
          className={cn(
            "rounded-md border border-border/60 bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground",
            className,
          )}
          {...props}
        />
      )
    },
    input: ({ className, type, ...props }) => {
      if (type === "checkbox") {
        return (
          <input
            type="checkbox"
            disabled
            className={cn("mr-1.5 -mt-0.5 accent-primary", className)}
            {...props}
          />
        )
      }
      return <input type={type} className={className} {...props} />
    },
  }
}

/** Cap de reparse markdown durante stream (~10 fps). Acima disso o main thread morre. */
const STREAM_MARKDOWN_MS = 100

function useStreamingContent(content: string, streaming: boolean): string {
  const deferred = useDeferredValue(content)
  const [throttled, setThrottled] = useState(content)
  const lastFlush = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!streaming) {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      setThrottled(content)
      lastFlush.current = 0
      return
    }

    const now = Date.now()
    const wait = STREAM_MARKDOWN_MS - (now - lastFlush.current)
    if (wait <= 0) {
      lastFlush.current = now
      setThrottled(deferred)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      lastFlush.current = Date.now()
      setThrottled(deferred)
    }, wait)
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [content, deferred, streaming])

  return streaming ? throttled : content
}

interface MarkdownProps {
  content: string
  className?: string
  /** Durante o stream: sem syntax highlight + reparse limitado (menos jank). */
  streaming?: boolean
  onOpenArtifact?: (block: DetectedArtifactBlock) => void
}

export const Markdown = memo(function Markdown({
  content,
  className,
  streaming = false,
  onOpenArtifact,
}: MarkdownProps) {
  const renderContent = useStreamingContent(content, streaming)
  const { markdown, images } = useMemo(
    () => extractInlineDataImages(renderContent),
    [renderContent],
  )
  const components = useMemo(
    () => buildComponents(streaming ? undefined : onOpenArtifact, images, streaming),
    [streaming, onOpenArtifact, images],
  )
  const urlTransform = useMemo(
    () => (url: string) => markdownUrlTransform(url, images),
    [images],
  )
  const rehypePlugins = useMemo(
    () => (streaming ? [] : [rehypeHighlight]),
    [streaming],
  )

  return (
    <div
      className={cn(
        "markdown-body min-w-0 text-sm break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        streaming && "markdown-streaming",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
})
