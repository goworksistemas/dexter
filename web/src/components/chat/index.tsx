/**
 * Ponto de entrada do chat do Dexter. O shell (outro agente) importa só isto:
 *   import { ChatThread } from "@/components/chat"
 *
 * `ChatThread` monta o AssistantRuntime (AgentCore real por padrão — ver
 * `useDexterRuntime`) usando a conversa ativa (`useChats().activeChatId`)
 * como `threadId`, registra esse runtime no `ChatsProvider` (pra que
 * `newChat()`/`selectChat()` na sidebar consigam limpar/injetar mensagens) e
 * renderiza o Thread completo dentro do AssistantRuntimeProvider.
 */
import { useEffect } from "react"
import { AssistantRuntimeProvider } from "@assistant-ui/react"

import { Thread } from "@/components/chat/thread"
import { useChats } from "@/lib/chats"
import { useModels } from "@/lib/models"
import { useDexterRuntime } from "@/lib/runtime/use-dexter-runtime"

export function ChatThread() {
  const { activeChatId, registerRuntime, refreshChats } = useChats()
  const { selectedModelId } = useModels()
  const runtime = useDexterRuntime(activeChatId, selectedModelId)

  // Registra o runtime assim que existe (e desregistra ao desmontar) para
  // que o ChatsProvider consiga chamar runtime.thread.reset(...) a partir
  // de newChat()/selectChat() na sidebar.
  useEffect(() => {
    registerRuntime(runtime)
    return () => registerRuntime(null)
  }, [runtime, registerRuntime])

  // Assim que uma resposta termina de rodar, rebusca a lista de conversas:
  // é nesse momento que o AgentCore cria (numa conversa nova) ou atualiza
  // (título, updated_at) o registro que a sidebar exibe.
  useEffect(() => {
    let estavaRodando = runtime.thread.getState().isRunning
    return runtime.thread.subscribe(() => {
      const rodandoAgora = runtime.thread.getState().isRunning
      if (estavaRodando && !rodandoAgora) refreshChats()
      estavaRodando = rodandoAgora
    })
  }, [runtime, refreshChats])

  // `Thread` recebe `runtime` diretamente (além do contexto do provider
  // abaixo) porque lê o estado pela API imperativa do runtime, contornando
  // um bug de reatividade da versão instalada do assistant-ui — ver
  // `@/lib/runtime/use-thread-state` para os detalhes.
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread runtime={runtime} />
    </AssistantRuntimeProvider>
  )
}
