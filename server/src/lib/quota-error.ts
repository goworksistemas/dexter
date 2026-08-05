/**
 * Detecção PURA de erro de cota/cobrança do provider (sem config/banco) —
 * usada por services/provider-credit.ts e testável isoladamente.
 *
 * Só sinal claro de COBRANÇA/cota esgotada marca o crédito como `depleted`
 * (estado que persiste no banco e tira o provider do catálogo até um admin
 * reabilitar). 429/rate-limit puro é transitório — no Gemini o limite por
 * minuto é rotina — e não pode desligar o provider inteiro.
 */
export function isQuotaError(message: string): boolean {
  const cobranca =
    /insufficient.?quota|quota.?exceeded|exceeded.*quota|billing|credit.?balance|payment.?required|check your plan|\b402\b/i.test(
      message,
    )
  if (!cobranca) return false
  const transitorio = /rate.?limit|per.?minute|per.?second|try again|tente novamente/i.test(
    message,
  )
  // Transitório só conta quando o corpo também cita cobrança explícita.
  return !transitorio || /billing|insufficient|credit|plan/i.test(message)
}
