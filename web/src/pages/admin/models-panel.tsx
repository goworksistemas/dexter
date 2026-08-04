import * as React from "react"
import { toast } from "sonner"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Search,
  Star,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  bulkPatchAdminModels,
  fetchAdminModels,
  patchAdminModel,
  type AdminCatalogModel,
  type AdminModelProvider,
} from "@/lib/admin/api"
import { useModels } from "@/lib/models"
import { cn } from "@/lib/utils"

const PROVIDERS: AdminModelProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
]

type ModelsTab = "all" | AdminModelProvider

function providerLabel(p: AdminModelProvider): string {
  if (p === "anthropic") return "Claude"
  if (p === "openai") return "OpenAI"
  if (p === "gemini") return "Gemini"
  return "Ollama"
}

function tabLabel(tab: ModelsTab): string {
  return tab === "all" ? "Todos" : providerLabel(tab)
}

function formatReleasedAt(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return "—"
  return d.toLocaleDateString("pt-BR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function formatTokens(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

type VisibilityFilter = "all" | "visible" | "hidden"

type SortKey =
  | "label"
  | "released_at"
  | "input_token_limit"
  | "max_output_tokens"
  | "status"
  | "provider"

type SortDir = "asc" | "desc"

const NO_VISIBLE_MODEL_MSG =
  "Deixe ao menos um modelo visível — o chat para de funcionar sem nenhum."

export function AdminModelsPanel() {
  const { refreshModels } = useModels()
  const [models, setModels] = React.useState<AdminCatalogModel[]>([])
  const [providers, setProviders] = React.useState<
    Record<string, { credential: boolean }>
  >({})
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = React.useState(false)
  const [tab, setTab] = React.useState<ModelsTab>("all")
  const [query, setQuery] = React.useState("")
  const [visibility, setVisibility] = React.useState<VisibilityFilter>("all")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [sortKey, setSortKey] = React.useState<SortKey>("released_at")
  const [sortDir, setSortDir] = React.useState<SortDir>("desc")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAdminModels()
      setModels(data.models)
      setProviders(data.providers ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    setSelected(new Set())
    setExpanded(null)
  }, [tab, query, visibility])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDir(key === "label" || key === "provider" || key === "status" ? "asc" : "desc")
  }

  const counts = React.useMemo(() => {
    const map = Object.fromEntries(
      PROVIDERS.map((p) => [p, 0]),
    ) as Record<AdminModelProvider, number>
    for (const m of models) map[m.provider] += 1
    return map
  }, [models])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = models.filter((m) => {
      if (tab !== "all" && m.provider !== tab) return false
      if (visibility === "visible" && !m.enabled) return false
      if (visibility === "hidden" && m.enabled) return false
      if (!q) return true
      return (
        m.label.toLowerCase().includes(q) ||
        m.api_model.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.traits.some((t) => t.toLowerCase().includes(q)) ||
        providerLabel(m.provider).toLowerCase().includes(q)
      )
    })
    const dir = sortDir === "asc" ? 1 : -1
    const num = (v: number | null | undefined) =>
      v == null || !Number.isFinite(v) ? null : v

    list.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case "released_at": {
          const ta = a.released_at ? Date.parse(a.released_at) : null
          const tb = b.released_at ? Date.parse(b.released_at) : null
          if (ta == null && tb == null) cmp = 0
          else if (ta == null) cmp = 1
          else if (tb == null) cmp = -1
          else cmp = ta - tb
          break
        }
        case "input_token_limit": {
          const ta = num(a.input_token_limit)
          const tb = num(b.input_token_limit)
          if (ta == null && tb == null) cmp = 0
          else if (ta == null) cmp = 1
          else if (tb == null) cmp = -1
          else cmp = ta - tb
          break
        }
        case "max_output_tokens": {
          const ta = num(a.max_output_tokens)
          const tb = num(b.max_output_tokens)
          if (ta == null && tb == null) cmp = 0
          else if (ta == null) cmp = 1
          else if (tb == null) cmp = -1
          else cmp = ta - tb
          break
        }
        case "status":
          cmp = Number(a.enabled) - Number(b.enabled)
          break
        case "provider":
          cmp = providerLabel(a.provider).localeCompare(
            providerLabel(b.provider),
            "pt-BR",
          )
          break
        case "label":
        default:
          cmp = a.label.localeCompare(b.label, "pt-BR")
          break
      }
      if (cmp !== 0) return cmp * dir
      return a.label.localeCompare(b.label, "pt-BR")
    })
    return list
  }, [models, tab, query, visibility, sortKey, sortDir])

  const tabTotal =
    tab === "all" ? models.length : (counts[tab] ?? 0)
  const tabCredentialOk =
    tab === "all"
      ? PROVIDERS.some((p) => providers[p]?.credential)
      : Boolean(providers[tab]?.credential)

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((m) => selected.has(m.id))

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(filtered.map((m) => m.id)))
  }

  const applyOne = async (
    id: string,
    patch: Parameters<typeof patchAdminModel>[1],
  ) => {
    setBusyId(id)
    try {
      const updated = await patchAdminModel(id, patch)
      setModels((prev) =>
        prev.map((m) => {
          if (m.id === id) return { ...m, ...updated }
          if (patch.is_default === true) return { ...m, is_default: false }
          return m
        }),
      )
      toast.success("Salvo.")
      refreshModels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar.")
    } finally {
      setBusyId(null)
    }
  }

  const toggleVisibility = (m: AdminCatalogModel) => {
    const othersVisible = models.filter(
      (x) => x.enabled && x.id !== m.id,
    ).length
    if (m.enabled && othersVisible === 0) {
      toast.error(NO_VISIBLE_MODEL_MSG)
      return
    }
    void applyOne(m.id, { enabled: !m.enabled })
  }

  const bulkSetEnabled = async (enabled: boolean) => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!enabled) {
      const remaining = models.filter(
        (m) => m.enabled && !selected.has(m.id),
      ).length
      if (remaining === 0) {
        toast.error(NO_VISIBLE_MODEL_MSG)
        return
      }
      if (models.some((m) => m.is_default && selected.has(m.id))) {
        const ok = window.confirm(
          "O modelo padrão está na seleção. Ocultá-lo faz o app cair em outro modelo qualquer. Continuar?",
        )
        if (!ok) return
      }
    }
    setBulkBusy(true)
    try {
      const { updated } = await bulkPatchAdminModels(ids, enabled)
      setModels((prev) =>
        prev.map((m) => (selected.has(m.id) ? { ...m, enabled } : m)),
      )
      setSelected(new Set())
      if (updated !== ids.length) {
        toast.warning(
          `Só ${updated} de ${ids.length} modelo(s) foram atualizados — recarregando a lista.`,
        )
        await load()
      } else {
        toast.success(
          enabled
            ? `${updated} de ${ids.length} modelo(s) visíveis no seletor.`
            : `${updated} de ${ids.length} modelo(s) ocultos.`,
        )
      }
      refreshModels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no bulk.")
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Modelos</h2>
          <p className="text-xs text-muted-foreground">
            Catálogo vivo das APIs. Clique no cabeçalho pra ordenar.
            Contexto/max out só quando o provider informa — sem chute manual.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={loading || bulkBusy || busyId !== null}
          onClick={() => void load()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error ? (
        <div className="p-4 text-sm">
          <p className="text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void load()}
          >
            Tentar de novo
          </Button>
        </div>
      ) : models.length === 0 ? (
        <div className="space-y-2 p-4 text-sm text-muted-foreground">
          <p>Nenhum modelo descoberto.</p>
          <p>
            Confira as keys no Infisical e reinicie o AgentCore.
          </p>
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as ModelsTab)}
          className="gap-0"
        >
          <div className="border-b border-border px-3 pt-3">
            <TabsList variant="line" className="w-full justify-start gap-0">
              <TabsTrigger value="all" className="flex-none px-3">
                Todos
                <span className="text-muted-foreground tabular-nums">
                  {models.length}
                </span>
              </TabsTrigger>
              {PROVIDERS.map((p) => (
                <TabsTrigger
                  key={p}
                  value={p}
                  className="flex-none px-3"
                  disabled={counts[p] === 0 && !providers[p]?.credential}
                >
                  {providerLabel(p)}
                  <span className="text-muted-foreground tabular-nums">
                    {counts[p]}
                  </span>
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      providers[p]?.credential
                        ? "bg-emerald-500"
                        : "bg-muted-foreground/40",
                    )}
                    title={
                      providers[p]?.credential ? "chave ok" : "sem chave"
                    }
                  />
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="mt-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <div className="relative min-w-[12rem] flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filtrar por nome ou id…"
                    className="h-8 pl-8 text-sm"
                    aria-label="Filtrar modelos"
                  />
                </div>
                <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                  {(
                    [
                      ["all", "Todos"],
                      ["visible", "Visíveis"],
                      ["hidden", "Ocultos"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setVisibility(key)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] font-medium",
                        visibility === key
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {selected.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
                  <span className="text-xs text-muted-foreground">
                    {selected.size} selecionado(s)
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    disabled={bulkBusy}
                    onClick={() => void bulkSetEnabled(true)}
                  >
                    {bulkBusy ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Eye className="size-3" />
                    )}
                    Mostrar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    disabled={bulkBusy}
                    onClick={() => void bulkSetEnabled(false)}
                  >
                    {bulkBusy ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <EyeOff className="size-3" />
                    )}
                    Ocultar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={bulkBusy}
                    onClick={() => setSelected(new Set())}
                  >
                    Limpar
                  </Button>
                </div>
              ) : null}

              <div className="max-h-[min(36rem,60vh)] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 z-10 border-b border-border bg-card text-xs text-muted-foreground uppercase">
                    <tr>
                      <th className="w-10 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          onChange={toggleAllFiltered}
                          aria-label="Selecionar todos filtrados"
                          className="size-3.5 accent-primary"
                        />
                      </th>
                      <th className="w-8 px-1 py-2" />
                      <th className="px-2 py-2 font-medium">
                        <SortButton
                          label="Modelo"
                          active={sortKey === "label"}
                          dir={sortDir}
                          onClick={() => toggleSort("label")}
                        />
                      </th>
                      <th className="hidden px-2 py-2 font-medium md:table-cell">
                        <SortButton
                          label="Lançamento"
                          active={sortKey === "released_at"}
                          dir={sortDir}
                          onClick={() => toggleSort("released_at")}
                        />
                      </th>
                      <th className="hidden px-2 py-2 font-medium lg:table-cell">
                        <SortButton
                          label="Contexto"
                          active={sortKey === "input_token_limit"}
                          dir={sortDir}
                          onClick={() => toggleSort("input_token_limit")}
                        />
                      </th>
                      <th className="hidden px-2 py-2 font-medium lg:table-cell">
                        <SortButton
                          label="Max out"
                          active={sortKey === "max_output_tokens"}
                          dir={sortDir}
                          onClick={() => toggleSort("max_output_tokens")}
                        />
                      </th>
                      <th className="px-2 py-2 font-medium">
                        <SortButton
                          label="Status"
                          active={sortKey === "status"}
                          dir={sortDir}
                          onClick={() => toggleSort("status")}
                        />
                      </th>
                      <th className="px-2 py-2 text-right font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Nenhum modelo neste filtro.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((m) => {
                        const checked = selected.has(m.id)
                        const open = expanded === m.id
                        return (
                          <React.Fragment key={m.id}>
                            <tr
                              className={cn(
                                "border-b border-border/60 last:border-0",
                                checked && "bg-muted/40",
                                open && "bg-muted/25",
                              )}
                            >
                              <td className="px-3 py-2 align-middle">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleOne(m.id)}
                                  aria-label={`Selecionar ${m.label}`}
                                  className="size-3.5 accent-primary"
                                />
                              </td>
                              <td className="px-1 py-2 align-middle">
                                <button
                                  type="button"
                                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label={
                                    open ? "Recolher detalhes" : "Ver detalhes"
                                  }
                                  aria-expanded={open}
                                  onClick={() =>
                                    setExpanded((cur) =>
                                      cur === m.id ? null : m.id,
                                    )
                                  }
                                >
                                  {open ? (
                                    <ChevronDown className="size-3.5" />
                                  ) : (
                                    <ChevronRight className="size-3.5" />
                                  )}
                                </button>
                              </td>
                              <td className="px-2 py-2 align-middle">
                                <div className="min-w-0">
                                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                                    <span className="truncate">{m.label}</span>
                                    {tab === "all" ? (
                                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                                        {providerLabel(m.provider)}
                                      </span>
                                    ) : null}
                                    {m.is_default ? (
                                      <span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1 py-0.5 text-[10px] text-primary">
                                        <Star className="size-2.5" />
                                        padrão
                                      </span>
                                    ) : null}
                                  </p>
                                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                                    {m.description || m.api_model}
                                  </p>
                                  {m.capabilities ? (
                                    <p className="mt-0.5 flex flex-wrap gap-1">
                                      {m.capabilities.vision ? (
                                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                          Visão
                                        </span>
                                      ) : null}
                                      {m.capabilities.files ? (
                                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                          Arquivos
                                        </span>
                                      ) : null}
                                      {m.capabilities.imageGeneration ? (
                                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                          Gerar imagem
                                        </span>
                                      ) : null}
                                    </p>
                                  ) : null}
                                </div>
                              </td>
                              <td className="hidden whitespace-nowrap px-2 py-2 align-middle text-xs text-muted-foreground md:table-cell">
                                {formatReleasedAt(m.released_at)}
                              </td>
                              <td className="hidden px-2 py-2 align-middle text-xs tabular-nums text-muted-foreground lg:table-cell">
                                {formatTokens(m.input_token_limit)}
                              </td>
                              <td className="hidden px-2 py-2 align-middle text-xs tabular-nums text-muted-foreground lg:table-cell">
                                {formatTokens(m.max_output_tokens)}
                              </td>
                              <td className="px-2 py-2 align-middle">
                                {m.enabled ? (
                                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                                    Visível
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    Oculto
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-2 align-middle">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    disabled={
                                      busyId !== null ||
                                      bulkBusy ||
                                      (m.is_default && m.enabled)
                                    }
                                    title={
                                      m.is_default && m.enabled
                                        ? "Defina outro modelo como padrão antes de ocultar este"
                                        : undefined
                                    }
                                    onClick={() => toggleVisibility(m)}
                                  >
                                    {busyId === m.id ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : m.enabled ? (
                                      "Ocultar"
                                    ) : (
                                      "Mostrar"
                                    )}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    disabled={
                                      busyId !== null ||
                                      bulkBusy ||
                                      m.is_default ||
                                      !m.enabled
                                    }
                                    onClick={() =>
                                      void applyOne(m.id, { is_default: true })
                                    }
                                  >
                                    Padrão
                                  </Button>
                                </div>
                              </td>
                            </tr>
                            {open ? (
                              <tr className="border-b border-border/60 bg-muted/20">
                                <td colSpan={8} className="px-4 py-3">
                                  <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                                    <div>
                                      <dt className="text-muted-foreground">
                                        Pra que serve
                                      </dt>
                                      <dd className="mt-0.5 text-foreground">
                                        {m.description || "—"}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-muted-foreground">
                                        ID da API
                                      </dt>
                                      <dd className="mt-0.5 break-all font-mono text-[11px] text-foreground">
                                        {m.api_model}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-muted-foreground">
                                        Lançamento
                                      </dt>
                                      <dd className="mt-0.5 text-foreground">
                                        {m.released_at
                                          ? formatReleasedAt(m.released_at)
                                          : "Provider não informa a data"}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-muted-foreground">
                                        Contexto (entrada)
                                      </dt>
                                      <dd className="mt-0.5 tabular-nums text-foreground">
                                        {formatTokens(m.input_token_limit)}
                                        {m.input_token_limit
                                          ? ` tokens (${m.input_token_limit.toLocaleString("pt-BR")})`
                                          : ""}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-muted-foreground">
                                        Max output
                                      </dt>
                                      <dd className="mt-0.5 tabular-nums text-foreground">
                                        {formatTokens(m.max_output_tokens)}
                                        {m.max_output_tokens
                                          ? ` tokens (${m.max_output_tokens.toLocaleString("pt-BR")})`
                                          : ""}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-muted-foreground">
                                        Capacidades
                                      </dt>
                                      <dd className="mt-0.5 text-foreground">
                                        {[
                                          m.capabilities?.vision && "Visão",
                                          m.capabilities?.files && "Arquivos",
                                          m.capabilities?.imageGeneration &&
                                            "Gerar imagem",
                                          !m.capabilities?.imageGeneration &&
                                            "Ferramentas/agent",
                                        ]
                                          .filter(Boolean)
                                          .join(" · ") || "—"}
                                      </dd>
                                    </div>
                                    {m.traits.length > 0 ? (
                                      <div className="sm:col-span-2 lg:col-span-3">
                                        <dt className="text-muted-foreground">
                                          Tags
                                        </dt>
                                        <dd className="mt-1 flex flex-wrap gap-1">
                                          {m.traits.map((t) => (
                                            <span
                                              key={t}
                                              className="rounded-md border border-border/70 bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                            >
                                              {t}
                                            </span>
                                          ))}
                                        </dd>
                                      </div>
                                    ) : null}
                                  </dl>
                                </td>
                              </tr>
                            ) : null}
                          </React.Fragment>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                {filtered.length} de {tabTotal} em {tabLabel(tab)} · ordenado por{" "}
                {sortKey === "released_at"
                  ? "lançamento"
                  : sortKey === "input_token_limit"
                    ? "contexto"
                    : sortKey === "max_output_tokens"
                      ? "max out"
                      : sortKey === "status"
                        ? "status"
                        : sortKey === "provider"
                          ? "provedor"
                          : "nome"}{" "}
                ({sortDir === "asc" ? "crescente" : "decrescente"}) ·{" "}
                {tab === "all"
                  ? tabCredentialOk
                    ? "ao menos uma chave ok"
                    : "sem chaves no processo"
                  : tabCredentialOk
                    ? "chave ok"
                    : "sem chave no processo"}
              </p>
          </div>
        </Tabs>
      )}
    </section>
  )
}

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-0.5 py-0.5 font-medium uppercase tracking-wide transition-colors hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      <Icon className="size-3 opacity-80" />
    </button>
  )
}
