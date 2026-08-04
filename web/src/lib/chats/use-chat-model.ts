/**
 * Modelo efetivo POR CONVERSA.
 *
 * Regras:
 * - Conversa existente com modelo pinado (agent_chats.model) → usa o pinado.
 * - Conversa nova (ainda não persistida) → usa o default global (localStorage).
 * - Trocar o modelo numa conversa em andamento pina SÓ aquela conversa
 *   (PATCH /api/chats/:id) — não vaza para as outras nem muda o default.
 * - Trocar o modelo sem conversa ativa persistida muda o default global,
 *   que vale apenas para conversas novas.
 */
import * as React from "react"
import { toast } from "sonner"

import { useModels } from "@/lib/models"
import { useChats } from "./chats-context"

export interface ChatModelValue {
  /** Modelo que este chat vai usar no próximo envio. */
  effectiveModelId: string | null
  /** Troca ciente do escopo (conversa em andamento vs. default global). */
  selectModelForChat: (id: string) => void
}

export function useChatModel(): ChatModelValue {
  const { activeChat, setChatModel } = useChats()
  const { models, selectedModelId, selectModel } = useModels()

  const pinned = activeChat?.model ?? null
  const pinnedOnline = Boolean(
    pinned && models.some((m) => m.id === pinned),
  )
  // Modelo pinado que saiu do ar cai para o default — sem travar a conversa.
  const effectiveModelId = pinnedOnline ? pinned : selectedModelId

  const selectModelForChat = React.useCallback(
    (id: string) => {
      if (activeChat) {
        void setChatModel(activeChat.id, id).catch((err) => {
          toast.error(
            err instanceof Error
              ? err.message
              : "Falha ao trocar o modelo da conversa.",
          )
        })
        return
      }
      // Sem conversa persistida: vira o default para conversas novas.
      selectModel(id)
    },
    [activeChat, setChatModel, selectModel],
  )

  return React.useMemo(
    () => ({ effectiveModelId, selectModelForChat }),
    [effectiveModelId, selectModelForChat],
  )
}
