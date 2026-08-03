import { Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { ChatThread } from "@/components/chat"
import {
  GuestRoute,
  ProtectedRoute,
} from "@/components/auth/protected-route"
import { AuthCallbackPage } from "@/pages/auth/callback"
import { ForgotPasswordPage } from "@/pages/auth/forgot-password"
import { LoginPage } from "@/pages/auth/login"
import { SignupPage } from "@/pages/auth/signup"
import { UpdatePasswordPage } from "@/pages/auth/update-password"
import { SettingsPage } from "@/pages/settings"

/**
 * Rotas do Dexter:
 * - públicas: login, signup, forgot/update password, callback PKCE
 * - protegidas: shell + chat (/ e /c/:chatId) + settings
 */
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
        <Route
          path="/"
          element={
            <AppShell>
              <ChatThread />
            </AppShell>
          }
        />
        <Route
          path="/c/:chatId"
          element={
            <AppShell>
              <ChatThread />
            </AppShell>
          }
        />
        <Route
          path="/settings"
          element={
            <AppShell>
              <SettingsPage />
            </AppShell>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
