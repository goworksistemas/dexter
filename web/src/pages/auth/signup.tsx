import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AuthLayout } from "@/components/auth/auth-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ensureProfileFromUser,
  hasSupabase,
  signUpWithPassword,
} from "@/lib/supabase"

export function SignupPage() {
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!hasSupabase()) {
      toast.error("Supabase não configurado neste build.")
      return
    }
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
      const data = await signUpWithPassword({ email, password, name })
      if (data.user) {
        await ensureProfileFromUser(data.user)
      }
      if (data.session) {
        toast.success("Conta criada. Bem-vindo ao Dexter.")
        navigate("/", { replace: true })
        return
      }
      toast.success(
        "Conta criada. Verifique seu e-mail para confirmar o cadastro.",
      )
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no cadastro.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Criar conta"
      description="Cadastre-se para usar o Dexter com sua identidade Supabase."
      footer={
        <>
          Já tem conta?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Entrar
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <label htmlFor="signup-name" className="text-sm font-medium">
            Nome
          </label>
          <Input
            id="signup-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Seu nome"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="signup-email" className="text-sm font-medium">
            E-mail
          </label>
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@gowork.com.br"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="signup-password" className="text-sm font-medium">
            Senha
          </label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="signup-confirm" className="text-sm font-medium">
            Confirmar senha
          </label>
          <Input
            id="signup-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={6}
            required
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Criando..." : "Criar conta"}
        </Button>
      </form>
    </AuthLayout>
  )
}
