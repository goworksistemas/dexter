/**
 * Contrato compartilhado entre a UI de chat (assistant-ui runtime) e o
 * transporte que fala com o AgentCore (backend Fastify, streaming SSE).
 *
 * Este arquivo é a FRONTEIRA estável: tanto o MockTransport (dev, sem backend)
 * quanto o AgentCoreTransport (SSE real) implementam `ChatTransport`.
 * NÃO adicionar lógica aqui — só tipos.
 */

export type ChatRole = "user" | "assistant" | "system";

/** Anexo enviado com uma mensagem. Imagem → visão do Claude; PDF → documento.
 * `dataBase64` é o conteúdo do arquivo em base64 (sem o prefixo data:). */
export interface ChatAttachment {
  type: "image" | "document";
  name: string;
  /** ex.: "image/png", "image/jpeg", "application/pdf". */
  mediaType: string;
  dataBase64: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt?: string;
  /** anexos da mensagem (só na última mensagem do usuário costuma vir preenchido). */
  attachments?: ChatAttachment[];
}

/**
 * Artefato como vai no fio para o AgentCore (`context.artifacts`).
 * `is_truncated` é o que faz o backend escrever ", INCOMPLETO" no system
 * prompt — sem ele o modelo recria o artefato em vez de completá-lo.
 */
export interface ArtifactWire {
  kind: string;
  title: string;
  content: string;
  version: number;
  is_truncated?: boolean;
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
  /** projeto ao criar conversa nova — persistido em agent_chats.project_id. */
  projectId?: string;
  /**
   * Versão atual dos artefatos da conversa. O AgentCore injeta no system
   * prompt — NÃO deve ser colado no content da mensagem do usuário.
   */
  artifacts?: ArtifactWire[];
  [key: string]: unknown;
}

/**
 * Só a mensagem NOVA vai no fio: o AgentCore monta o contexto do turno com o
 * histórico persistido em `agent_messages` (janela deslizante do lado dele).
 * Reenviar a thread inteira a cada turno era o maior custo de input do produto.
 */
export interface ChatRequest {
  threadId: string;
  message: ChatMessage;
  context?: ChatContext;
}

/**
 * Progresso do loop agêntico (`event: progress` no SSE). Formato de fio em
 * snake_case, igual ao emitido por `server/src/systems/progress.ts`.
 * Args/resultados já vêm resumidos e truncados pelo backend.
 */
export type AgentProgressEvent =
  | { type: "status"; text: string; step?: number }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call_start";
      id: string;
      step: number;
      tool: string;
      system?: string;
      system_label?: string;
      tool_label?: string;
      label: string;
      args_summary?: string;
    }
  | {
      type: "tool_call_end";
      id: string;
      step: number;
      tool: string;
      status: "ok" | "error";
      duration_ms: number;
      rows?: number;
      summary: string;
    };

/** Passo concluído como o backend devolve em `GET /api/chats/:id/steps`. */
export interface AgentStepWire {
  id: string;
  step: number;
  tool: string;
  system?: string;
  system_label?: string;
  tool_label?: string;
  label: string;
  args_summary?: string;
  status: "ok" | "error";
  duration_ms?: number;
  rows?: number;
  summary: string;
  created_at?: string;
}

/** Eventos emitidos pelo stream (mapeiam 1:1 aos eventos SSE do AgentCore).
 * `retriable` só existe em erros SINTÉTICOS do transporte (conexão caiu no
 * meio do stream): o run pode continuar vivo no servidor — vale reanexar. */
export type ChatStreamChunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; result: unknown }
  | { type: "progress"; event: AgentProgressEvent }
  | { type: "heartbeat" }
  | { type: "error"; message: string; retriable?: boolean }
  | { type: "done" };

/** Estado do run de uma conversa no servidor (`GET /api/chat/:id/run`). */
export interface ChatRunStatusWire {
  /** Há geração em andamento no servidor para esta conversa. */
  active: boolean;
  /** `null` = o servidor não conhece run recente desta conversa. */
  status: "running" | "done" | "error" | "cancelled" | null;
}

export interface ChatTransport {
  /**
   * Envia a requisição e devolve um stream assíncrono de chunks.
   * Deve respeitar o AbortSignal para cancelamento (stop).
   */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatStreamChunk>;
  /** Estado do run desta conversa no servidor (ativo ou recém-encerrado). */
  fetchRunStatus(threadId: string): Promise<ChatRunStatusWire>;
  /**
   * Reanexa num run em andamento no servidor: replay do que já foi gerado
   * (progresso + texto acumulado) e eventos ao vivo até o terminal — mesmo
   * contrato de chunks do `stream`.
   */
  resumeStream(
    threadId: string,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamChunk>;
  /** Cancela a geração em andamento no servidor (botão Parar). */
  cancelRun(threadId: string): Promise<void>;
}
