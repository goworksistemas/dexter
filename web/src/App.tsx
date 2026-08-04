import * as React from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AppShell } from "@/components/layout/app-shell"
import { ChatThread } from "@/components/chat"
import { GuestRoute, ProtectedRoute } from "@/components/auth/protected-route"
import { AuthCallbackPage } from "@/pages/auth/callback"
import { ForgotPasswordPage } from "@/pages/auth/forgot-password"
import { LoginPage } from "@/pages/auth/login"
import { SignupPage } from "@/pages/auth/signup"
import { UpdatePasswordPage } from "@/pages/auth/update-password"
import { AdminPage } from "@/pages/admin"
import { ArtifactsPage } from "@/pages/artifacts"
import { ArtifactViewerPage } from "@/pages/artifacts/artifact-viewer"
import { ChatsPage } from "@/pages/chats"
import { ProjectsPage } from "@/pages/projects"
import { ProjectDetailPage } from "@/pages/projects/project-detail"
import { SettingsPage } from "@/pages/settings"
import { CONNECTOR_OAUTH_MSG } from "@/lib/connectors/oauth-popup"
import type { ConnectorId } from "@/lib/connectors/api"

/** Rotas em que o ChatThread fica montado (não remonta entre elas). */
function isChatRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname.startsWith("/c/") ||
    /^\/p\/[^/]+(\/c\/[^/]+)?$/.test(pathname)
  )
}

/**
 * Shell autenticado: ChatThread permanece montado em todas as rotas de
 * conversa (não remonta ao trocar `/` ↔ `/c/:id`). Nas páginas internas
 * troca o conteúdo; a geração em background segue no ChatRunsStore.
 */
function AuthenticatedShell() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()

  React.useEffect(() => {
    const params = new URLSearchParams(search)
    // Novo: ?connector=notion&status=connected — legado: ?connectors=&provider=
    const status =
      params.get("status") ?? params.get("connectors")
    const providerRaw =
      params.get("connector") ?? params.get("provider")
    if (!status || (status !== "connected" && status !== "error")) return

    const provider =
      providerRaw === "notion" || providerRaw === "outlook"
        ? (providerRaw as ConnectorId)
        : null
    const label =
      provider === "notion"
        ? "Notion"
        : provider === "outlook"
          ? "Outlook"
          : "Conector"

    if (window.opener && provider) {
      try {
        window.opener.postMessage(
          {
            type: CONNECTOR_OAUTH_MSG,
            provider,
            status: status === "connected" ? "connected" : "error",
          },
          window.location.origin,
        )
      } catch {
        /* ignore */
      }
      window.close()
      return
    }

    if (status === "connected") {
      toast.success(`${label} conectado`)
    } else {
      toast.error(`Falha ao conectar ${label}.`)
    }
    params.delete("connector")
    params.delete("status")
    params.delete("connectors")
    params.delete("provider")
    params.delete("reason")
    const next = params.toString()
    navigate(
      { pathname, search: next ? `?${next}` : "" },
      { replace: true },
    )
  }, [navigate, pathname, search])

  return (
    <AppShell>{isChatRoute(pathname) ? <ChatThread /> : <Outlet />}</AppShell>
  )
}

function App() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Route>

      <Route path="/update-password" element={<UpdatePasswordPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      <Route element={<ProtectedRoute />}>
        {/* Aba dedicada fullscreen — fora do AppShell (sem sidebar). */}
        <Route path="artifacts/:artifactId" element={<ArtifactViewerPage />} />

        <Route element={<AuthenticatedShell />}>
          <Route index element={null} />
          <Route path="c/:chatId" element={null} />
          <Route path="p/:projectId" element={null} />
          <Route path="p/:projectId/c/:chatId" element={null} />
          <Route path="chats" element={<ChatsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
