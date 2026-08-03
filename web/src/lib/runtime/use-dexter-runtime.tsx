/**
 * Adapta o `ChatTransport` (fronteira estável do AgentCore) ao runtime do
 * assistant-ui v0.15. Constrói um `ChatModelAdapter` cujo `run()` consome o
 * AsyncIterable do transporte e o traduz para os `ChatModelRunResult` que o
 * `useLocalRuntime` espera.
 *
 * Por padrão fala com o AgentCore real (`AgentCoreTransport`, SSE). O
 * `MockTransport` continua disponível como fallback opcional, atrás da flag
 * `VITE_USE_MOCK=true` (útil pra mexer na UI sem o backend rodando).
 */
import { useMemo, useRef } from "react"
import { useLocalRuntime } from "@assistant-ui/react"
import type {
  AssistantRuntime,
  ChatModelAdapter,
  ChatModelRunResult,
  ThreadMessage,
} from "@assistant-ui/react"

import { AgentCoreTransport } from "@/lib/agentcore"
import type { ChatMessage, ChatTransport } from "@/lib/agentcore/contract"
import { MockTransport } from "@/lib/runtime/mock-transport"

/** Junta as partes de texto de uma ThreadMessage num único texto simples —
 * é isso que o ChatTransport espera em `ChatMessage.content`. */
function extrairTexto(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

/** Converte as ThreadMessage do assistant-ui para o formato simples do
 * contrato ChatTransport. */
function paraChatMessages(messages: readonly ThreadMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: extrairTexto(message),
    createdAt: message.createdAt.toISOString(),
  }))
}

/** Cria o ChatModelAdapter que faz a ponte entre o runtime do assistant-ui
 * e um ChatTransport concreto (mock ou AgentCore real).
 *
 * Recebe o threadId e o modelo selecionado como `refs` (não valores fixos)
 * porque ambos podem mudar sem que o runtime inteiro seja recriado — a
 * conversa ativa (nova conversa / troca na sidebar) e o modelo escolhido no
 * `ModelSelector` do header. Cada chamada de `run()` lê os valores mais
 * recentes em `threadIdRef.current` / `modelIdRef.current`. */
function criarChatModelAdapter(
  transport: ChatTransport,
  threadIdRef: { current: string },
  modelIdRef: { current: string | null }
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const chatMessages = paraChatMessages(messages)
      let texto = ""

      const resultado = (): ChatModelRunResult => ({
        content: [{ type: "text", text: texto }],
        status: { type: "running" },
      })

      const modeloSelecionado = modelIdRef.current
      const context = modeloSelecionado ? { model: modeloSelecionado } : undefined

      try {
        for await (const chunk of transport.stream(
          { threadId: threadIdRef.current, messages: chatMessages, context },
          abortSignal
        )) {
          if (chunk.type === "text-delta") {
            texto += chunk.textDelta
            yield resultado()
          } else if (chunk.type === "error") {
            // Torna o erro visível na própria bolha da resposta.
            texto += `\n\n_Erro: ${chunk.message}_`
            yield {
              content: [{ type: "text", text: texto }],
              status: { type: "incomplete", reason: "error", error: chunk.message },
            }
            return
          } else if (chunk.type === "done") {
            yield {
              content: [{ type: "text", text: texto }],
              status: { type: "complete", reason: "stop" },
            }
            return
          }
          // tool-call / tool-result: reservados para quando o AgentCore
          // expuser tools reais; a UI de chat não precisa tratá-los agora.
        }

        // O stream terminou sem emitir "done" nem "error" — normalmente
        // porque foi abortado (botão "parar"). Fecha a mensagem como cancelada.
        yield {
          content: [{ type: "text", text: texto }],
          status: { type: "incomplete", reason: "cancelled" },
        }
      } catch (err) {
        if (abortSignal.aborted) {
          yield {
            content: [{ type: "text", text: texto }],
            status: { type: "incomplete", reason: "cancelled" },
          }
          return
        }
        throw err
      }
    },
  }
}

/** Resolve o transporte a usar: AgentCore real por padrão, MockTransport só
 * quando `VITE_USE_MOCK=true` (dev sem backend). */
function criarTransportPadrao(): ChatTransport {
  return import.meta.env.VITE_USE_MOCK === "true"
    ? new MockTransport()
    : new AgentCoreTransport()
}

/**
 * Hook que monta o AssistantRuntime a partir de um ChatTransport.
 *
 * `threadId` é o id da conversa ativa (UUID gerado pelo front — ver
 * `@/lib/chats`). Quando ele muda (nova conversa / troca de conversa), as
 * próximas mensagens enviadas já usam o novo id; quem decide limpar/injetar
 * histórico nas mensagens exibidas é o chamador (ver `ChatsProvider.newChat`
 * e `.selectChat`, que chamam `runtime.thread.reset(...)`).
 *
 * Se `threadId` não for informado, cai para um UUID novo gerado na hora
 * (uso avulso do hook, sem o provider de conversas).
 *
 * `selectedModelId` é o id do modelo escolhido no `ModelSelector` do header
 * (ver `@/lib/models`). Vai em `context.model` de cada `ChatRequest` — quando
 * `undefined`/`null` (backend de modelos fora do ar, ou catálogo vazio), o
 * request sai sem `context`, e o backend usa o default dele.
 */
export function useDexterRuntime(
  threadId?: string,
  selectedModelId?: string | null,
  transport?: ChatTransport
): AssistantRuntime {
  const transportRef = useRef<ChatTransport | null>(null)
  if (!transportRef.current) {
    transportRef.current = transport ?? criarTransportPadrao()
  }

  const fallbackIdRef = useRef<string | null>(null)
  if (!fallbackIdRef.current) fallbackIdRef.current = crypto.randomUUID()

  // "Latest ref": atualizado a cada render, lido só dentro de run() — não
  // dispara re-render nem recria o adapter/runtime.
  const threadIdRef = useRef(threadId ?? fallbackIdRef.current)
  threadIdRef.current = threadId ?? fallbackIdRef.current

  const modelIdRef = useRef<string | null>(selectedModelId ?? null)
  modelIdRef.current = selectedModelId ?? null

  const adapter = useMemo(
    () => criarChatModelAdapter(transportRef.current!, threadIdRef, modelIdRef),
    []
  )

  return useLocalRuntime(adapter)
}
