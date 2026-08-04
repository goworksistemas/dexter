import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AuthLayout } from "@/components/auth/auth-layout"
import { Button } from "@/components/ui/button"
import {
  exchangeCodeForSession,
  hasSupabase,
  verifyEmailOtp,
} from "@/lib/supabase"

/**
 * Troca o `?code=` do fluxo PKCE (confirmação de e-mail / magic link)
 * por sessão e redireciona ao app.
 * @see https://supabase.com/docs/guides/auth/passwords
 */
export function AuthCallbackPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    let active = true

    const run = async () => {
      if (!hasSupabase()) {
        if (active) setError("Supabase não configurado neste build.")
        return
      }

      // O Supabase devolve sucesso no query string, mas falhas de verificação
      // (link expirado, access_denied) vêm no fragmento — ler os dois.
      const params = new URLSearchParams(window.location.search)
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""))
      const param = (key: string) => params.get(key) ?? hash.get(key)

      const code = param("code")
      const tokenHash = param("token_hash")
      const errCode = param("error_code")
      const errDesc = param("error_description") || param("error") || null

      if (errCode === "otp_expired") {
        if (active) setExpired(true)
        return
      }

      if (errDesc) {
        if (active) setError(errDesc)
        return
      }

      // Cross-login (NetworkGo) e magic links: token_hash consumido aqui via
      // verifyOtp — o flowType pkce do client rejeita tokens no hash da URL.
      if (tokenHash) {
        try {
          await verifyEmailOtp(tokenHash)
          navigate("/", { replace: true })
        } catch (err) {
          if (active) {
            setError(
              err instanceof Error
                ? err.message
                : "Não foi possível confirmar a sessão.",
            )
          }
        }
        return
      }

      if (!code) {
        // detectSessionInUrl pode já ter processado hash/query; tenta o app.
        navigate("/", { replace: true })
        return
      }

      try {
        await exchangeCodeForSession(code)
        toast.success("Conta confirmada.")
        navigate("/", { replace: true })
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "Não foi possível confirmar a sessão.",
          )
        }
      }
    }

    void run()
    return () => {
      active = false
    }
  }, [navigate])

  if (expired) {
    return (
      <AuthLayout
        title="Este link expirou"
        description="Links de confirmação e de recuperação são válidos por tempo limitado e só podem ser usados uma vez. Peça um novo e-mail para continuar."
        footer={
          <Link to="/login" className="font-medium text-primary hover:underline">
            Ir para o login
          </Link>
        }
      >
        <div className="space-y-2">
          <Button asChild className="w-full">
            <Link to="/forgot-password">Reenviar e-mail de recuperação</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to="/signup">Criar conta novamente</Link>
          </Button>
        </div>
      </AuthLayout>
    )
  }

  if (error) {
    return (
      <AuthLayout
        title="Falha na confirmação"
        description={error}
        footer={
          <Link to="/login" className="font-medium text-primary hover:underline">
            Ir para o login
          </Link>
        }
      >
        <Button asChild className="w-full">
          <Link to="/login">Tentar de novo</Link>
        </Button>
      </AuthLayout>
    )
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
      Confirmando autenticação...
    </div>
  )
}
