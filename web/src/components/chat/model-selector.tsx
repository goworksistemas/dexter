/**
 * Seletor de modelo de IA — só lista modelos online (`available: true`).
 * Se nenhum passar no probe: desabilitado + "Nenhum modelo online" + retestar.
 */
import { AlertCircle, Check, ChevronDown, RefreshCw, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useModels } from "@/lib/models"
import type { ModelProvider } from "@/lib/models"

function rotuloProvider(provider: ModelProvider): string {
  return provider === "anthropic" ? "Claude" : "Self-hosted"
}

export function ModelSelector() {
  const {
    models,
    isLoading,
    error,
    selectedModelId,
    selectedOffline,
    selectModel,
    refreshModels,
  } = useModels()

  const modeloAtivo = models.find((m) => m.id === selectedModelId)
  const nenhumOnline = !isLoading && !error && models.length === 0

  if (nenhumOnline || error) {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-lg text-muted-foreground"
          disabled
          aria-label="Nenhum modelo online"
        >
          <AlertCircle className="size-4 text-destructive" />
          <span className="max-w-40 truncate">
            {error ? "Erro ao listar" : "Nenhum modelo online"}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
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
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 rounded-lg text-muted-foreground disabled:opacity-50"
            disabled={isLoading || models.length === 0}
            aria-label="Selecionar modelo de IA"
          >
            <Sparkles className="size-4" />
            <span className="max-w-32 truncate">
              {isLoading ? "Modelo" : (modeloAtivo?.label ?? "Modelo")}
            </span>
            {selectedOffline ? (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                offline
              </span>
            ) : null}
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Modelo de IA</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {models.map((model) => (
            <DropdownMenuItem key={model.id} onSelect={() => selectModel(model.id)}>
              <Check
                className={
                  model.id === selectedModelId ? "size-4 opacity-100" : "size-4 opacity-0"
                }
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{model.label}</span>
                <span className="text-xs text-muted-foreground">
                  {rotuloProvider(model.provider)}
                  {model.latencyMs != null ? ` · ${model.latencyMs}ms` : ""}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => refreshModels()}>
            <RefreshCw className="size-4" />
            Retestar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
