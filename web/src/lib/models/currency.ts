/**
 * Custos em reais na interface.
 *
 * O AgentCore grava tudo em USD (moeda dos providers, auditável contra a
 * fatura) e manda a cotação do dia no envelope de `GET /api/models`. Aqui só
 * convertemos e formatamos: BRL é a moeda principal em toda a UI; o USD
 * aparece entre parênteses no painel admin, para conferência.
 */

/**
 * Espelha `FALLBACK_USD_BRL` do server (`services/exchange-rate.ts`): vale
 * enquanto o catálogo não chegou ou quando a API de câmbio está fora. Não é
 * cotação real — é ordem de grandeza para o valor em tela seguir plausível.
 */
export const FALLBACK_USD_BRL = 5.5

/** Cotação válida (a API pode ter voltado lixo / o boot ainda não terminou). */
export function normalizeRate(rate: number | null | undefined): number {
  const n = Number(rate)
  if (!Number.isFinite(n) || n <= 0) return FALLBACK_USD_BRL
  return n
}

export function usdToBrl(
  usd: number | null | undefined,
  rate: number | null | undefined,
): number {
  const v = Number(usd)
  if (!Number.isFinite(v)) return 0
  return v * normalizeRate(rate)
}

function brlFormatter(min: number, max: number): Intl.NumberFormat {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  })
}

/** Só formata um valor que já está em reais (precisão fixa de 2 casas). */
export function formatBRLValue(brl: number | null | undefined): string {
  return brlFormatter(2, 2).format(Number(brl ?? 0))
}

/**
 * Converte USD→BRL e formata com precisão adaptativa: abaixo de R$ 0,01
 * mostra até 4 casas, senão uma mensagem barata viraria sempre "R$ 0,00".
 */
export function formatBRL(
  usd: number | null | undefined,
  rate: number | null | undefined,
): string {
  const brl = usdToBrl(usd, rate)
  if (brl === 0) return formatBRLValue(0)
  if (Math.abs(brl) >= 0.01) return formatBRLValue(brl)
  return brlFormatter(2, 4).format(brl)
}

/** Total consolidado (KPI, tabela do admin): sempre 2 casas. */
export function formatBRLTotal(
  usd: number | null | undefined,
  rate: number | null | undefined,
): string {
  return formatBRLValue(usdToBrl(usd, rate))
}

/** USD original entre parênteses — auditoria no painel admin. */
export function formatUsdReference(usd: number | null | undefined): string {
  const v = Number(usd ?? 0)
  const casas = v !== 0 && Math.abs(v) < 0.01 ? 4 : 2
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: casas,
  }).format(Number.isFinite(v) ? v : 0)
}

/** "R$ 26,45 (US$ 5.16)" — BRL principal, USD para conferência. */
export function formatBRLWithUsd(
  usd: number | null | undefined,
  rate: number | null | undefined,
): string {
  return `${formatBRLTotal(usd, rate)} (${formatUsdReference(usd)})`
}

/** Preço de tabela do modelo: R$ por 1M tokens. */
export function formatBRLPerMillion(
  usdPerMillion: number | null | undefined,
  rate: number | null | undefined,
): string {
  if (usdPerMillion == null || !Number.isFinite(Number(usdPerMillion))) {
    return "—"
  }
  return formatBRLValue(usdToBrl(usdPerMillion, rate))
}

/** Frase padrão da cotação usada nos tooltips. */
export function rateHint(rate: number | null | undefined): string {
  const n = normalizeRate(rate)
  return `Convertido do dólar pela cotação do dia: US$ 1 = ${formatBRLValue(n)}.`
}
