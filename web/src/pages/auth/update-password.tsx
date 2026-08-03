import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AuthLayout } from "@/components/auth/auth-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  exchangeCodeForSession,
  hasSupabase,
  onAuthStateChange,
  updatePassword,
} from "@/lib/supabase"
import { useAuth } from "@/providers/auth-provider"

/**
 * Página de nova senha após o link de recovery do Supabase.
 * Com PKCE, o redirect chega com `?code=` — trocamos por sessão aqui.
 */
export function UpdatePasswordPage() {
  const navigate = useNavigate()
  const { isAuthenticated, isLoading } = useAuth()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      if (!hasSupabase()) {
        if (active) {
          setBootstrapping(false)
          setReady(false)
        }
        return
      }

      const params = new URLSearchParams(window.location.search)
      const code = params.get("code")
      if (code) {
        try {
          await exchangeCodeForSession(code)
          window.history.replaceState({}, "", "/update-password")
        } catch (err) {
          if (active) {
            toast.error(
              err instanceof Error
                ? err.message
                : "Link de recuperação inválido ou expirado.",
            )
          }
        }
      }

      if (active) {
        setBootstrapping(false)
      }
    }

    void bootstrap()

    const unsub = onAuthStateChange((event, session) => {
      if (!active) return
      if (event === "PASSWORD_RECOVERY" || session) {
        setReady(true)
      }
    })

    return () => {
      active = false
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!bootstrapping && (isAuthenticated || ready)) {
      setReady(true)
    }
  }, [bootstrapping, isAuthenticated, ready])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 6) {
      toast.error("A senha precisa ter pelo menos 6 caracteres.")
      return
    }
    if (password !== confirm) {
      toast.error("As senhas não coincidem.")
      return
    }

    setSubmitting(true)
    try {
      await updatePassword(password)
      toast.success("Senha atualizada.")
      navigate("/", { replace: true })
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Não foi possível atualizar a senha.",
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (isLoading || bootstrapping) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Validando link de recuperação...
      </div>
    )
  }

  if (!ready) {
    return (
      <AuthLayout
        title="Link inválido"
        description="Peça um novo e-mail de recuperação para continuar."
        footer={
          <Link
            to="/forgot-password"
            className="font-medium text-primary hover:underline"
          >
            Solicitar novo link
          </Link>
        }
      >
        <Button asChild className="w-full">
          <Link to="/login">Voltar ao login</Link>
        </Button>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Nova senha"
      description="Defina uma senha forte para a sua conta."
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <label htmlFor="new-password" className="text-sm font-medium">
            Nova senha
          </label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="confirm-password" className="text-sm font-medium">
            Confirmar senha
          </label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={6}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Salvando..." : "Salvar senha"}
        </Button>
      </form>
    </AuthLayout>
  )
}
