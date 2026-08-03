import * as React from "react"

import { SidebarProvider } from "@/hooks/use-sidebar"
import { Sidebar } from "@/components/layout/sidebar"
import { Header } from "@/components/layout/header"

/**
 * Shell raiz do Dexter: sidebar à esquerda + header no topo + área principal.
 * A sidebar vira off-canvas no mobile (controlada por SidebarProvider).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <div className="app-shell flex h-dvh overflow-hidden">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Header />
          {/* Scroll só na lista (sidebar) e na conversa (Thread) — nunca na página. */}
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  )
}
