import { useEffect, useState } from "react"

/**
 * Valor com atraso — para cálculos que não precisam acompanhar cada tecla
 * (ex.: estimativa de custo enquanto o usuário digita).
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
