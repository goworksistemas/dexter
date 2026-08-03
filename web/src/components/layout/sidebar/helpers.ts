/** Iniciais do usuário para o fallback do avatar. */
export function initials(name?: string, email?: string | null): string {
  const source = (name || email || "?").trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

/** Alvo de toque de 40x40 usado por todos os ícones do rail. */
export const railItemClass =
  "relative flex size-10 shrink-0 items-center justify-center rounded-xl text-sidebar-foreground/65 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"

export const railItemActiveClass =
  "bg-sidebar-accent text-sidebar-accent-foreground"

/**
 * Linha da sidebar expandida — 32px de altura, ícone de 16px e rótulo de 13px.
 * Densidade alta: hierarquia por peso e cor, não por caixas.
 */
export const sidebarRowClass =
  "flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-sidebar-foreground/85 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"

export const sidebarRowActiveClass =
  "bg-sidebar-accent font-medium text-sidebar-accent-foreground"

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

/** Rótulo do atalho de nova conversa conforme a plataforma. */
export const newChatShortcut = isMac ? "⌘O" : "Ctrl+O"

/** Verdadeiro para o atalho de nova conversa (Ctrl/⌘ + O). */
export function isNewChatShortcut(event: KeyboardEvent): boolean {
  if (!(isMac ? event.metaKey : event.ctrlKey)) return false
  if (event.altKey || event.shiftKey) return false
  return event.key.toLowerCase() === "o"
}
