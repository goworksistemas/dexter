import * as React from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { AppShell } from "@/components/layout/app-shell"
import { ChatThread } from "@/components/chat"
import { GuestRoute, ProtectedRoute } from "@/components/auth/protected-route"
import { CONNECTOR_OAUTH_MSG } from "@/lib/connectors/oauth-popup"
import type { ConnectorId } from "@/lib/connectors/api"

/**
 * Rota primária (AppShell + ChatThread) fica no bundle principal; todas as
 * outras páginas entram por chunk sob demanda. Os módulos exportam
 * componentes nomeados, daí o `.then` remapeando para `default`.
 */
const LoginPage = React.lazy(() =>
  import("@/pages/auth/login").then((m) => ({ default: m.LoginPage })),
)
const SignupPage = React.lazy(() =>
  import("@/pages/auth/signup").then((m) => ({ default: m.SignupPage })),
)
const ForgotPasswordPage = React.lazy(() =>
  import("@/pages/auth/forgot-password").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
)
const UpdatePasswordPage = React.lazy(() =>
  import("@/pages/auth/update-password").then((m) => ({
    default: m.UpdatePasswordPage,
  })),
)
const AuthCallbackPage = React.lazy(() =>
  import("@/pages/auth/callback").then((m) => ({
    default: m.AuthCallbackPage,
  })),
)
const AdminPage = React.lazy(() =>
  import("@/pages/admin").then((m) => ({ default: m.AdminPage })),
)
const AdminKeysPage = React.lazy(() =>
  import("@/pages/admin/keys").then((m) => ({ default: m.AdminKeysPage })),
)
const SettingsPage = React.lazy(() =>
  import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
)
const ProjectsPage = React.lazy(() =>
  import("@/pages/projects").then((m) => ({ default: m.ProjectsPage })),
)
const ProjectDetailPage = React.lazy(() =>
  import("@/pages/projects/project-detail").then((m) => ({
    default: m.ProjectDetailPage,
  })),
)
const ChatsPage = React.lazy(() =>
  import("@/pages/chats").then((m) => ({ default: m.ChatsPage })),
)
const WorkflowsPage = React.lazy(() =>
  import("@/pages/workflows").then((m) => ({ default: m.WorkflowsPage })),
)
const ArtifactsPage = React.lazy(() =>
  import("@/pages/artifacts").then((m) => ({ default: m.ArtifactsPage })),
)
const ArtifactViewerPage = React.lazy(() =>
  import("@/pages/artifacts/artifact-viewer").then((m) => ({
    default: m.ArtifactViewerPage,
  })),
)
const ShareChatPage = React.lazy(() =>
  import("@/pages/public/share-chat").then((m) => ({ default: m.ShareChatPage })),
)
const ShareArtifactPage = React.lazy(() =>
  import("@/pages/public/share-artifact").then((m) => ({
    default: m.ShareArtifactPage,
  })),
)

/** Fallback de tela cheia (páginas fora do AppShell). */
function FullPageFallback() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
      Carregando...
    </div>
  )
}

/** Fallback dentro do AppShell: só o miolo troca, sidebar/header ficam. */
function ShellContentFallback() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      Carregando...
    </div>
  )
}

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
    <AppShell>
      {isChatRoute(pathname) ? (
        <ChatThread />
      ) : (
        <React.Suspense fallback={<ShellContentFallback />}>
          <Outlet />
        </React.Suspense>
      )}
    </AppShell>
  )
}

function App() {
  return (
    <React.Suspense fallback={<FullPageFallback />}>
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Route>

        <Route path="/update-password" element={<UpdatePasswordPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        <Route path="/s/c/:token" element={<ShareChatPage />} />
        <Route path="/s/a/:token" element={<ShareArtifactPage />} />

        <Route element={<ProtectedRoute />}>
          {/* Aba dedicada fullscreen — fora do AppShell (sem sidebar). */}
          <Route
            path="artifacts/:artifactId"
            element={<ArtifactViewerPage />}
          />

          <Route element={<AuthenticatedShell />}>
            <Route index element={null} />
            <Route path="c/:chatId" element={null} />
            <Route path="p/:projectId" element={null} />
            <Route path="p/:projectId/c/:chatId" element={null} />
            <Route path="chats" element={<ChatsPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectDetailPage />} />
            <Route path="workflows" element={<WorkflowsPage />} />
            <Route path="artifacts" element={<ArtifactsPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="admin/chaves" element={<AdminKeysPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </React.Suspense>
  )
}

export default App
