import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import {
  Coins,
  Loader2,
  MessageSquare,
  RefreshCw,
  Users,
  Wallet,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  fetchAdminCostCenter,
  patchAdminPricing,
  patchAdminProvider,
  type AdminCostCenter,
} from "@/lib/admin/api"
import { cn } from "@/lib/utils"
import {
  formatBRLTotal,
  formatBRLWithUsd,
  formatUsdReference,
  useUsdBrlRate,
} from "@/lib/models"

const PERIODS = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const

function fmtNum(n: number | null | undefined): string {
  return new Intl.NumberFormat("pt-BR").format(Number(n ?? 0))
}

function fmtCompact(n: number | null | undefined): string {
  return new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(n ?? 0))
}

/** Célula de dinheiro: real em destaque, dólar de origem entre parênteses. */
function Money({
  usd,
  rate,
}: {
  usd: number | null | undefined
  rate: number
}) {
  return (
    <span className="tabular-nums">
      {formatBRLTotal(usd, rate)}{" "}
      <span className="text-[11px] font-normal text-muted-foreground">
        ({formatUsdReference(usd)})
      </span>
    </span>
  )
}

function CreditBadge({ status }: { status: string }) {
  const cls =
    status === "available"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : status === "low"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : status === "depleted"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground"
  const label =
    status === "available"
      ? "Disponível"
      : status === "low"
        ? "Baixo"
        : status === "depleted"
          ? "Esgotado"
          : "Desconhecido"
  return (
    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", cls)}>
      {label}
    </span>
  )
}

function Kpi({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
      </div>
      <p className="mt-2 font-display text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

function CostChart({
  days,
  rate,
}: {
  days: AdminCostCenter["by_day"]
  rate: number
}) {
  if (!days.length) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Sem gasto registrado no período.
      </p>
    )
  }
  const values = days.map((d) => Number(d.cost_usd ?? 0))
  const max = Math.max(...values, 0.0001)
  return (
    <div className="flex h-36 items-end gap-1">
      {days.map((d) => {
        const v = Number(d.cost_usd ?? 0)
        const h = Math.max(2, Math.round((v / max) * 100))
        return (
          <div
            key={d.day}
            className="group relative flex min-w-0 flex-1 flex-col items-center justify-end"
            title={`${d.day}: ${formatBRLWithUsd(v, rate)}`}
          >
            <div
              className="w-full max-w-[14px] rounded-t-sm bg-primary/80 group-hover:bg-primary"
              style={{ height: `${h}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

export function AdminCostCenterPanel({ days }: { days: number }) {
  const usdBrlRate = useUsdBrlRate()
  const [data, setData] = React.useState<AdminCostCenter | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchAdminCostCenter(days)
      setData(res.costCenter)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar.")
    } finally {
      setLoading(false)
    }
  }, [days])

  React.useEffect(() => {
    void load()
  }, [load])

  const savePricing = async (
    id: string,
    patch: {
      input_usd_per_million?: number | null
      output_usd_per_million?: number | null
    },
  ) => {
    setBusy(`pricing:${id}`)
    try {
      await patchAdminPricing(id, patch)
      toast.success("Preço atualizado.")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar.")
    } finally {
      setBusy(null)
    }
  }

  const saveProvider = async (
    id: string,
    patch: Parameters<typeof patchAdminProvider>[1],
  ) => {
    setBusy(`provider:${id}`)
    try {
      await patchAdminProvider(id, patch)
      toast.success("Provider atualizado.")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar.")
    } finally {
      setBusy(null)
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
          Tentar de novo
        </Button>
      </div>
    )
  }

  const t = data?.totals
  const pricedModels = (data?.pricing ?? []).filter(
    (p) =>
      p.input_usd_per_million != null || p.output_usd_per_million != null,
  )

  return (
    <div className={cn(loading && "opacity-60 transition-opacity")}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Preços sincronizados automaticamente na discovery (LiteLLM + OpenRouter).
          Custo = tokens × preço. Providers esgotados somem do seletor. Valores
          em reais pela cotação do dia (US$ 1 = {formatBRLTotal(1, usdBrlRate)});
          o dólar original fica entre parênteses.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 shrink-0"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Atualizar
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Custo total"
          value={formatBRLTotal(t?.cost_usd, usdBrlRate)}
          hint={`Últimos ${days} dias · ${formatUsdReference(t?.cost_usd)}`}
          icon={Coins}
        />
        <Kpi
          label="Usuários ativos"
          value={fmtNum(t?.active_users)}
          icon={Users}
        />
        <Kpi
          label="Conversas"
          value={fmtNum(t?.chats)}
          hint={`${fmtCompact(t?.messages)} mensagens`}
          icon={MessageSquare}
        />
        <Kpi
          label="Tokens"
          value={fmtCompact(t?.tokens)}
          icon={Wallet}
        />
      </div>

      <section className="mt-6 rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold">Gasto por dia</h2>
        <CostChart days={data?.by_day ?? []} rate={usdBrlRate} />
      </section>

      <Tabs defaultValue="users" className="mt-6 gap-4">
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="users">Por usuário</TabsTrigger>
          <TabsTrigger value="chats">Por conversa</TabsTrigger>
          <TabsTrigger value="models">Por modelo</TabsTrigger>
          <TabsTrigger value="providers">Providers & preços</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-0">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Usuário</th>
                  <th className="px-3 py-2 font-medium">Período</th>
                  <th className="px-3 py-2 font-medium">Mês</th>
                  <th className="px-3 py-2 font-medium">Orçamento</th>
                  <th className="px-3 py-2 font-medium">Chats</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_user ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      Sem dados.
                    </td>
                  </tr>
                ) : (
                  (data?.by_user ?? []).map((u) => (
                    <tr
                      key={u.user_id}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="px-3 py-2">
                        <p className="font-medium">
                          {u.full_name || u.email || u.user_id}
                        </p>
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      </td>
                      <td className="px-3 py-2">
                        <Money usd={u.cost_usd} rate={usdBrlRate} />
                      </td>
                      <td className="px-3 py-2">
                        <Money usd={u.cost_usd_month} rate={usdBrlRate} />
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {u.usage_budget_usd != null ? (
                          <Money usd={u.usage_budget_usd} rate={usdBrlRate} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {fmtNum(u.chats)}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {fmtCompact(u.tokens)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="chats" className="mt-0">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Conversa</th>
                  <th className="px-3 py-2 font-medium">Usuário</th>
                  <th className="px-3 py-2 font-medium">Custo</th>
                  <th className="px-3 py-2 font-medium">Msgs</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_chat ?? []).map((c) => (
                  <tr
                    key={c.chat_id}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-3 py-2">
                      <Link
                        to={`/c/${c.chat_id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {c.title?.trim() || "Sem título"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {c.full_name || c.email || c.user_id}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <Money usd={c.cost_usd} rate={usdBrlRate} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {fmtNum(c.messages)}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {fmtCompact(c.tokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="models" className="mt-0">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Modelo</th>
                  <th className="px-3 py-2 font-medium">Custo</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                  <th className="px-3 py-2 font-medium">Msgs</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_model ?? []).map((m) => (
                  <tr
                    key={m.model}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-3 py-2 font-medium">{m.model}</td>
                    <td className="px-3 py-2">
                      <Money usd={m.cost_usd} rate={usdBrlRate} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {fmtCompact(m.tokens)}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {fmtNum(m.messages)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="providers" className="mt-0 space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Crédito corporativo</h3>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-2 font-medium">Provider</th>
                    <th className="px-3 py-2 font-medium">Gasto período</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Saldo USD</th>
                    <th className="px-3 py-2 font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.providers ?? []).map((p) => {
                    const usage = (data?.by_provider ?? []).find(
                      (b) => b.provider === p.id,
                    )
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="px-3 py-2">
                          <p className="font-medium">{p.label || p.id}</p>
                          <p className="text-xs text-muted-foreground">{p.id}</p>
                        </td>
                        <td className="px-3 py-2">
                          <Money usd={usage?.cost_usd ?? 0} rate={usdBrlRate} />
                        </td>
                        <td className="px-3 py-2">
                          <CreditBadge status={p.credit_status} />
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            className="h-8 w-28 tabular-nums"
                            defaultValue={p.balance_usd ?? ""}
                            placeholder="—"
                            onBlur={(e) => {
                              const raw = e.target.value.trim()
                              const next =
                                raw === "" ? null : Number.parseFloat(raw)
                              if (raw !== "" && !Number.isFinite(next)) return
                              if (next === p.balance_usd) return
                              void saveProvider(p.id, {
                                balance_usd: next,
                              })
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                            value={p.credit_status}
                            disabled={busy === `provider:${p.id}`}
                            onChange={(e) => {
                              const st = e.target.value as
                                | "available"
                                | "low"
                                | "depleted"
                                | "unknown"
                              if (st === p.credit_status) return
                              void saveProvider(p.id, { credit_status: st })
                            }}
                          >
                            <option value="available">Disponível</option>
                            <option value="low">Baixo</option>
                            <option value="depleted">Esgotado</option>
                            <option value="unknown">Desconhecido</option>
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Preços por modelo (USD / 1M tokens)
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              {pricedModels.length} com preço automático ·{" "}
              {(data?.pricing ?? []).length} no catálogo. Editar aqui trava o
              valor (override admin).
            </p>
            <div className="max-h-96 overflow-x-auto overflow-y-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="sticky top-0 border-b border-border bg-muted/90 text-xs text-muted-foreground uppercase backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 font-medium">Modelo</th>
                    <th className="px-3 py-2 font-medium">Input / 1M</th>
                    <th className="px-3 py-2 font-medium">Output / 1M</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.by_model ?? []).map((m) => {
                    const row = (data?.pricing ?? []).find(
                      (p) => p.id === m.model || m.model.endsWith(`:${p.id}`),
                    )
                    const id =
                      row?.id ??
                      (m.model.includes(":") ? m.model : null)
                    if (!id) return null
                    return (
                      <tr
                        key={id}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="px-3 py-2">
                          <p className="font-medium">{m.model}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {formatBRLWithUsd(m.cost_usd, usdBrlRate)} no
                            período
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            step="0.0001"
                            min={0}
                            className="h-8 w-24 tabular-nums"
                            defaultValue={row?.input_usd_per_million ?? ""}
                            disabled={busy === `pricing:${id}`}
                            onBlur={(e) => {
                              const raw = e.target.value.trim()
                              const next =
                                raw === "" ? null : Number.parseFloat(raw)
                              if (raw !== "" && !Number.isFinite(next)) return
                              if (next === row?.input_usd_per_million) return
                              void savePricing(id, {
                                input_usd_per_million: next,
                              })
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            step="0.0001"
                            min={0}
                            className="h-8 w-24 tabular-nums"
                            defaultValue={row?.output_usd_per_million ?? ""}
                            disabled={busy === `pricing:${id}`}
                            onBlur={(e) => {
                              const raw = e.target.value.trim()
                              const next =
                                raw === "" ? null : Number.parseFloat(raw)
                              if (raw !== "" && !Number.isFinite(next)) return
                              if (next === row?.output_usd_per_million) return
                              void savePricing(id, {
                                output_usd_per_million: next,
                              })
                            }}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export { PERIODS as COST_CENTER_PERIODS }
