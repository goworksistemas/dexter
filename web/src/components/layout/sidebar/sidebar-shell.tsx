import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Chrome de layout da sidebar — sem estado de dados, só o modelo de caixa.
 *
 * Desktop: <aside> estático, item de largura fixa do flex row do shell
 * (w-16 recolhida / w-72 expandida). A animação acontece na largura da
 * <aside>; o conteúdo vive num wrapper de largura fixa que só é clipado,
 * então nada refluxa durante a transição.
 *
 * Mobile: <aside> fixed + overlay (drawer), sem largura no fluxo.
 */
export function SidebarShell({
  isDesktop,
  collapsed,
  open,
  onOverlayClick,
  children,
}: {
  isDesktop: boolean
  collapsed: boolean
  open: boolean
  onOverlayClick: () => void
  children: React.ReactNode
}) {
  const railMode = isDesktop && collapsed

  return (
    <>
      {!isDesktop && open ? (
        <div
          className="fixed inset-0 z-40 bg-foreground/25"
          onClick={onOverlayClick}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={cn(
          "flex flex-col overflow-hidden border-r border-sidebar-border/70 bg-sidebar text-sidebar-foreground",
          isDesktop
            ? cn(
                "relative h-full shrink-0 transition-[width] duration-200 ease-out",
                collapsed ? "w-16" : "w-72",
              )
            : cn(
                "fixed inset-y-0 left-0 z-50 h-dvh w-72 transition-transform duration-200 ease-out",
                open ? "translate-x-0" : "-translate-x-full",
              ),
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            railMode ? "w-16" : "w-72",
          )}
        >
          {children}
        </div>
      </aside>
    </>
  )
}
