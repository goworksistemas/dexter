import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { ChatThread } from "@/components/chat"
import { GuestRoute, ProtectedRoute } from "@/components/auth/protected-route"
import { AuthCallbackPage } from "@/pages/auth/callback"
import { ForgotPasswordPage } from "@/pages/auth/forgot-password"
import { LoginPage } from "@/pages/auth/login"
import { SignupPage } from "@/pages/auth/signup"
import { UpdatePasswordPage } from "@/pages/auth/update-password"
import { ArtifactsPage } from "@/pages/artifacts"
import { ChatsPage } from "@/pages/chats"
import { ProjectsPage } from "@/pages/projects"
import { ProjectDetailPage } from "@/pages/projects/project-detail"
import { SettingsPage } from "@/pages/settings"

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
  const { pathname } = useLocation()

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
        <Route element={<AuthenticatedShell />}>
          <Route index element={null} />
          <Route path="c/:chatId" element={null} />
          <Route path="p/:projectId" element={null} />
          <Route path="p/:projectId/c/:chatId" element={null} />
          <Route path="chats" element={<ChatsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
