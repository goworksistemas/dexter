/**
 * Formatação de data/hora da interface — padrão brasileiro numérico.
 * Todo lugar que mostra data usa daqui; nada de `toLocaleDateString` solto.
 *
 *   formatDate("2026-08-03T22:10:00Z")     → "03/08/2026"
 *   formatDateTime("2026-08-03T22:10:00Z") → "03/08/2026 19:10"
 */

export type DateInput = string | number | Date | null | undefined

/** Exibido quando a data é nula ou inválida (nunca "Invalid Date"). */
export const DATA_VAZIA = "—"

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
})

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

function paraData(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "dd/mm/aaaa". */
export function formatDate(value: DateInput): string {
  const date = paraData(value)
  return date ? dateFormatter.format(date) : DATA_VAZIA
}

/** "dd/mm/aaaa HH:mm" (24h). */
export function formatDateTime(value: DateInput): string {
  const date = paraData(value)
  if (!date) return DATA_VAZIA
  return `${dateFormatter.format(date)} ${timeFormatter.format(date)}`
}
