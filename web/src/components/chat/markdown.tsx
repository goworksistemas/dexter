/**
 * Renderizador de markdown para respostas do assistente.
 * Blocos ```html / ```md / ```markdown ganham ação "Abrir artefato".
 */
import { memo, useMemo, type ReactNode } from "react"
import { PanelRightOpen } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"

import { detectArtifactBlocks, type DetectedArtifactBlock } from "@/lib/artifacts"
import { cn } from "@/lib/utils"

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

function buildComponents(
  onOpenArtifact?: (block: DetectedArtifactBlock) => void,
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
    img: ({ className, ...props }) => (
      // eslint-disable-next-line jsx-a11y/alt-text
      <img
        className={cn("my-2 max-w-full rounded-lg border border-border/60", className)}
        {...props}
      />
    ),
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
        onOpenArtifact && isArtifactLang(lang)
          ? detectArtifactBlocks(
              `\`\`\`${lang}\n${codeText}\n\`\`\``,
            )[0]
          : null

      return (
        <div className="group/code relative my-3">
          {artifact ? (
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {artifact.kind === "html" ? "HTML" : "Markdown"}
              </span>
              <button
                type="button"
                onClick={() => onOpenArtifact?.(artifact)}
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

interface MarkdownProps {
  content: string
  className?: string
  onOpenArtifact?: (block: DetectedArtifactBlock) => void
}

export const Markdown = memo(function Markdown({
  content,
  className,
  onOpenArtifact,
}: MarkdownProps) {
  const components = useMemo(
    () => buildComponents(onOpenArtifact),
    [onOpenArtifact],
  )

  return (
    <div
      className={cn(
        "markdown-body min-w-0 text-sm break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
