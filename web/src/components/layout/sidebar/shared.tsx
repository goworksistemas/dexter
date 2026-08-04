import * as React from "react"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Marca do Dexter — mascote oficial. */
export function DexterMark({ className }: { className?: string }) {
  return (
    <img
      src="/dexter.png"
      alt=""
      aria-hidden
      className={cn(
        "size-8 shrink-0 rounded-xl object-cover object-top",
        className,
      )}
    />
  )
}

/** Tooltip padrão da sidebar — usado no rail e nos ícones do header. */
export function SidebarTip({
  label,
  side = "right",
  children,
}: {
  label: React.ReactNode
  side?: "top" | "right" | "bottom" | "left"
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Indicador de geração em andamento (bg run) para itens de conversa. */
export function RunningDots({ className }: { className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <span aria-hidden className="inline-flex items-center gap-0.5">
        <span className="size-1 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.3s]" />
        <span className="size-1 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.15s]" />
        <span className="size-1 animate-bounce rounded-full bg-primary/70" />
      </span>
      <span className="sr-only">processando…</span>
    </span>
  )
}

/** Estado vazio / carregando das listas da sidebar. */
export function SidebarNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 py-2 text-sm text-sidebar-foreground/55">{children}</p>
  )
}
