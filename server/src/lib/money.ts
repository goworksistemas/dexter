/** USD com 2 casas decimais (padrão financeiro). */
export function roundCostUsd(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}
