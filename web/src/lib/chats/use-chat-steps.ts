/**
 * Histórico de passos do agente por mensagem, para o "Ver detalhes" das
 * respostas já persistidas (`GET /api/chats/:id/steps`).
 *
 * O run ao vivo vem do `chatRunsStore`; isto cobre o depois: recarregar a
 * página ou voltar numa conversa antiga e ainda ver como a resposta foi feita.
 */
import * as React from "react"

import { fetchChatSteps } from "./api"
import { stepFromWire, type RunStep } from "./run-steps"

const VAZIO: Record<string, RunStep[]> = {}

export function useChatStepsHistory(chatId: string): Record<string, RunStep[]> {
  const [porMensagem, setPorMensagem] =
    React.useState<Record<string, RunStep[]>>(VAZIO)

  React.useEffect(() => {
    if (!chatId) return
    const controller = new AbortController()
    setPorMensagem(VAZIO)

    fetchChatSteps(chatId, controller.signal)
      .then((registros) => {
        if (controller.signal.aborted) return
        if (registros.length === 0) {
          setPorMensagem(VAZIO)
          return
        }
        const mapa: Record<string, RunStep[]> = {}
        for (const registro of registros) {
          mapa[registro.messageId] = registro.steps.map(stepFromWire)
        }
        setPorMensagem(mapa)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        // Detalhe opcional: falhar aqui não pode atrapalhar a conversa.
        console.error(`Falha ao carregar passos da conversa ${chatId}:`, err)
      })

    return () => controller.abort()
  }, [chatId])

  return porMensagem
}
