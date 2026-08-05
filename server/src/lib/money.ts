/** USD com 2 casas decimais (padrão financeiro; half away from zero). */
export function roundCostUsd(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(Math.abs(value) * 100) / 100
  if (rounded === 0) return 0
  return value < 0 ? -rounded : rounded
}
