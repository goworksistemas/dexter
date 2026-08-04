import { Navigate, Outlet, useLocation } from "react-router-dom"

import { emailDomainErrorMessage, isAllowedEmail } from "@/lib/auth/email-domain"
import { useAuth } from "@/providers/auth-provider"

/** Exige sessão Supabase. Sem auth configurado, bloqueia com tela de setup. */
export function ProtectedRoute() {
  const { isAuthenticated, isLoading, isConfigured, user, signOut } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Carregando sessão...
      </div>
    )
  }

  if (!isConfigured) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background px-6 text-center">
        <p className="text-base font-medium text-foreground">
          Supabase não configurado
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          Defina <code className="text-foreground">VITE_SUPABASE_URL</code> e{" "}
          <code className="text-foreground">VITE_SUPABASE_ANON_KEY</code> no
          ambiente do front (projeto agentcore) e reinicie o Vite.
        </p>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (!isAllowedEmail(user?.email)) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-base font-medium text-foreground">
          Domínio não autorizado
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {emailDomainErrorMessage()}
        </p>
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => void signOut()}
        >
          Sair
        </button>
      </div>
    )
  }

  if (user?.disabledAt) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-base font-medium text-foreground">
          Conta desativada
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          Seu acesso ao Dexter foi revogado. Fale com um administrador
          (bpm@gowork.com.br).
        </p>
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => void signOut()}
        >
          Sair
        </button>
      </div>
    )
  }

  return <Outlet />
}

/** Rotas públicas: se já autenticado, manda para o app. */
export function GuestRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()
  const from =
    (location.state as { from?: string } | null)?.from &&
    (location.state as { from: string }).from !== "/login"
      ? (location.state as { from: string }).from
      : "/"

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Carregando...
      </div>
    )
  }

  if (isAuthenticated) {
    return <Navigate to={from} replace />
  }

  return <Outlet />
}
