import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowLeft, KeyRound, LogOut, Monitor, Moon, Sun, Trash2, Users } from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  updatePassword,
  updateProfileName,
  updateProfilePreferences,
  updateProfileTheme,
} from "@/lib/supabase"
import {
  deleteUserKey,
  fetchUserKeys,
  saveUserKey,
  type UserKey,
  type UserKeyProvider,
} from "@/lib/user-keys/api"
import { useAuth } from "@/providers/auth-provider"
import { useTheme, type Theme } from "@/providers/theme-provider"
import { cn } from "@/lib/utils"

function initials(name?: string, email?: string | null): string {
  const source = (name || email || "?").trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Claro", icon: Sun },
  { id: "dark", label: "Escuro", icon: Moon },
  { id: "system", label: "Sistema", icon: Monitor },
]

/** `of` já vem com a preposição: os nomes têm gêneros diferentes em PT. */
const KEY_PROVIDERS: {
  id: UserKeyProvider
  label: string
  of: string
  placeholder: string
}[] = [
  { id: "anthropic", label: "Anthropic", of: "da Anthropic", placeholder: "sk-ant-..." },
  { id: "openai", label: "OpenAI", of: "da OpenAI", placeholder: "sk-..." },
  { id: "gemini", label: "Google Gemini", of: "do Google Gemini", placeholder: "AIza..." },
  { id: "deepseek", label: "DeepSeek", of: "da DeepSeek", placeholder: "sk-..." },
  { id: "xai", label: "Grok (xAI)", of: "do Grok (xAI)", placeholder: "xai-..." },
]

function formatDayMonth(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
}

export function SettingsPage() {
  const { user, signOut, refreshProfile } = useAuth()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()

  const [name, setName] = useState(user?.name || "")
  useEffect(() => {
    setName(user?.name || "")
  }, [user?.name])
  const [savingName, setSavingName] = useState(false)
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [savingPassword, setSavingPassword] = useState(false)
  /** Tema em gravação (desabilita só o botão clicado, não o grupo). */
  const [savingTheme, setSavingTheme] = useState<Theme | null>(null)

  const onSaveName = async (e: FormEvent) => {
    e.preventDefault()
    setSavingName(true)
    try {
      await updateProfileName(name)
      await refreshProfile()
      toast.success("Nome atualizado.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar nome.")
    } finally {
      setSavingName(false)
    }
  }

  const onTheme = async (next: Theme) => {
    if (next === theme) return
    // Reverte se a gravação falhar: senão a aparência (e o localStorage) fica
    // divergente do banco e o tema "volta sozinho" no próximo login.
    const prev = theme
    setTheme(next)
    setSavingTheme(next)
    try {
      await updateProfileTheme(next)
      await refreshProfile()
    } catch (err) {
      setTheme(prev)
      toast.error(
        err instanceof Error ? err.message : "Falha ao salvar preferência de tema.",
      )
    } finally {
      setSavingTheme(null)
    }
  }

  const onChangePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 6) {
      toast.error("A senha precisa ter pelo menos 6 caracteres.")
      return
    }
    if (password !== passwordConfirm) {
      toast.error("As senhas não coincidem.")
      return
    }
    setSavingPassword(true)
    try {
      await updatePassword(password)
      setPassword("")
      setPasswordConfirm("")
      toast.success("Senha alterada.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao alterar senha.")
    } finally {
      setSavingPassword(false)
    }
  }

  const handleSignOut = async () => {
    try {
      await signOut()
      toast.success("Sessão encerrada.")
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao sair.")
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-xl space-y-8 px-4 py-6 sm:px-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Voltar ao chat">
            <Link to="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Configurações</h1>
            <p className="text-sm text-muted-foreground">
              Conta, aparência, segurança e chaves de API.
            </p>
          </div>
        </div>

        <section className="space-y-4">
          <h2 className="text-sm font-medium text-foreground">Conta</h2>
          <div className="flex items-center gap-3">
            <Avatar size="lg" className="size-12">
              {user?.avatarUrl ? (
                <AvatarImage src={user.avatarUrl} alt={user.name || "Avatar"} />
              ) : null}
              <AvatarFallback className="text-base">
                {initials(user?.name, user?.email)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate font-medium">{user?.name || "Usuário"}</p>
              <p className="truncate text-sm text-muted-foreground">
                {user?.email || "—"}
              </p>
            </div>
          </div>

          <form className="space-y-3" onSubmit={(e) => void onSaveName(e)}>
            <div className="space-y-1.5">
              <label htmlFor="settings-name" className="text-sm font-medium">
                Nome
              </label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="settings-email" className="text-sm font-medium">
                E-mail
              </label>
              <Input
                id="settings-email"
                value={user?.email || ""}
                readOnly
                disabled
                className="opacity-70"
              />
            </div>
            <Button type="submit" disabled={savingName}>
              {savingName ? "Salvando..." : "Salvar nome"}
            </Button>
          </form>
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Aparência</h2>
          <p className="text-sm text-muted-foreground">
            Preferência salva na sua conta (vale em qualquer dispositivo).
          </p>
          <div role="group" aria-label="Tema da interface" className="flex flex-wrap gap-2">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                variant={theme === id ? "default" : "outline"}
                size="sm"
                className={cn("gap-1.5")}
                aria-pressed={theme === id}
                disabled={savingTheme === id}
                onClick={() => void onTheme(id)}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Segurança</h2>
          <form className="space-y-3" onSubmit={(e) => void onChangePassword(e)}>
            <div className="space-y-1.5">
              <label htmlFor="settings-password" className="text-sm font-medium">
                Nova senha
              </label>
              <Input
                id="settings-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="settings-password-confirm"
                className="text-sm font-medium"
              >
                Confirmar senha
              </label>
              <Input
                id="settings-password-confirm"
                type="password"
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                minLength={6}
                required
              />
            </div>
            <Button type="submit" disabled={savingPassword}>
              {savingPassword ? "Alterando..." : "Alterar senha"}
            </Button>
          </form>
        </section>

        <Separator />

        <MultiAgentSection />

        <Separator />

        <ApiKeysSection />

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Sessão</h2>
          <Button
            variant="destructive"
            className="gap-2"
            onClick={() => void handleSignOut()}
          >
            <LogOut className="size-4" />
            Sair
          </Button>
        </section>
      </div>
    </div>
  )
}

function formatDayMonth(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
}

function MultiAgentSection() {
  const { user, refreshProfile } = useAuth()
  const ma = user?.preferences?.multiAgent
  const enabled = ma?.enabled === true && !!ma.authorizedAt
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const apply = async (next: boolean) => {
    setBusy(true)
    try {
      if (next) {
        await updateProfilePreferences({
          multiAgent: {
            enabled: true,
            authorizedAt: new Date().toISOString(),
          },
        })
        toast.success("Multi-agentes habilitado nesta conta.")
      } else {
        await updateProfilePreferences({
          multiAgent: { enabled: false },
        })
        toast.success("Multi-agentes desligado.")
      }
      await refreshProfile()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao salvar preferência.",
      )
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Multi-agentes</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Quando habilitado, o Dexter pode delegar subtarefas independentes a
        sub-agentes (mesmas permissões da sua conta). Você vê cada delegação na
        timeline da resposta. Máximo de 3 sub-agentes por mensagem.
      </p>
      {enabled && ma?.authorizedAt && (
        <p className="text-xs text-muted-foreground">
          Autorizado em {formatDayMonth(ma.authorizedAt)}
        </p>
      )}
      {confirming ? (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="text-sm text-foreground">
            Autorizo o Dexter a spawnar sub-agentes com meu acesso para consultas
            paralelas. Cada sub-agente consome tokens adicionais.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void apply(true)}
            >
              {busy ? "Salvando…" : "Confirmar e habilitar"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={enabled ? "default" : "outline"}
          disabled={busy}
          onClick={() => {
            if (enabled) void apply(false)
            else setConfirming(true)
          }}
        >
          {busy
            ? "Salvando…"
            : enabled
              ? "Desabilitar multi-agentes"
              : "Habilitar multi-agentes"}
        </Button>
      )}
    </section>
  )
}

function ApiKeysSection() {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keys, setKeys] = useState<UserKey[]>([])
  /** Rascunho digitado por provedor (limpo após salvar). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Provedor com operação em andamento (salvar/remover). */
  const [busy, setBusy] = useState<UserKeyProvider | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchUserKeys(controller.signal)
      .then((res) => {
        setEnabled(res.enabled)
        setKeys(res.keys)
        setLoadError(null)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setLoadError(err instanceof Error ? err.message : "Falha ao carregar chaves.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const onSave = async (provider: UserKeyProvider) => {
    const value = (drafts[provider] ?? "").trim()
    if (value.length < 8) {
      toast.error("Cole a chave completa antes de salvar.")
      return
    }
    setBusy(provider)
    try {
      const saved = await saveUserKey(provider, value)
      setKeys((prev) => [...prev.filter((k) => k.provider !== provider), saved])
      setDrafts((prev) => ({ ...prev, [provider]: "" }))
      toast.success("Chave salva. Suas conversas passam a usar a sua chave.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar chave.")
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (provider: UserKeyProvider) => {
    setBusy(provider)
    try {
      await deleteUserKey(provider)
      setKeys((prev) => prev.filter((k) => k.provider !== provider))
      toast.success("Chave removida. Volta a valer a chave da empresa.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao remover chave.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Chaves de API pessoais</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Opcional: use suas próprias chaves nos modelos pagos. Quando cadastrada,
        a sua chave tem prioridade sobre a da empresa. Ela é guardada
        criptografada e nunca é exibida de volta — só os 4 últimos caracteres.
      </p>

      {loading ? (
        <div className="space-y-2">
          {KEY_PROVIDERS.map((p) => (
            <Skeleton key={p.id} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : loadError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : !enabled ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          A gestão de chaves está desabilitada no servidor. Fale com um
          administrador.
        </p>
      ) : (
        <div className="space-y-3">
          {KEY_PROVIDERS.map((p) => {
            const saved = keys.find((k) => k.provider === p.id)
            const draft = drafts[p.id] ?? ""
            const isBusy = busy === p.id
            return (
              <div key={p.id} className="space-y-1.5 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  {saved ? (
                    <span className="text-xs text-muted-foreground">
                      •••• {saved.last4} · atualizada em {formatDayMonth(saved.updated_at)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      usando a chave da empresa
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      saved ? `Substituir chave ${p.of}...` : p.placeholder
                    }
                    value={draft}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                    disabled={isBusy}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={isBusy || draft.trim().length === 0}
                    onClick={() => void onSave(p.id)}
                  >
                    {isBusy ? "..." : "Salvar"}
                  </Button>
                  {saved ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label={`Remover chave ${p.of}`}
                      disabled={isBusy}
                      onClick={() => void onDelete(p.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
