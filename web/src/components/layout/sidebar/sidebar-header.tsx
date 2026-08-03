import { PanelLeft, Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DexterMark, SidebarTip } from "./shared"

/**
 * Topo da sidebar: marca + os dois únicos controles do topo (recolher e
 * buscar). O toggle de colapso existe só aqui (e no rail) — o header do app
 * não repete esse botão.
 */
export function SidebarHeader({
  searchOpen,
  onCollapse,
  onToggleSearch,
  onCloseMobile,
}: {
  searchOpen: boolean
  onCollapse: () => void
  onToggleSearch: () => void
  onCloseMobile: () => void
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-3">
      <DexterMark className="size-7 rounded-lg" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-sidebar-foreground">
        Dexter
      </span>

      <SidebarTip label="Recolher menu" side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden size-7 shrink-0 text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground md:inline-flex"
          aria-label="Recolher menu"
          onClick={onCollapse}
        >
          <PanelLeft className="size-4" />
        </Button>
      </SidebarTip>

      <SidebarTip label="Buscar" side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "size-7 shrink-0 text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            searchOpen && "bg-sidebar-accent text-sidebar-foreground",
          )}
          aria-label="Buscar conversas"
          aria-pressed={searchOpen}
          onClick={onToggleSearch}
        >
          <Search className="size-4" />
        </Button>
      </SidebarTip>

      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7 shrink-0 text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden"
        aria-label="Fechar menu"
        onClick={onCloseMobile}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
