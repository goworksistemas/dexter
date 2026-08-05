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
 *   event: progress
 *   data: {"type":"tool_call_start","tool":"pipego__dexter_sql","step":1,...}
 *   data: {"type":"tool_call_end","status":"ok","duration_ms":842,"rows":13,...}
 *   data: {"type":"status","text":"Gerando resposta"}
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
import type {
  AgentProgressEvent,
  ChatRequest,
  ChatRunStatusWire,
  ChatStreamChunk,
  ChatTransport,
} from "./contract";

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
      // Falha ANTES de abrir o stream: o run nem começou — não é reanexável.
      yield { type: "error", message: describeError(err) };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: "error", message: await describeHttpError(response) };
      return;
    }

    yield* lerStreamSse(response.body, signal);
  }

  /** Estado do run desta conversa no servidor (`GET /api/chat/:id/run`). */
  async fetchRunStatus(threadId: string): Promise<ChatRunStatusWire> {
    const token = await getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${this.baseUrl}/chat/${threadId}/run`, {
      headers,
    });
    if (!response.ok) {
      throw new Error(await describeHttpError(response));
    }
    const body = (await response.json()) as Partial<ChatRunStatusWire>;
    return {
      active: body.active === true,
      status: body.status ?? null,
    };
  }

  /**
   * Reanexa num run em andamento (`GET /api/chat/:id/stream`): replay do que
   * já foi gerado + eventos ao vivo. Falhas de rede e 404 (o run terminou e
   * saiu da janela de reanexação entre a checagem e o GET) saem como erro
   * `retriable` — quem consome re-checa o estado e decide.
   */
  async *resumeStream(
    threadId: string,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    let response: Response;
    try {
      const token = await getAccessToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      response = await fetch(`${this.baseUrl}/chat/${threadId}/stream`, {
        headers,
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      yield { type: "error", message: describeError(err), retriable: true };
      return;
    }

    if (response.status === 404) {
      yield {
        type: "error",
        message: "Nenhuma geração em andamento para reanexar.",
        retriable: true,
      };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: "error", message: await describeHttpError(response) };
      return;
    }

    yield* lerStreamSse(response.body, signal);
  }

  /** Cancela a geração no servidor (`POST /api/chat/:id/cancel`). 404 (nada
   * rodando) é sucesso silencioso — o objetivo já está atingido. */
  async cancelRun(threadId: string): Promise<void> {
    const token = await getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${this.baseUrl}/chat/${threadId}/cancel`, {
      method: "POST",
      headers,
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(await describeHttpError(response));
    }
  }
}

/**
 * Lê um corpo SSE já aberto e emite os chunks até o `done`. Conexão caindo no
 * meio (fim sem `done`, erro de leitura) vira erro `retriable`: o run pode
 * continuar vivo no servidor e o consumidor tenta reanexar.
 */
async function* lerStreamSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ChatStreamChunk> {
  const reader = body.getReader();
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

    // Chegou aqui sem `done`: o servidor/proxy fechou no meio. Uma resposta
    // cortada não pode ser settlada como concluída com sucesso.
    if (!signal.aborted) {
      yield {
        type: "error",
        message: "A conexão com o AgentCore caiu antes de a resposta terminar.",
        retriable: true,
      };
    }
  } catch (err) {
    if (signal.aborted) return;
    yield { type: "error", message: describeError(err), retriable: true };
  } finally {
    // Consumidor pode fechar o generator antes do fim (troca de conversa,
    // run substituído) — sem cancel a conexão SSE fica pendurada no Fastify.
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    reader.releaseLock();
  }
}

/** Erro HTTP com a mensagem do corpo (`{message}`) quando o AgentCore manda. */
async function describeHttpError(response: Response): Promise<string> {
  if (response.status === 401) {
    return "Sua sessão expirou. Entre novamente para continuar.";
  }
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message) return message;
  return `AgentCore respondeu ${response.status} ${response.statusText}`;
}

/** Interpreta um bloco de evento SSE bruto (`event: x\ndata: y`) e devolve o
 * `ChatStreamChunk` correspondente, ou `null` para eventos desconhecidos. */
function parseSseEvent(rawEvent: string): ChatStreamChunk | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    // Comentários SSE (`: keepalive`) — heartbeat do AgentCore.
    if (line.startsWith(":") || line.trim() === "") continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  // Comentário SSE puro (`: keepalive`) — sinal de vida do AgentCore.
  if (eventName === "message" && dataLines.length === 0) {
    return rawEvent.trim().startsWith(":") ? { type: "heartbeat" } : null;
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
    case "progress": {
      const event = toProgressEvent(data);
      return event ? { type: "progress", event } : null;
    }
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

function textoOpcional(valor: unknown): string | undefined {
  return typeof valor === "string" && valor.length > 0 ? valor : undefined;
}

function numeroOpcional(valor: unknown): number | undefined {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : undefined;
}

/** Valida o payload de `event: progress`; descarta o que não reconhece. */
function toProgressEvent(
  data: Record<string, unknown>,
): AgentProgressEvent | null {
  switch (data.type) {
    case "status": {
      const text = textoOpcional(data.text);
      if (!text) return null;
      const step = numeroOpcional(data.step);
      return { type: "status", text, ...(step !== undefined ? { step } : {}) };
    }
    case "thinking": {
      const text = textoOpcional(data.text);
      return text ? { type: "thinking", text } : null;
    }
    case "tool_call_start": {
      const tool = textoOpcional(data.tool);
      if (!tool) return null;
      return {
        type: "tool_call_start",
        id: String(data.id ?? tool),
        step: numeroOpcional(data.step) ?? 0,
        tool,
        system: textoOpcional(data.system),
        system_label: textoOpcional(data.system_label),
        tool_label: textoOpcional(data.tool_label),
        label: textoOpcional(data.label) ?? tool,
        args_summary: textoOpcional(data.args_summary),
      };
    }
    case "tool_call_end": {
      const tool = textoOpcional(data.tool);
      if (!tool) return null;
      const rows = numeroOpcional(data.rows);
      return {
        type: "tool_call_end",
        id: String(data.id ?? tool),
        step: numeroOpcional(data.step) ?? 0,
        tool,
        status: data.status === "error" ? "error" : "ok",
        duration_ms: numeroOpcional(data.duration_ms) ?? 0,
        ...(rows !== undefined ? { rows } : {}),
        summary: textoOpcional(data.summary) ?? "",
      };
    }
    default:
      return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
