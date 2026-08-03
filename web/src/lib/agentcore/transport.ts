/**
 * Transporte que fala com o backend AgentCore (Fastify) via streaming SSE.
 *
 * FORMATO SSE ESPERADO DO AGENTCORE (para o time de backend implementar):
 *
 *   event: text-delta
 *   data: {"textDelta":"olá"}
 *
 *   event: tool-call
 *   data: {"toolCallId":"abc123","toolName":"buscar_contato","args":{"id":1}}
 *
 *   event: tool-result
 *   data: {"toolCallId":"abc123","result":{"nome":"..."}}
 *
 *   event: error
 *   data: {"message":"descrição do erro"}
 *
 *   event: done
 *   data: {}
 *
 * Regras:
 * - Cada evento é um bloco `event: <tipo>` + `data: <json>`, terminado por
 *   uma linha em branco (protocolo SSE padrão, `\n\n` separando eventos).
 * - `data` é sempre um JSON válido (`{}` quando o evento não carrega payload,
 *   como em `done`).
 * - O evento `done` encerra o stream — o cliente para de ler após recebê-lo
 *   e a conexão HTTP pode ser fechada pelo backend.
 * - Erros de rede/HTTP que acontecem antes de o stream abrir (ex.: 401, 500,
 *   falha de conexão) são convertidos pelo transporte num chunk
 *   `{type:"error"}` sintético — não precisam ser modelados como evento SSE.
 */
import { getAccessToken } from "@/lib/supabase/auth";
import type { ChatRequest, ChatStreamChunk, ChatTransport } from "./contract";

interface AgentCoreTransportOptions {
  /** Base da API do AgentCore. Default: caminho relativo `/api`, que o Vite
   * faz proxy para o backend em dev (ver vite.config.ts). */
  baseUrl?: string;
}

/** Implementação de `ChatTransport` que consome o endpoint `/chat` do
 * AgentCore via streaming SSE. */
export class AgentCoreTransport implements ChatTransport {
  private readonly baseUrl: string;

  constructor(options: AgentCoreTransportOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/api";
  }

  async *stream(
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    let response: Response;
    try {
      const token = await getAccessToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      response = await fetch(`${this.baseUrl}/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      yield { type: "error", message: describeError(err) };
      return;
    }

    if (!response.ok || !response.body) {
      yield {
        type: "error",
        message: `AgentCore respondeu ${response.status} ${response.statusText}`,
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Eventos SSE são separados por uma linha em branco.
        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const chunk = parseSseEvent(rawEvent);
          if (chunk) {
            yield chunk;
            if (chunk.type === "done") return;
          }
          separatorIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      yield { type: "error", message: describeError(err) };
    } finally {
      reader.releaseLock();
    }
  }
}

/** Interpreta um bloco de evento SSE bruto (`event: x\ndata: y`) e devolve o
 * `ChatStreamChunk` correspondente, ou `null` para eventos desconhecidos. */
function parseSseEvent(rawEvent: string): ChatStreamChunk | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  const rawData = dataLines.join("\n");
  let payload: unknown = {};
  if (rawData) {
    try {
      payload = JSON.parse(rawData);
    } catch {
      return { type: "error", message: `SSE data inválido: ${rawData}` };
    }
  }

  return toChunk(eventName, payload);
}

/** Converte (evento, payload) já desserializado em um `ChatStreamChunk`. */
function toChunk(eventName: string, payload: unknown): ChatStreamChunk | null {
  const data = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;

  switch (eventName) {
    case "text-delta":
      return { type: "text-delta", textDelta: String(data.textDelta ?? "") };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: String(data.toolCallId ?? ""),
        toolName: String(data.toolName ?? ""),
        args: data.args,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: String(data.toolCallId ?? ""),
        result: data.result,
      };
    case "error":
      return {
        type: "error",
        message: String(data.message ?? "Erro desconhecido do AgentCore"),
      };
    case "done":
      return { type: "done" };
    default:
      return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
