import * as React from "react"
import { Link, Navigate } from "react-router-dom"
import { toast } from "sonner"
import {
  Activity,
  Loader2,
  MessageSquare,
  Search,
  Shield,
  ShieldCheck,
  Users,
  UserRound,
  UserX,
  Coins,
  Cpu,
  MessagesSquare,
  X,
} from "lucide-react"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  fetchAdminOverview,
  fetchAdminUserDetail,
  fetchAdminUsers,
  patchAdminUser,
  type AdminDayStat,
  type AdminModelStat,
  type AdminOverview,
  type AdminUserDetail,
  type AdminUserRow,
} from "@/lib/admin/api"
import { formatRelative } from "@/lib/dates"
import { useAuth } from "@/providers/auth-provider"
import type { DexterRole } from "@/types"
import { cn } from "@/lib/utils"
import { AdminModelsPanel } from "./models-panel"

const PERIODS = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const

function roleLabel(role: DexterRole): string {
  if (role === "master") return "Master"
  if (role === "admin") return "Admin"
  return "Usuário"
}

function RoleBadge({ role }: { role: DexterRole }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        role === "master" && "bg-primary/15 text-primary",
        role === "admin" && "bg-secondary/20 text-secondary-foreground",
        role === "user" && "bg-muted text-muted-foreground",
      )}
    >
      {role === "master" ? (
        <ShieldCheck className="size-3" />
      ) : role === "admin" ? (
        <Shield className="size-3" />
      ) : (
        <UserRound className="size-3" />
      )}
      {roleLabel(role)}
    </span>
  )
}

function fmtNum(n: number | null | undefined): string {
  return new Intl.NumberFormat("pt-BR").format(Number(n ?? 0))
}

function fmtCompact(n: number | null | undefined): string {
  return new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(n ?? 0))
}

function fmtUsd(n: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(Number(n ?? 0))
}

function shortDay(iso: string): string {
  return iso.slice(5)
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

function UsageChart({
  days,
  metric = "messages",
}: {
  days: AdminDayStat[]
  metric?: "messages" | "tokens"
}) {
  if (!days.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Sem atividade no período.
      </p>
    )
  }
  const values = days.map((d) =>
    metric === "tokens" ? Number(d.tokens || 0) : Number(d.messages || 0),
  )
  const max = Math.max(...values, 1)
  const labelStep = Math.ceil(days.length / 8)

  return (
    <div className="flex h-44 items-end gap-1 sm:gap-1.5">
      {days.map((d, i) => {
        const v = values[i] ?? 0
        const h = Math.max(2, Math.round((v / max) * 100))
        const unit = metric === "tokens" ? "tokens" : "msgs"
        return (
          <div
            key={d.day}
            className="group relative flex min-w-0 flex-1 flex-col items-center justify-end"
            title={`${d.day}: ${fmtNum(v)} ${unit}${d.active_users != null ? ` · ${d.active_users} users` : ""}`}
          >
            <div
              className="w-full max-w-[18px] rounded-t-sm bg-primary/80 transition-colors group-hover:bg-primary"
              style={{ height: `${h}%` }}
            />
            {days.length <= 31 && i % labelStep === 0 ? (
              <span className="mt-1 truncate text-[9px] text-muted-foreground">
                {shortDay(d.day)}
              </span>
            ) : (
              <span className="mt-1 h-3" />
            )}
          </div>
        )
      })}
    </div>
  )
}

function ModelTable({ rows }: { rows: AdminModelStat[] }) {
  if (!rows.length) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nenhum uso de modelo no período.
      </p>
    )
  }
  const maxTokens = Math.max(...rows.map((r) => Number(r.tokens || 0)), 1)
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const tokens = Number(r.tokens || 0)
        const pct = Math.round((tokens / maxTokens) * 100)
        return (
          <div key={r.model} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{r.model}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {fmtCompact(tokens)} tok · {fmtNum(r.messages)} msgs
                {Number(r.cost_usd) > 0 ? ` · ${fmtUsd(r.cost_usd)}` : ""}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              in {fmtCompact(r.tokens_in)} · out {fmtCompact(r.tokens_out)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

export function AdminPage() {
  const { user, isLoading: authLoading } = useAuth()
  const [adminTab, setAdminTab] = React.useState<
    "analytics" | "models" | "users"
  >("analytics")
  const [days, setDays] = React.useState(30)
  const [users, setUsers] = React.useState<AdminUserRow[]>([])
  const [overview, setOverview] = React.useState<AdminOverview | null>(null)
  const [actorRole, setActorRole] = React.useState<DexterRole>("user")
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<AdminUserDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [chartMetric, setChartMetric] = React.useState<"messages" | "tokens">(
    "messages",
  )

  const isStaff =
    user?.role === "admin" ||
    user?.role === "master" ||
    actorRole === "admin" ||
    actorRole === "master"

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [ov, us] = await Promise.all([
        fetchAdminOverview(days),
        fetchAdminUsers(),
      ])
      setOverview(ov.overview)
      setActorRole(ov.actorRole || us.actorRole)
      setUsers(us.users)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar.")
    } finally {
      setLoading(false)
    }
  }, [days])

  React.useEffect(() => {
    if (authLoading) return
    if (user?.role === "admin" || user?.role === "master") {
      void load()
    } else {
      setLoading(false)
    }
  }, [authLoading, user?.role, load])

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void fetchAdminUserDetail(selectedId, days)
      .then((res) => {
        if (!cancelled) setDetail(res.detail)
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Falha no detalhe.")
          setSelectedId(null)
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, days])

  const usageByUser = React.useMemo(() => {
    const map = new Map<
      string,
      { chats: number; messages: number; tokens: number }
    >()
    for (const u of overview?.top_users ?? []) {
      map.set(u.user_id, {
        chats: Number(u.chats || 0),
        messages: Number(u.messages || 0),
        tokens: Number(u.tokens || 0),
      })
    }
    return map
  }, [overview])

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = users.map((u) => ({
      ...u,
      usage: usageByUser.get(u.id) ?? { chats: 0, messages: 0, tokens: 0 },
    }))
    const filtered = !q
      ? list
      : list.filter(
          (u) =>
            (u.email || "").toLowerCase().includes(q) ||
            (u.full_name || "").toLowerCase().includes(q),
        )
    return filtered.sort((a, b) => b.usage.tokens - a.usage.tokens)
  }, [users, query, usageByUser])

  const applyPatch = async (
    id: string,
    patch: { role?: DexterRole; disabled?: boolean },
  ) => {
    setBusyId(id)
    try {
      const updated = await patchAdminUser(id, patch)
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)))
      if (detail?.profile.id === id) {
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                profile: {
                  ...prev.profile,
                  role: updated.role,
                  disabled_at: updated.disabled_at,
                },
              }
            : prev,
        )
      }
      toast.success("Usuário atualizado.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar.")
    } finally {
      setBusyId(null)
    }
  }

  if (authLoading) {
    return (
      <PageShell className="max-w-7xl">
        <Skeleton className="h-8 w-48" />
      </PageShell>
    )
  }

  if (!isStaff && !loading) {
    return <Navigate to="/" replace />
  }

  const t = overview?.totals

  return (
    <PageShell className="max-w-7xl">
      <PageHeading
        title="Administração"
        description="Analytics de uso, tokens por modelo, usuários e conversas."
        actions={
          adminTab === "analytics" ? (
            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => setDays(p.days)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    days === p.days
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : null
        }
      />

      <Tabs
        value={adminTab}
        onValueChange={(v) =>
          setAdminTab(v as "analytics" | "models" | "users")
        }
        className="mt-6 gap-4"
      >
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="analytics" className="flex-none">
            Analytics
          </TabsTrigger>
          <TabsTrigger value="models" className="flex-none">
            Modelos
          </TabsTrigger>
          <TabsTrigger value="users" className="flex-none">
            Usuários
          </TabsTrigger>
        </TabsList>

        <TabsContent value="models" className="mt-0">
          <AdminModelsPanel />
        </TabsContent>

        <TabsContent value="analytics" className="mt-0">
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            Tentar de novo
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Usuários ativos"
              value={fmtNum(t?.users_active)}
              hint={`${fmtNum(t?.users_disabled)} desativados · ${fmtNum(t?.users_total)} total`}
              icon={Users}
            />
            <Kpi
              label="Conversas (período)"
              value={fmtNum(t?.chats_period)}
              hint={`${fmtNum(t?.chats_total)} no total`}
              icon={MessagesSquare}
            />
            <Kpi
              label="Mensagens"
              value={fmtCompact(t?.messages_period)}
              hint={`${fmtCompact(t?.user_messages_period)} user · ${fmtCompact(t?.assistant_messages_period)} assistente`}
              icon={MessageSquare}
            />
            <Kpi
              label="Tokens"
              value={fmtCompact(t?.tokens_period)}
              hint={`in ${fmtCompact(t?.tokens_in_period)} · out ${fmtCompact(t?.tokens_out_period)}${Number(t?.cost_usd_period) > 0 ? ` · ${fmtUsd(t?.cost_usd_period)}` : ""}`}
              icon={Coins}
            />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-5">
            <section className="rounded-xl border border-border p-4 lg:col-span-3">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Uso ao longo do tempo</h2>
                  <p className="text-xs text-muted-foreground">
                    Últimos {days} dias
                  </p>
                </div>
                <div className="flex gap-1 rounded-md border border-border p-0.5">
                  {(
                    [
                      ["messages", "Msgs"],
                      ["tokens", "Tokens"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setChartMetric(key)}
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px] font-medium",
                        chartMetric === key
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <UsageChart days={overview?.by_day ?? []} metric={chartMetric} />
            </section>

            <section className="rounded-xl border border-border p-4 lg:col-span-2">
              <div className="mb-4 flex items-center gap-2">
                <Cpu className="size-4 text-muted-foreground" />
                <div>
                  <h2 className="text-sm font-semibold">Tokens por modelo</h2>
                  <p className="text-xs text-muted-foreground">
                    Assistente no período
                  </p>
                </div>
              </div>
              <ModelTable rows={overview?.by_model ?? []} />
            </section>
          </div>

          <section className="mt-6 rounded-xl border border-border p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Top usuários</h2>
            </div>
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {(overview?.top_users ?? []).slice(0, 12).map((u, i) => (
                <button
                  key={u.user_id}
                  type="button"
                  onClick={() => setSelectedId(u.user_id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
                >
                  <span className="w-5 text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {u.full_name || u.email || "Sem nome"}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {u.email}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                    <p>{fmtCompact(u.tokens)} tok</p>
                    <p>
                      {fmtNum(u.chats)} chats · {fmtNum(u.messages)} msgs
                    </p>
                  </div>
                </button>
              ))}
              {!overview?.top_users?.length ? (
                <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
                  Sem dados.
                </p>
              ) : null}
            </div>
          </section>
        </>
      )}
        </TabsContent>

        <TabsContent value="users" className="mt-0">
          <section className="rounded-xl border border-border">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Usuários</h2>
                <p className="text-xs text-muted-foreground">
                  Clique para analytics e lista de chats
                </p>
              </div>
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  className="h-9 pl-8"
                  aria-label="Buscar usuários"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Usuário</th>
                    <th className="px-4 py-2.5 font-medium">Papel</th>
                    <th className="px-4 py-2.5 font-medium">Tokens</th>
                    <th className="px-4 py-2.5 font-medium">Msgs</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Acesso</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-8 text-center text-muted-foreground"
                      >
                        Nenhum usuário encontrado.
                      </td>
                    </tr>
                  ) : (
                    visible.map((u) => {
                      const disabled = Boolean(u.disabled_at)
                      return (
                        <tr
                          key={u.id}
                          className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-muted/40"
                          onClick={() => setSelectedId(u.id)}
                        >
                          <td className="px-4 py-2.5">
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {u.full_name || "Sem nome"}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {u.email || u.id}
                              </p>
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <RoleBadge role={u.role} />
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                            {fmtCompact(u.usage.tokens)}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                            {fmtNum(u.usage.messages)}
                          </td>
                          <td className="px-4 py-2.5">
                            {disabled ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                                <UserX className="size-3.5" />
                                Off
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                                Ativo
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">
                            {u.last_sign_in_at
                              ? formatRelative(u.last_sign_in_at)
                              : "—"}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <Dialog
        open={Boolean(selectedId)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 text-left">
            <DialogTitle>
              {detail?.profile.full_name ||
                detail?.profile.email ||
                "Detalhe do usuário"}
            </DialogTitle>
            <DialogDescription>
              {detail?.profile.email || selectedId}
              {detail?.profile.role
                ? ` · ${roleLabel(detail.profile.role)}`
                : ""}
              {detail?.profile.disabled_at ? " · desativado" : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {detailLoading || !detail ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi
                    label="Chats período"
                    value={fmtNum(detail.totals.chats_period)}
                    hint={`${fmtNum(detail.totals.chats_total)} total`}
                    icon={MessagesSquare}
                  />
                  <Kpi
                    label="Msgs período"
                    value={fmtCompact(detail.totals.messages_period)}
                    hint={`${fmtCompact(detail.totals.messages_total)} total`}
                    icon={MessageSquare}
                  />
                  <Kpi
                    label="Tokens período"
                    value={fmtCompact(detail.totals.tokens_period)}
                    hint={`in ${fmtCompact(detail.totals.tokens_in_period)} · out ${fmtCompact(detail.totals.tokens_out_period)}`}
                    icon={Coins}
                  />
                  <Kpi
                    label="Tool calls"
                    value={fmtNum(detail.totals.tool_calls_period)}
                    hint={
                      detail.totals.last_message_at
                        ? `Última msg ${formatRelative(detail.totals.last_message_at)}`
                        : "Sem mensagens"
                    }
                    icon={Activity}
                  />
                </div>

                <Tabs defaultValue="chats" className="mt-5">
                  <TabsList>
                    <TabsTrigger value="chats">Conversas</TabsTrigger>
                    <TabsTrigger value="models">Modelos</TabsTrigger>
                    <TabsTrigger value="timeline">Timeline</TabsTrigger>
                    <TabsTrigger value="manage">Gerenciar</TabsTrigger>
                  </TabsList>

                  <TabsContent value="chats" className="mt-3">
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground uppercase">
                          <tr>
                            <th className="px-3 py-2 font-medium">Título</th>
                            <th className="px-3 py-2 font-medium">Msgs</th>
                            <th className="px-3 py-2 font-medium">Tokens</th>
                            <th className="px-3 py-2 font-medium">Modelo</th>
                            <th className="px-3 py-2 font-medium">Atualizado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.chats.length === 0 ? (
                            <tr>
                              <td
                                colSpan={5}
                                className="px-3 py-6 text-center text-muted-foreground"
                              >
                                Nenhuma conversa.
                              </td>
                            </tr>
                          ) : (
                            detail.chats.map((c) => (
                              <tr
                                key={c.id}
                                className="border-b border-border/60 last:border-0"
                              >
                                <td className="px-3 py-2">
                                  <Link
                                    to={`/c/${c.id}`}
                                    className="font-medium text-primary hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {c.title?.trim() || "Sem título"}
                                  </Link>
                                </td>
                                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                                  {fmtNum(c.message_count)}
                                </td>
                                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                                  {fmtCompact(c.tokens)}
                                </td>
                                <td className="max-w-[120px] truncate px-3 py-2 text-xs text-muted-foreground">
                                  {c.last_model || "—"}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground">
                                  {formatRelative(c.updated_at)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </TabsContent>

                  <TabsContent value="models" className="mt-3">
                    <ModelTable rows={detail.by_model} />
                  </TabsContent>

                  <TabsContent value="timeline" className="mt-3 space-y-4">
                    <div>
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        Mensagens/dia
                      </p>
                      <UsageChart days={detail.by_day} metric="messages" />
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        Tokens/dia
                      </p>
                      <UsageChart days={detail.by_day} metric="tokens" />
                    </div>
                  </TabsContent>

                  <TabsContent value="manage" className="mt-3 space-y-4">
                    {detail.profile.role === "master" ? (
                      <p className="text-sm text-muted-foreground">
                        Conta master — sem alterações por aqui.
                      </p>
                    ) : (
                      <>
                        {actorRole === "master" ? (
                          <div>
                            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                              Papel
                            </label>
                            <select
                              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                              value={detail.profile.role}
                              disabled={busyId === detail.profile.id}
                              onChange={(e) => {
                                const role = e.target.value as DexterRole
                                if (role === detail.profile.role) return
                                void applyPatch(detail.profile.id, { role })
                              }}
                            >
                              <option value="user">Usuário</option>
                              <option value="admin">Admin</option>
                            </select>
                          </div>
                        ) : null}
                        <Button
                          variant={
                            detail.profile.disabled_at
                              ? "outline"
                              : "destructive"
                          }
                          disabled={busyId === detail.profile.id}
                          className="gap-1.5"
                          onClick={() =>
                            void applyPatch(detail.profile.id, {
                              disabled: !detail.profile.disabled_at,
                            })
                          }
                        >
                          {busyId === detail.profile.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : null}
                          {detail.profile.disabled_at
                            ? "Reativar usuário"
                            : "Desativar usuário"}
                        </Button>
                      </>
                    )}
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>

          <div className="flex shrink-0 justify-end border-t border-border px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedId(null)}
            >
              <X className="size-3.5" />
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <p className="mt-6 text-xs text-muted-foreground">
        Master: bpm@gowork.com.br. Tokens usam tokens_in + tokens_out quando
        disponíveis; custo aparece só se cost_usd estiver preenchido.
      </p>
    </PageShell>
  )
}
