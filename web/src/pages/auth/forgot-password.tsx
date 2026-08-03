import { useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { AuthLayout } from "@/components/auth/auth-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { hasSupabase, resetPasswordForEmail } from "@/lib/supabase"

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!hasSupabase()) {
      toast.error("Supabase não configurado neste build.")
      return
    }
    if (!email.trim()) {
      toast.error("Informe seu e-mail.")
      return
    }

    setSubmitting(true)
    try {
      await resetPasswordForEmail(email)
      setSent(true)
      toast.success("Se o e-mail existir, enviamos o link de recuperação.")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao enviar recuperação.",
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Recuperar senha"
      description="Enviaremos um link para redefinir sua senha."
      footer={
        <Link to="/login" className="font-medium text-primary hover:underline">
          Voltar ao login
        </Link>
      }
    >
      {sent ? (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Verifique a caixa de entrada de <strong>{email}</strong> e abra o
            link para definir uma nova senha.
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Ir para o login</Link>
          </Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <label htmlFor="forgot-email" className="text-sm font-medium">
              E-mail
            </label>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@gowork.com.br"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Enviando..." : "Enviar link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
