/**
 * Janela deslizante do histórico enviado ao modelo.
 *
 * Mora fora da rota de chat porque a sumarização rolling
 * (services/chat-summary.ts) precisa do MESMO ponto de corte que o system
 * prompt usa: se os dois divergirem, o resumo cobre um trecho diferente do
 * que ficou de fora e a conversa perde (ou duplica) informação.
 */

/** Só o que o corte precisa saber da mensagem — serve para LlmMessage e StoredMessage. */
interface ComRole {
  role: string
}

export interface JanelaHistorico<T> {
  mensagens: T[]
  /** Sobrou histórico fora da janela (vira resumo/aviso no system prompt). */
  cortou: boolean
}

/**
 * Índice da primeira mensagem que ENTRA na janela. Se o corte cair no meio de
 * um par user/assistant, avança até a próxima do usuário — a Anthropic exige
 * que o contexto comece com `role: "user"`.
 */
export function indiceInicioJanela<T extends ComRole>(
  historico: T[],
  limite: number,
): number {
  let inicio = Math.max(0, historico.length - limite)
  while (inicio < historico.length && historico[inicio]!.role !== "user") {
    inicio += 1
  }
  return inicio
}

/** Últimas N mensagens do histórico (ver `indiceInicioJanela`). */
export function aplicarJanela<T extends ComRole>(
  historico: T[],
  limite: number,
): JanelaHistorico<T> {
  const inicio = indiceInicioJanela(historico, limite)
  return { mensagens: historico.slice(inicio), cortou: inicio > 0 }
}
