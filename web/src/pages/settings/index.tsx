import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowLeft, LogOut, Monitor, Moon, Sun } from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  updatePassword,
  updateProfileName,
  updateProfileTheme,
} from "@/lib/supabase"
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
  const [savingTheme, setSavingTheme] = useState(false)

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
    setTheme(next)
    setSavingTheme(true)
    try {
      await updateProfileTheme(next)
      await refreshProfile()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao salvar preferência de tema.",
      )
    } finally {
      setSavingTheme(false)
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
              Conta, aparência e segurança.
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
          <div className="flex flex-wrap gap-2">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                variant={theme === id ? "default" : "outline"}
                size="sm"
                className={cn("gap-1.5")}
                disabled={savingTheme}
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
