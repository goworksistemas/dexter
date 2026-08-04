/**
 * Seletor de modelo — estilo Claude, no composer.
 * Tags de capacidade: Visão, Arquivos, Gerar imagem.
 */
import {
  AlertCircle,
  Check,
  ChevronDown,
  RefreshCw,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useChatModel } from "@/lib/chats"
import { useModels, modelCaps } from "@/lib/models"
import { cn } from "@/lib/utils"

function CapChips({
  vision,
  files,
  imageGeneration,
}: {
  vision: boolean
  files: boolean
  imageGeneration: boolean
}) {
  const chips: string[] = []
  if (vision) chips.push("Visão")
  if (files) chips.push("Arquivos")
  if (imageGeneration) chips.push("Gerar imagem")
  if (!chips.length) return null
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </span>
  )
}

export function ModelSelector({
  className,
  align = "end",
  scope = "chat",
}: {
  className?: string
  align?: "start" | "center" | "end"
  /**
   * "chat": segue o modelo pinado da conversa ativa; trocar pina SÓ ela.
   * "new": composer fora do chat (ex.: projeto) — sempre o default global.
   */
  scope?: "chat" | "new"
}) {
  const {
    models,
    isLoading,
    error,
    selectedModelId,
    selectedOffline,
    selectModel,
    refreshModels,
  } = useModels()
  const { effectiveModelId, selectModelForChat } = useChatModel()

  const activeModelId = scope === "chat" ? effectiveModelId : selectedModelId
  const onSelect = scope === "chat" ? selectModelForChat : selectModel

  const modeloAtivo = models.find((m) => m.id === activeModelId)
  const nenhumOnline = !isLoading && !error && models.length === 0

  if (nenhumOnline || error) {
    return (
      <div className={cn("flex items-center gap-0.5", className)}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1 rounded-lg px-2 text-xs text-muted-foreground"
          disabled
          aria-label="Nenhum modelo online"
        >
          <AlertCircle className="size-3.5 text-destructive" />
          <span className="max-w-28 truncate">
            {error ? "Erro" : "Offline"}
          </span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8"
          aria-label="Retestar modelos"
          onClick={() => refreshModels()}
          disabled={isLoading}
        >
          <RefreshCw className={`size-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 max-w-[11rem] gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:text-foreground",
            className,
          )}
          disabled={isLoading || models.length === 0}
          aria-label="Selecionar modelo de IA"
        >
          <span className="truncate">
            {isLoading ? "Modelo" : (modeloAtivo?.label ?? "Modelo")}
          </span>
          {selectedOffline ? (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              ·
            </span>
          ) : null}
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        side="top"
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-2rem))]"
      >
        {models.map((model) => {
          const selected = model.id === activeModelId
          const caps = modelCaps(model)
          return (
            <DropdownMenuItem
              key={model.id}
              onSelect={() => onSelect(model.id)}
              className="items-start gap-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {model.label}
                </span>
                {model.description ? (
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {model.description}
                  </span>
                ) : null}
                <CapChips {...caps} />
              </span>
              <Check
                className={cn(
                  "mt-0.5 size-4 shrink-0 text-primary",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => refreshModels()}>
          <RefreshCw className="size-4" />
          Retestar disponibilidade
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
