/**
 * Botão "i" com detalhe de custo (mensagem ou conversa).
 * Valores em reais: o banco guarda USD e a cotação vem de `GET /api/models`.
 */
import { Info } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatBRL, formatBRLTotal, rateHint, useUsdBrlRate } from "@/lib/models"
import { cn } from "@/lib/utils"

function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  return new Intl.NumberFormat("pt-BR").format(n)
}

export function MessageCostInfo({
  costUsd,
  tokensIn,
  tokensOut,
  model,
  className,
}: {
  costUsd?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  model?: string | null
  className?: string
}) {
  const rate = useUsdBrlRate()
  const hasCost = costUsd != null && Number.isFinite(costUsd)
  const hasTokens =
    (tokensIn != null && tokensIn > 0) || (tokensOut != null && tokensOut > 0)
  if (!hasCost && !hasTokens && !model) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              className,
            )}
            aria-label="Detalhes de uso e custo desta mensagem"
            onClick={(e) => e.stopPropagation()}
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-64 space-y-1 px-3 py-2 text-left text-xs"
        >
          <p className="font-medium text-background">Custo desta resposta</p>
          <p>
            Total:{" "}
            <span className="tabular-nums">
              {hasCost ? formatBRL(costUsd, rate) : "—"}
            </span>
          </p>
          {hasTokens ? (
            <p className="text-background/80">
              Tokens: {formatTokens(tokensIn)} entrada ·{" "}
              {formatTokens(tokensOut)} saída
            </p>
          ) : null}
          {model ? (
            <p className="truncate text-background/70" title={model}>
              Modelo: {model}
            </p>
          ) : null}
          {hasCost ? (
            <p className="text-background/70">{rateHint(rate)}</p>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function ChatCostInfo({
  costUsd,
  className,
  compact = false,
}: {
  costUsd?: number | null
  className?: string
  compact?: boolean
}) {
  const rate = useUsdBrlRate()
  const value = Number(costUsd ?? 0)
  if (!Number.isFinite(value) || value <= 0) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              compact ? "size-5 justify-center" : "px-1 py-0.5 text-[11px]",
              className,
            )}
            aria-label={`Custo da conversa: ${formatBRLTotal(value, rate)}`}
            onClick={(e) => e.stopPropagation()}
          >
            <Info className="size-3" />
            {!compact ? (
              <span className="tabular-nums">{formatBRL(value, rate)}</span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56 px-3 py-2 text-xs">
          <p className="font-medium text-background">Custo desta conversa</p>
          <p className="tabular-nums">{formatBRL(value, rate)}</p>
          <p className="text-background/75">
            Soma do uso de tokens das respostas do assistente.
          </p>
          <p className="text-background/70">{rateHint(rate)}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
