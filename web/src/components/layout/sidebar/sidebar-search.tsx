import * as React from "react"
import { Search, X } from "lucide-react"

import { Input } from "@/components/ui/input"

/** Campo de busca das conversas — aberto pelo ícone de lupa no topo. */
export function SidebarSearch({
  inputRef,
  query,
  onQueryChange,
  onClose,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (value: string) => void
  onClose: () => void
}) {
  return (
    <div className="shrink-0 px-2 pt-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-sidebar-foreground/45"
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose()
          }}
          placeholder="Buscar conversas"
          aria-label="Buscar conversas"
          className="h-8 rounded-lg border-sidebar-border/70 bg-sidebar pr-8 pl-8 text-[13px] placeholder:text-sidebar-foreground/60"
        />
        <button
          type="button"
          aria-label="Fechar busca"
          onClick={onClose}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/45 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
