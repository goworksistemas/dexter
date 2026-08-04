import * as React from "react"

import {
  ArtifactPanel,
  ARTIFACT_SPLIT_QUERY,
} from "@/components/artifacts/artifact-panel"
import { Header } from "@/components/layout/header"
import { Sidebar } from "@/components/layout/sidebar"
import { SidebarProvider, useSidebar } from "@/hooks/use-sidebar"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useArtifactsOptional } from "@/lib/artifacts"
import { cn } from "@/lib/utils"

function ShellBody({ children }: { children: React.ReactNode }) {
  const artifacts = useArtifactsOptional()
  const isSplit = useMediaQuery(ARTIFACT_SPLIT_QUERY)
  const panelOpen = Boolean(artifacts?.isPanelOpen && artifacts.active)
  const { open: drawerOpen } = useSidebar()
  const isDesktop = useMediaQuery("(min-width: 48rem)")
  /** Drawer aberto sobre o conteúdo: o miolo não recebe foco nem clique. */
  const conteudoInerte = !isDesktop && drawerOpen

  return (
    <div className="app-shell flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main
            inert={conteudoInerte}
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden transition-[flex-basis] duration-200",
              panelOpen && isSplit && "min-w-0",
            )}
          >
            {children}
          </main>
          {panelOpen && isSplit ? <ArtifactPanel /> : null}
        </div>
        {panelOpen && !isSplit ? <ArtifactPanel /> : null}
      </div>
    </div>
  )
}

/**
 * Shell raiz do Dexter: sidebar + header + área principal (+ painel de artefato).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <ShellBody>{children}</ShellBody>
    </SidebarProvider>
  )
}
