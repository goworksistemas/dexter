/**
 * Seletor de modelo — modal com tabs, busca e ordenação.
 * Cada card destaca UM preço (média entrada/saída por milhão de tokens, em
 * BRL convertido da tabela USD dos providers); entrada/saída separadas ficam
 * em linha menor e apagada. Descrição amigável em pt-BR e "quando usar" vêm
 * de `modelFriendlyMeta`.
 */
import * as React from "react"
import {
  AlertCircle,
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  KeyRound,
  RefreshCw,
  Search,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useChatModel } from "@/lib/chats"
import {
  useModels,
  modelCaps,
  KEY_SOURCE_LABEL,
  keySourceClass,
  modelContextHint,
  modelCostScore,
  modelCostTier,
  modelCostTierClass,
  modelCostTierLabel,
  modelCostTierTextClass,
  modelFriendlyMeta,
  modelHasPaidPrice,
  modelKeySource,
  modelPricingDetailBrl,
  modelPricingHeadlineBrl,
  modelPricingInOutBrl,
  modelPricingTagBrl,
  modelProfileClass,
  modelProfileLabel,
  modelReleaseHint,
  providerShortLabel,
  type ModelInfo,
  type ModelProvider,
} from "@/lib/models"
import { cn } from "@/lib/utils"

const PROVIDERS: ModelProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "xai",
  "ollama",
]

type ModelsTab = "all" | ModelProvider
type SortKey = "cost" | "label" | "context"

function Tag({
  label,
  title,
  className,
}: {
  label: string
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide",
        className,
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  )
}

function ModelPricingTag({
  model,
  rate,
}: {
  model: ModelInfo
  rate: number
}) {
  const tier = modelCostTier(model)
  return (
    <Tag
      label={modelPricingTagBrl(model, rate)}
      title={modelPricingDetailBrl(model, rate)}
      className={modelCostTierClass(tier)}
    />
  )
}

function KeySourceTag({ model }: { model: ModelInfo }) {
  const source = modelKeySource(model)
  if (source === "free") return null
  const label =
    source === "personal" && model.keyLast4
      ? `${KEY_SOURCE_LABEL.personal} ···${model.keyLast4}`
      : KEY_SOURCE_LABEL[source]
  return (
    <Tag label={label} className={cn("gap-0.5", keySourceClass(source))} />
  )
}

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
  if (files) chips.push("PDF/arquivos")
  if (imageGeneration) chips.push("Gerar imagem")
  if (!chips.length) return null
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-md border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </span>
  )
}

function sortModels(list: ModelInfo[], key: SortKey): ModelInfo[] {
  const copy = [...list]
  copy.sort((a, b) => {
    if (key === "cost") {
      const diff = modelCostScore(a) - modelCostScore(b)
      if (diff !== 0) return diff
      return a.label.localeCompare(b.label, "pt-BR")
    }
    if (key === "context") {
      const diff = (b.inputTokenLimit ?? 0) - (a.inputTokenLimit ?? 0)
      if (diff !== 0) return diff
      return a.label.localeCompare(b.label, "pt-BR")
    }
    return a.label.localeCompare(b.label, "pt-BR")
  })
  return copy
}

function ModelPickRow({
  model,
  rate,
  selected,
  onSelect,
}: {
  model: ModelInfo
  rate: number
  selected: boolean
  onSelect: () => void
}) {
  const caps = modelCaps(model)
  const ctx = modelContextHint(model)
  const lancamento = modelReleaseHint(model)
  const prov = providerShortLabel(model)
  const tier = modelCostTier(model)
  const price = modelPricingHeadlineBrl(model, rate)
  const entradaSaida = modelPricingInOutBrl(model, rate)
  const paid = modelHasPaidPrice(model)
  const friendly = modelFriendlyMeta(model)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-accent/70",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-foreground">
            {model.label}
          </span>
          <Tag
            label={modelProfileLabel(friendly.perfil)}
            className={modelProfileClass(friendly.perfil)}
          />
          <KeySourceTag model={model} />
        </span>
        <span className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              modelCostTierTextClass(tier),
            )}
          >
            {price}
          </span>
          {paid ? (
            <>
              <span className="text-[11px] text-muted-foreground">
                por milhão de tokens · {modelCostTierLabel(tier)}
              </span>
              {entradaSaida ? (
                <span className="text-[10px] tabular-nums text-muted-foreground/60">
                  {entradaSaida}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              sem cobrança por token
            </span>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{prov}</span>
          {ctx ? (
            <>
              <span aria-hidden className="text-border">
                ·
              </span>
              <span>{ctx}</span>
            </>
          ) : null}
          {lancamento ? (
            <>
              <span aria-hidden className="text-border">
                ·
              </span>
              <span>{lancamento}</span>
            </>
          ) : null}
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/75">
          {friendly.descricao}
        </span>
        {friendly.quandoUsar ? (
          // Orientação principal do card: bloco com borda à esquerda e texto
          // em cor cheia, acima da descrição na hierarquia visual.
          <span className="mt-1.5 block rounded-r-md border-l-2 border-primary/50 bg-primary/5 py-1 pr-2 pl-2.5">
            <span className="block text-[10px] font-semibold tracking-wide text-primary/90 uppercase">
              Quando usar
            </span>
            <span className="mt-0.5 block text-xs leading-snug text-foreground/90">
              {friendly.quandoUsar}
            </span>
          </span>
        ) : null}
        <CapChips {...caps} />
      </span>
      <Check
        className={cn(
          "mt-1 size-4 shrink-0 text-primary",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  )
}

export function ModelSelector({
  className,
  align: _align = "end",
  scope = "chat",
}: {
  className?: string
  align?: "start" | "center" | "end"
  scope?: "chat" | "new"
}) {
  void _align
  const {
    models,
    isLoading,
    error,
    selectedModelId,
    selectedOffline,
    usdBrlRate,
    selectModel,
    refreshModels,
  } = useModels()
  const { effectiveModelId, selectModelForChat } = useChatModel()

  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState<ModelsTab>("all")
  const [query, setQuery] = React.useState("")
  const [sortKey, setSortKey] = React.useState<SortKey>("cost")

  const activeModelId = scope === "chat" ? effectiveModelId : selectedModelId
  const onSelect = scope === "chat" ? selectModelForChat : selectModel

  const modeloAtivo = models.find((m) => m.id === activeModelId)
  const nenhumOnline = !isLoading && !error && models.length === 0
  const hasPersonalKey = models.some((m) => modelKeySource(m) === "personal")

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: models.length }
    for (const p of PROVIDERS) c[p] = 0
    for (const m of models) c[m.provider] = (c[m.provider] ?? 0) + 1
    return c
  }, [models])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    let list =
      tab === "all" ? models : models.filter((m) => m.provider === tab)
    if (q) {
      list = list.filter((m) => {
        const friendly = modelFriendlyMeta(m)
        return (
          m.label.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.description ?? "").toLowerCase().includes(q) ||
          friendly.descricao.toLowerCase().includes(q) ||
          friendly.quandoUsar.toLowerCase().includes(q) ||
          modelProfileLabel(friendly.perfil).toLowerCase().includes(q) ||
          providerShortLabel(m).toLowerCase().includes(q) ||
          modelPricingTagBrl(m, usdBrlRate).toLowerCase().includes(q) ||
          modelPricingDetailBrl(m, usdBrlRate).toLowerCase().includes(q) ||
          modelCostTierLabel(modelCostTier(m)).toLowerCase().includes(q)
        )
      })
    }
    return sortModels(list, sortKey)
  }, [models, tab, query, sortKey, usdBrlRate])

  const pick = (id: string) => {
    onSelect(id)
    setOpen(false)
  }

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
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          "h-8 max-w-[16rem] gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:text-foreground",
          className,
        )}
        disabled={isLoading || models.length === 0}
        aria-label="Selecionar modelo de IA"
        onClick={() => setOpen(true)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">
            {isLoading ? "Modelo" : (modeloAtivo?.label ?? "Modelo")}
          </span>
          {modeloAtivo ? (
            <ModelPricingTag model={modeloAtivo} rate={usdBrlRate} />
          ) : null}
          {modeloAtivo && modelKeySource(modeloAtivo) === "personal" ? (
            <KeyRound
              className="size-3 shrink-0 text-violet-600 dark:text-violet-400"
              aria-label="Usando sua chave de API"
            />
          ) : null}
        </span>
        {selectedOffline ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
            ·
          </span>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[min(90dvh,44rem)] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border px-4 py-3 text-left">
            <DialogTitle>Escolher modelo</DialogTitle>
            <DialogDescription>
              Preços em reais por milhão de tokens — quanto menor, mais barata
              a conversa.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as ModelsTab)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="shrink-0 border-b border-border px-3 pt-2">
              <TabsList
                variant="line"
                className="h-auto w-full flex-wrap justify-start gap-0"
              >
                <TabsTrigger value="all" className="flex-none px-3">
                  Todos
                  <span className="text-muted-foreground tabular-nums">
                    {counts.all}
                  </span>
                </TabsTrigger>
                {PROVIDERS.map((p) =>
                  (counts[p] ?? 0) > 0 ? (
                    <TabsTrigger key={p} value={p} className="flex-none px-3">
                      {models.find((m) => m.provider === p)?.providerLabel ?? p}
                      <span className="text-muted-foreground tabular-nums">
                        {counts[p]}
                      </span>
                    </TabsTrigger>
                  ) : null,
                )}
              </TabsList>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <div className="relative min-w-[10rem] flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar modelo…"
                  className="h-8 pl-8 text-sm"
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ArrowDownWideNarrow className="size-3.5" />
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                  aria-label="Ordenar modelos"
                >
                  <option value="cost">Mais barato</option>
                  <option value="label">Nome</option>
                  <option value="context">Maior contexto</option>
                </select>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => refreshModels()}
                disabled={isLoading}
              >
                <RefreshCw
                  className={cn("size-3.5", isLoading && "animate-spin")}
                />
                Atualizar
              </Button>
            </div>

            {hasPersonalKey ? (
              <p className="shrink-0 px-4 py-2 text-[11px] leading-snug text-violet-700 dark:text-violet-300">
                <KeyRound className="mr-1 inline size-3 align-text-bottom" />
                Modelos com <strong>Sua API</strong> debitam a chave que você
                cadastrou em Configurações.
              </p>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {filtered.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  Nenhum modelo neste filtro.
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {filtered.map((model) => (
                    <ModelPickRow
                      key={model.id}
                      model={model}
                      rate={usdBrlRate}
                      selected={model.id === activeModelId}
                      onSelect={() => pick(model.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  )
}
