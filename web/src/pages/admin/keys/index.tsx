/**
 * /admin/chaves — tela dedicada de chaves de API e acessos por usuário.
 *
 * Tudo pela interface, nada no Infisical (exceto USER_API_KEYS_SECRET, que é
 * o segredo de criptografia — não uma credencial de provedor):
 *   1. Chaves da EMPRESA (globais, valem para todos)
 *   2. Por usuário: modelos liberados + chaves DEDICADAS (têm prioridade
 *      sobre a global; mesma tabela do BYOK das Configurações)
 */
import * as React from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from "lucide-react"

import { PageHeading, PageShell } from "@/components/layout/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  deleteAdminProviderKey,
  deleteAdminUserKey,
  fetchAdminProviderKeys,
  fetchAdminUserKeys,
  fetchAdminUsers,
  patchAdminUser,
  putAdminProviderKey,
  putAdminUserKey,
  type AdminProviderKey,
  type AdminProviderKeysResponse,
  type AdminUserRow,
  type ProviderKeyProvider,
} from "@/lib/admin/api"
import { useModels } from "@/lib/models"
import { useAuth } from "@/providers/auth-provider"
import { cn } from "@/lib/utils"

const KEY_PROVIDERS: {
  id: ProviderKeyProvider
  label: string
  placeholder: string
}[] = [
  { id: "anthropic", label: "Anthropic (Claude)", placeholder: "sk-ant-..." },
  { id: "openai", label: "OpenAI", placeholder: "sk-..." },
  { id: "gemini", label: "Google Gemini", placeholder: "AIza..." },
  { id: "deepseek", label: "DeepSeek", placeholder: "sk-..." },
  { id: "xai", label: "Grok (xAI)", placeholder: "xai-..." },
]

function formatKeyDate(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return "—"
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
}

export function AdminKeysPage() {
  const { user, isLoading: authLoading } = useAuth()
  const { refreshModels } = useModels()

  if (authLoading) {
    return (
      <PageShell className="max-w-5xl">
        <Skeleton className="h-8 w-48" />
      </PageShell>
    )
  }
  if (user?.role !== "admin" && user?.role !== "master") {
    return <Navigate to="/" replace />
  }

  return (
    <PageShell className="max-w-5xl">
      <div className="mb-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1.5">
          <Link to="/admin">
            <ArrowLeft className="size-3.5" />
            Administração
          </Link>
        </Button>
      </div>
      <PageHeading
        title="Chaves & acessos"
        description="Chaves dos provedores de IA e controle por usuário — tudo pela interface, nada no Infisical."
      />

      <div className="mt-6 space-y-6">
        <ProviderKeysCard onChanged={refreshModels} />
        <UsersAccessCard />
      </div>
    </PageShell>
  )
}

/* ------------------------------------------------------------------------- */
/* 1. Chaves da empresa                                                       */
/* ------------------------------------------------------------------------- */

function ProviderKeysCard({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = React.useState<AdminProviderKeysResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState<ProviderKeyProvider | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await fetchAdminProviderKeys())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar chaves.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const onSave = async (provider: ProviderKeyProvider) => {
    const value = (drafts[provider] ?? "").trim()
    if (value.length < 8) {
      toast.error("Cole a chave completa antes de salvar.")
      return
    }
    setBusy(provider)
    try {
      const saved = await putAdminProviderKey(provider, value)
      setData((prev) =>
        prev
          ? {
              ...prev,
              keys: [...prev.keys.filter((k) => k.provider !== provider), saved],
            }
          : prev,
      )
      setDrafts((prev) => ({ ...prev, [provider]: "" }))
      toast.success("Chave salva. Os modelos do provedor entram no catálogo.")
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar chave.")
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (provider: ProviderKeyProvider) => {
    const ok = window.confirm(
      "Remover a chave da empresa? Os modelos deste provedor somem do seletor para todos (exceto quem tem chave dedicada/própria).",
    )
    if (!ok) return
    setBusy(provider)
    try {
      await deleteAdminProviderKey(provider)
      setData((prev) =>
        prev
          ? { ...prev, keys: prev.keys.filter((k) => k.provider !== provider) }
          : prev,
      )
      toast.success("Chave removida.")
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao remover chave.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-xl border border-border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Building2 className="size-3.5 text-muted-foreground" />
            Chaves da empresa
          </h2>
          <p className="text-xs text-muted-foreground">
            Valem para todos os usuários. Guardadas cifradas no banco; a
            interface só mostra os 4 últimos caracteres. Sem nenhuma chave, só
            os modelos gratuitos do Ollama aparecem.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={loading || busy !== null}
          onClick={() => void load()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2 p-4">
          {KEY_PROVIDERS.map((p) => (
            <Skeleton key={p.id} className="h-12 w-full" />
          ))}
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
      ) : data && !data.enabled ? (
        <p className="p-4 text-sm text-muted-foreground">
          Defina <code className="font-mono text-xs">USER_API_KEYS_SECRET</code>{" "}
          no ambiente do AgentCore (é o segredo que criptografa as chaves no
          banco) e reinicie para gerenciar tudo por aqui.
        </p>
      ) : data ? (
        <div className="divide-y divide-border">
          {KEY_PROVIDERS.map((p) => (
            <ProviderKeyRow
              key={p.id}
              provider={p}
              saved={data.keys.find((k) => k.provider === p.id)}
              fallbackEnv={data.env[p.id] ?? false}
              draft={drafts[p.id] ?? ""}
              busy={busy === p.id}
              onDraft={(v) => setDrafts((prev) => ({ ...prev, [p.id]: v }))}
              onSave={() => void onSave(p.id)}
              onDelete={() => void onDelete(p.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ProviderKeyRow({
  provider,
  saved,
  fallbackEnv,
  draft,
  busy,
  onDraft,
  onSave,
  onDelete,
}: {
  provider: (typeof KEY_PROVIDERS)[number]
  saved: AdminProviderKey | undefined
  fallbackEnv: boolean
  draft: string
  busy: boolean
  onDraft: (v: string) => void
  onSave: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <div className="min-w-[11rem] flex-none">
        <p className="text-sm font-medium">{provider.label}</p>
        <p className="text-[11px] text-muted-foreground">
          {saved
            ? `•••• ${saved.last4} · salva em ${formatKeyDate(saved.updated_at)}`
            : fallbackEnv
              ? "usando variável de ambiente (legado — cadastre aqui para migrar)"
              : "sem chave"}
        </p>
      </div>
      <div className="flex min-w-[14rem] flex-1 gap-2">
        <Input
          type="password"
          autoComplete="off"
          placeholder={saved ? "Substituir chave..." : provider.placeholder}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          disabled={busy}
          className="h-8 font-mono text-xs"
        />
        <Button
          size="sm"
          className="h-8"
          disabled={busy || draft.trim().length === 0}
          onClick={onSave}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Salvar"}
        </Button>
        {saved ? (
          <Button
            size="icon-sm"
            variant="outline"
            className="h-8 w-8 flex-none"
            aria-label={`Remover chave ${provider.label}`}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* 2. Acessos por usuário                                                     */
/* ------------------------------------------------------------------------- */

function UsersAccessCard() {
  const [params] = useSearchParams()
  const [users, setUsers] = React.useState<AdminUserRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [openId, setOpenId] = React.useState<string | null>(
    params.get("user"),
  )

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchAdminUsers()
      setUsers(res.users)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q
      ? users
      : users.filter(
          (u) =>
            (u.email || "").toLowerCase().includes(q) ||
            (u.full_name || "").toLowerCase().includes(q),
        )
    // Usuários comuns primeiro (são os que se gerencia aqui); staff no fim.
    return [...list].sort((a, b) => {
      const sa = a.role === "user" ? 0 : 1
      const sb = b.role === "user" ? 0 : 1
      if (sa !== sb) return sa - sb
      return (a.full_name || a.email || "").localeCompare(
        b.full_name || b.email || "",
      )
    })
  }, [users, query])

  return (
    <section className="rounded-xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <UserRound className="size-3.5 text-muted-foreground" />
            Acessos por usuário
          </h2>
          <p className="text-xs text-muted-foreground">
            Escolha quais modelos cada usuário pode usar e, se quiser, dedique
            uma chave de API só para ele (tem prioridade sobre a da empresa).
          </p>
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar usuário…"
            className="h-9 pl-8"
            aria-label="Buscar usuários"
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
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
      ) : visible.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {query.trim()
            ? `Nenhum usuário para “${query.trim()}”.`
            : "Nenhum usuário cadastrado."}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {visible.map((u) => (
            <UserAccessRow
              key={u.id}
              user={u}
              open={openId === u.id}
              onToggle={() => setOpenId((cur) => (cur === u.id ? null : u.id))}
              onUserUpdated={(updated) =>
                setUsers((prev) =>
                  prev.map((x) => (x.id === updated.id ? updated : x)),
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}

function UserAccessRow({
  user,
  open,
  onToggle,
  onUserUpdated,
}: {
  user: AdminUserRow
  open: boolean
  onToggle: () => void
  onUserUpdated: (u: AdminUserRow) => void
}) {
  const isStaff = user.role !== "user"
  const resumoModelos = isStaff
    ? "todos os modelos (staff)"
    : user.allowed_models === null
      ? "todos os modelos"
      : `${user.allowed_models.length} modelo(s) liberado(s)`

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="size-4 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 flex-none text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {user.full_name || user.email || "Sem nome"}
            {user.disabled_at ? (
              <span className="ml-2 text-xs font-normal text-destructive">
                desativado
              </span>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {user.email || user.id}
          </p>
        </div>
        <span
          className={cn(
            "flex-none rounded-md px-2 py-0.5 text-[11px] font-medium",
            isStaff || user.allowed_models === null
              ? "bg-muted text-muted-foreground"
              : user.allowed_models.length === 0
                ? "bg-destructive/10 text-destructive"
                : "bg-primary/10 text-primary",
          )}
        >
          {resumoModelos}
        </span>
      </button>

      {open ? (
        <div className="grid gap-4 border-t border-border/60 bg-muted/20 px-4 py-4 lg:grid-cols-2">
          {isStaff ? (
            <p className="text-sm text-muted-foreground lg:col-span-2">
              Admins e o master sempre veem todos os modelos — só a chave
              dedicada se aplica aqui.
            </p>
          ) : (
            <AllowedModelsEditor user={user} onUserUpdated={onUserUpdated} />
          )}
          <UserKeysEditor userId={user.id} />
        </div>
      ) : null}
    </div>
  )
}

/** Modelos liberados: null = todos; array = só os selecionados. */
function AllowedModelsEditor({
  user,
  onUserUpdated,
}: {
  user: AdminUserRow
  onUserUpdated: (u: AdminUserRow) => void
}) {
  const { models } = useModels()
  const current = user.allowed_models
  const [mode, setMode] = React.useState<"all" | "custom">(
    current === null ? "all" : "custom",
  )
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(current ?? []),
  )
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setMode(current === null ? "all" : "custom")
    setSelected(new Set(current ?? []))
  }, [current])

  const dirty =
    mode === "all"
      ? current !== null
      : current === null ||
        current.length !== selected.size ||
        current.some((id) => !selected.has(id))

  const byProvider = React.useMemo(() => {
    const map = new Map<string, typeof models>()
    for (const m of models) {
      const list = map.get(m.provider) ?? []
      list.push(m)
      map.set(m.provider, list)
    }
    return [...map.entries()]
  }, [models])

  const save = async () => {
    setSaving(true)
    try {
      const updated = await patchAdminUser(user.id, {
        allowed_models: mode === "all" ? null : [...selected],
      })
      onUserUpdated(updated)
      toast.success("Modelos do usuário atualizados.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <p className="text-sm font-medium">Modelos liberados</p>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "all" ? "default" : "outline"}
          disabled={saving}
          onClick={() => setMode("all")}
        >
          Todos
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "custom" ? "default" : "outline"}
          disabled={saving}
          onClick={() => setMode("custom")}
        >
          Somente selecionados
        </Button>
      </div>

      {mode === "custom" ? (
        models.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nenhum modelo habilitado no catálogo.
          </p>
        ) : (
          <div className="max-h-52 space-y-3 overflow-y-auto rounded-md border border-border/70 p-2">
            {byProvider.map(([provider, list]) => (
              <div key={provider}>
                <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {provider}
                </p>
                <div className="space-y-1">
                  {list.map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={selected.has(m.id)}
                        disabled={saving}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(m.id)) next.delete(m.id)
                            else next.add(m.id)
                            return next
                          })
                        }
                      />
                      <span className="truncate">{m.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}

      {mode === "custom" && selected.size === 0 ? (
        <p className="text-xs text-destructive">
          Sem nenhum modelo selecionado, o usuário não consegue conversar.
        </p>
      ) : null}

      <Button
        type="button"
        size="sm"
        disabled={saving || !dirty}
        className="gap-1.5"
        onClick={() => void save()}
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Salvar modelos
      </Button>
    </div>
  )
}

/** Chaves dedicadas ao usuário (prioridade sobre a chave da empresa). */
function UserKeysEditor({ userId }: { userId: string }) {
  const [enabled, setEnabled] = React.useState(true)
  const [keys, setKeys] = React.useState<AdminProviderKey[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState<ProviderKeyProvider | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAdminUserKeys(userId)
      .then((res) => {
        if (cancelled) return
        setEnabled(res.enabled)
        setKeys(res.keys)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Falha ao carregar.")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const onSave = async (provider: ProviderKeyProvider) => {
    const value = (drafts[provider] ?? "").trim()
    if (value.length < 8) {
      toast.error("Cole a chave completa antes de salvar.")
      return
    }
    setBusy(provider)
    try {
      const saved = await putAdminUserKey(userId, provider, value)
      setKeys((prev) => [...prev.filter((k) => k.provider !== provider), saved])
      setDrafts((prev) => ({ ...prev, [provider]: "" }))
      toast.success("Chave dedicada salva para este usuário.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar chave.")
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (provider: ProviderKeyProvider) => {
    setBusy(provider)
    try {
      await deleteAdminUserKey(userId, provider)
      setKeys((prev) => prev.filter((k) => k.provider !== provider))
      toast.success("Chave dedicada removida. Volta a valer a da empresa.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao remover chave.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <KeyRound className="size-3.5 text-muted-foreground" />
          Chaves dedicadas
        </p>
        <p className="text-xs text-muted-foreground">
          Usadas SÓ por este usuário, no lugar da chave da empresa. É o mesmo
          espaço da chave pessoal das Configurações dele.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {KEY_PROVIDERS.slice(0, 3).map((p) => (
            <Skeleton key={p.id} className="h-9 w-full" />
          ))}
        </div>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : !enabled ? (
        <p className="text-xs text-muted-foreground">
          Gestão de chaves desabilitada no servidor (USER_API_KEYS_SECRET
          ausente).
        </p>
      ) : (
        <div className="space-y-2">
          {KEY_PROVIDERS.map((p) => {
            const saved = keys.find((k) => k.provider === p.id)
            const draft = drafts[p.id] ?? ""
            const isBusy = busy === p.id
            return (
              <div key={p.id} className="flex items-center gap-2">
                <span className="w-32 flex-none truncate text-xs font-medium">
                  {p.label}
                </span>
                {saved ? (
                  <span className="flex-none text-[11px] text-muted-foreground">
                    •••• {saved.last4}
                  </span>
                ) : null}
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={saved ? "Substituir..." : p.placeholder}
                  value={draft}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                  }
                  disabled={isBusy}
                  className="h-8 min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  size="sm"
                  className="h-8 flex-none"
                  disabled={isBusy || draft.trim().length === 0}
                  onClick={() => void onSave(p.id)}
                >
                  {isBusy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "Salvar"
                  )}
                </Button>
                {saved ? (
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="h-8 w-8 flex-none"
                    aria-label={`Remover chave ${p.label} deste usuário`}
                    disabled={isBusy}
                    onClick={() => void onDelete(p.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
