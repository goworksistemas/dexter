/**
 * Datas relativas na UI (listas de chats/artefatos) — pt-BR.
 *
 *   formatRelative(agora)              → "Agora"
 *   formatRelative(há 5 min)           → "há 5 min"
 *   formatRelative(há algumas horas)   → "há 3 h"
 *   formatRelative(ontem / este ano)   → "13 de jul."
 *   formatRelative(ano anterior)       → "13 de jul. de 2025"
 */

const MONTHS_SHORT = [
  "jan.",
  "fev.",
  "mar.",
  "abr.",
  "mai.",
  "jun.",
  "jul.",
  "ago.",
  "set.",
  "out.",
  "nov.",
  "dez.",
] as const

function parseDate(iso: string): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatCalendar(date: Date, now: Date): string {
  const day = date.getDate()
  const month = MONTHS_SHORT[date.getMonth()]
  if (date.getFullYear() === now.getFullYear()) {
    return `${day} de ${month}`
  }
  return `${day} de ${month} de ${date.getFullYear()}`
}

/** Tempo relativo curto em pt-BR a partir de um ISO string. */
export function formatRelative(iso: string): string {
  const date = parseDate(iso)
  if (!date) return "—"

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const future = diffMs < 0
  const absMs = Math.abs(diffMs)
  const absSec = Math.floor(absMs / 1000)
  const absMin = Math.floor(absSec / 60)
  const absHour = Math.floor(absMin / 60)
  const absDay = Math.floor(absHour / 24)

  if (absSec < 45) return "Agora"
  if (absMin < 60) {
    return future ? `em ${absMin} min` : `há ${absMin} min`
  }
  if (absHour < 24) {
    return future ? `em ${absHour} h` : `há ${absHour} h`
  }
  if (absDay < 2) {
    return future ? "amanhã" : "ontem"
  }
  if (absDay < 7) {
    return future ? `em ${absDay} dias` : `há ${absDay} dias`
  }

  return formatCalendar(date, now)
}
