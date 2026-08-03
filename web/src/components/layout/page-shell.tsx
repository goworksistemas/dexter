import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Casca das páginas internas (projetos, conversas, artefatos): o scroll vive
 * aqui, nunca na página inteira — o <main> do shell é overflow-hidden.
 */
export function PageShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn("mx-auto w-full max-w-5xl px-5 py-8 sm:px-8", className)}
      >
        {children}
      </div>
    </div>
  )
}

/** Título da página + ações à direita. */
export function PageHeading({
  title,
  description,
  actions,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display truncate text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
