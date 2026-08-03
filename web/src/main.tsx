import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/providers/theme-provider"
import { AuthProvider } from "@/providers/auth-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { ArtifactsProvider } from "@/lib/artifacts"
import { ChatRunsProvider, ChatsProvider, useChats } from "@/lib/chats"
import { ModelsProvider } from "@/lib/models"
import { ProjectsProvider } from "@/lib/projects"
import { useCallback, type ReactNode } from "react"

/** Liga o settle das gerações ao refresh da sidebar. */
function ChatRunsBridge({ children }: { children: ReactNode }) {
  const { refreshChats } = useChats()
  const onRunSettled = useCallback(() => {
    refreshChats()
  }, [refreshChats])
  return (
    <ChatRunsProvider onRunSettled={onRunSettled}>{children}</ChatRunsProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <TooltipProvider>
          <AuthProvider>
            <ModelsProvider>
              <ProjectsProvider>
                <ChatsProvider>
                  <ChatRunsBridge>
                    <ArtifactsProvider>
                      <App />
                    </ArtifactsProvider>
                  </ChatRunsBridge>
                </ChatsProvider>
              </ProjectsProvider>
            </ModelsProvider>
            <Toaster />
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)
