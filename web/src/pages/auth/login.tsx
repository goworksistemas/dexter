import { useState, type FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AuthLayout } from "@/components/auth/auth-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { allowedDomainsLabel } from "@/lib/auth/email-domain"
import { hasSupabase, signInWithPassword } from "@/lib/supabase"

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const from =
    (location.state as { from?: string } | null)?.from &&
    (location.state as { from: string }).from !== "/login"
      ? (location.state as { from: string }).from
      : "/"

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!hasSupabase()) {
      toast.error("Supabase não configurado neste build.")
      return
    }
    if (!email.trim() || !password) {
      toast.error("Informe e-mail e senha.")
      return
    }

    setSubmitting(true)
    try {
      await signInWithPassword(email, password)
      toast.success("Login realizado.")
      navigate(from, { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no login.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Entrar"
      description="Acesse o Dexter com sua conta GoWork."
      footer={
        <>
          Não tem conta?{" "}
          <Link to="/signup" className="font-medium text-primary hover:underline">
            Criar conta
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <label htmlFor="login-email" className="text-sm font-medium">
            E-mail
          </label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@gowork.com.br"
            required
          />
          <p className="text-xs text-muted-foreground">
            Acesso exclusivo a e-mails {allowedDomainsLabel()}.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="login-password" className="text-sm font-medium">
              Senha
            </label>
            <Link
              to="/forgot-password"
              className="text-xs font-medium text-primary hover:underline"
            >
              Esqueci a senha
            </Link>
          </div>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Entrando..." : "Entrar"}
        </Button>
      </form>
    </AuthLayout>
  )
}
