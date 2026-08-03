// Barrel export do módulo AgentCore: transporte SSE real + tipos do
// contrato (a fronteira estável compartilhada com a UI de chat).
export { AgentCoreTransport } from "./transport";
export type {
  ChatContext,
  ChatMessage,
  ChatRequest,
  ChatRole,
  ChatStreamChunk,
  ChatTransport,
} from "./contract";
