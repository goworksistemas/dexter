/**
 * Transporte MOCK do Dexter: simula uma resposta de assistente em streaming
 * SEM depender de nenhum backend. Implementa o contrato estável
 * `ChatTransport` (ver src/lib/agentcore/contract.ts) — quando o AgentCore
 * real estiver pronto, basta trocar `new MockTransport()` por
 * `new AgentCoreTransport()` em `use-dexter-runtime.tsx`, sem tocar na UI.
 */
import type {
  ChatRequest,
  ChatRunStatusWire,
  ChatStreamChunk,
  ChatTransport,
} from "@/lib/agentcore/contract"

/** Respostas plausíveis em pt-BR. A variação vem de um contador simples
 * (nunca de Date.now()/Math.random()), então cada chamada avança para a
 * próxima resposta da lista de forma previsível. */
const RESPOSTAS_MOCK: readonly string[] = [
  "Claro, posso ajudar com isso. Me conta um pouco mais sobre o contexto — qual sistema você está usando (gowork, gocorporate, networkgo...) e o que já foi tentado até agora?",
  "Entendi o pedido. Vou levantar as informações relevantes por aqui. Enquanto isso, tem algum prazo ou prioridade que eu deveria considerar?\n\nAlguns pontos que costumam ajudar:\n- Nome do formulário ou fluxo envolvido\n- Portal do HubSpot (ex.: 23722967)\n- Print ou link do card, se houver",
  "Boa pergunta. Com base no que foi descrito, o próximo passo costuma ser verificar os logs de integração e confirmar se o dado chegou corretamente até o HubSpot. Quer que eu detalhe esse fluxo passo a passo?",
  "Já registrei o que você pediu. Se puder compartilhar o link do card ou do formulário em questão, consigo te dar uma resposta mais precisa e objetiva.",
]

/** Intervalo (ms) entre cada pedaço de texto emitido — simula o streaming
 * token a token de um LLM real. */
const INTERVALO_MS = 25

export class MockTransport implements ChatTransport {
  private contador = 0

  async *stream(
    _req: ChatRequest,
    signal: AbortSignal
  ): AsyncIterable<ChatStreamChunk> {
    const resposta = RESPOSTAS_MOCK[this.contador % RESPOSTAS_MOCK.length]
    this.contador += 1

    // Quebra a resposta em palavras (mantendo o espaço colado à palavra
    // anterior) para simular o streaming token a token.
    const pedacos = resposta.split(/(?<=\s)/)

    for (const pedaco of pedacos) {
      if (signal.aborted) return

      await aguardar(INTERVALO_MS, signal)
      if (signal.aborted) return

      yield { type: "text-delta", textDelta: pedaco }
    }

    yield { type: "done" }
  }

  /** O mock roda tudo no client — nunca há run vivo "no servidor". */
  async fetchRunStatus(_threadId: string): Promise<ChatRunStatusWire> {
    return { active: false, status: null }
  }

  async *resumeStream(
    _threadId: string,
    _signal: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    yield { type: "done" }
  }

  async cancelRun(_threadId: string): Promise<void> {
    // Nada a cancelar fora do processo — o abort do signal já resolve.
  }
}

/** Espera `ms` milissegundos, retornando mais cedo se `signal` for abortado
 * (usado para respeitar o cancelamento do streaming). */
function aguardar(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
