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

/**
 * Tentativas do refetch pós-run. O servidor emite `done` e só DEPOIS grava a
 * auditoria (um INSERT por tool call): com 3+ tools as linhas ainda não
 * existem 250ms depois, e sem re-tentativa a resposta recém-concluída ficava
 * sem "Ver detalhes" até o próximo F5.
 */
const ESPERAS_MS = [250, 1_200, 3_000]

/**
 * `refreshKey` refaz o fetch sem trocar de conversa — o chamador incrementa
 * quando um run assenta, senão a resposta que acabou de chegar perde o
 * "Ver detalhes" (o progresso ao vivo é descartado no reload do histórico).
 */
export function useChatStepsHistory(
  chatId: string,
  refreshKey: number = 0,
): Record<string, RunStep[]> {
  const [porMensagem, setPorMensagem] =
    React.useState<Record<string, RunStep[]>>(VAZIO)
  const chatIdCarregadoRef = React.useRef<string | null>(null)
  /** Mensagens já conhecidas — a re-tentativa para quando aparece uma nova. */
  const conhecidosRef = React.useRef(new Set<string>())

  React.useEffect(() => {
    if (!chatId) return
    const controller = new AbortController()
    // Troca de conversa limpa a tela; refetch pós-run mantém o que já está lá.
    const trocouDeChat = chatIdCarregadoRef.current !== chatId
    if (trocouDeChat) {
      chatIdCarregadoRef.current = chatId
      conhecidosRef.current = new Set()
      setPorMensagem(VAZIO)
    }

    // Só o refetch pós-run insiste; abrir a conversa é uma tentativa só.
    const esperas = trocouDeChat ? ESPERAS_MS.slice(0, 1) : ESPERAS_MS
    const timers: number[] = []

    const buscar = (tentativa: number) => {
      fetchChatSteps(chatId, controller.signal)
        .then((registros) => {
          if (controller.signal.aborted) return
          let novidade = false
          const mapa: Record<string, RunStep[]> = {}
          for (const registro of registros) {
            mapa[registro.messageId] = registro.steps.map(stepFromWire)
            if (!conhecidosRef.current.has(registro.messageId)) {
              conhecidosRef.current.add(registro.messageId)
              novidade = true
            }
          }
          // Mescla: sobrescrever apagaria os passos já na tela quando a
          // auditoria da última resposta ainda não terminou de gravar.
          if (registros.length > 0) {
            setPorMensagem((prev) => ({ ...prev, ...mapa }))
          }
          // Nada novo e ainda há tentativa: a auditoria pode estar em voo.
          if (!novidade && tentativa + 1 < esperas.length) {
            agendar(tentativa + 1)
          }
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          console.error(`Falha ao carregar passos da conversa ${chatId}:`, err)
          if (tentativa + 1 < esperas.length) agendar(tentativa + 1)
        })
    }

    // Depois das mensagens — "Ver detalhes" não bloqueia a troca de chat.
    const agendar = (tentativa: number) => {
      const espera =
        tentativa === 0
          ? esperas[0]!
          : esperas[tentativa]! - esperas[tentativa - 1]!
      timers.push(window.setTimeout(() => buscar(tentativa), espera))
    }
    agendar(0)

    return () => {
      controller.abort()
      for (const t of timers) window.clearTimeout(t)
    }
  }, [chatId, refreshKey])

  return porMensagem
}
