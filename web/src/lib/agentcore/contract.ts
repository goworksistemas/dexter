/**
 * Contrato compartilhado entre a UI de chat (assistant-ui runtime) e o
 * transporte que fala com o AgentCore (backend Fastify, streaming SSE).
 *
 * Este arquivo é a FRONTEIRA estável: tanto o MockTransport (dev, sem backend)
 * quanto o AgentCoreTransport (SSE real) implementam `ChatTransport`.
 * NÃO adicionar lógica aqui — só tipos.
 */

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt?: string;
}

/** Contexto da conversa: qual sistema/tenant, usuário, etc. (o AgentCore usa
 * isto para rotear o acesso indexado aos projetos Supabase). */
export interface ChatContext {
  /** slug do sistema alvo, ex.: "networkgo", "pipego". Opcional. */
  system?: string;
  /** id do tenant/empresa quando aplicável. */
  tenantId?: string;
  /** id do modelo escolhido na interface (ver GET /api/models). Quando ausente,
   * o backend usa o default. É o que dá "trocar de modelo pela interface". */
  model?: string;
  [key: string]: unknown;
}

export interface ChatRequest {
  threadId: string;
  messages: ChatMessage[];
  context?: ChatContext;
}

/** Eventos emitidos pelo stream (mapeiam 1:1 aos eventos SSE do AgentCore). */
export type ChatStreamChunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatTransport {
  /**
   * Envia a requisição e devolve um stream assíncrono de chunks.
   * Deve respeitar o AbortSignal para cancelamento (stop).
   */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatStreamChunk>;
}
