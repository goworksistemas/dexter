/**
 * Erros do modelo já traduzidos para o usuário.
 *
 * Os agent loops traduzem a falha do provider para português antes de lançar
 * (ver `mensagemApiError`). A rota /api/chat não pode re-filtrar essa mensagem
 * por regex em inglês — senão a informação acionável se perde num fallback
 * genérico. Marcar o Error deixa a rota saber que a mensagem já está pronta
 * para o cliente.
 */

const MARCA = Symbol.for("dexter.erroSanitizado")

/** Error cuja `message` já pode ir direto ao cliente (texto curado, sem internals). */
export function erroSanitizado(message: string): Error {
  const err = new Error(message)
  ;(err as unknown as Record<symbol, boolean>)[MARCA] = true
  return err
}

/** True quando a mensagem do erro já foi curada por quem o lançou. */
export function isErroSanitizado(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err as unknown as Record<symbol, boolean>)[MARCA] === true &&
    !!err.message.trim()
  )
}
