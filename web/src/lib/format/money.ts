/** USD com 2 casas decimais (padrão financeiro). */
export function roundCostUsd(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

export function fmtUsd(n: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n ?? 0))
}

/** Mensagens baratas (< $0.01) mostram até 4 casas para não virar $0.00. */
export function fmtUsdCost(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v === 0) return "$0.00"
  if (Math.abs(v) >= 0.01) return fmtUsd(v)
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(v)
}
