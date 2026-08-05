/**
 * Multi-agentes opt-in — tool dexter__spawn_subagent delega subtarefas a um
 * sub-loop focado (mesmo usuário, mesmas permissões, sem re-delegação).
 */
import type Anthropic from "@anthropic-ai/sdk"

import { config } from "../config.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import {
  truncar,
  type AgentProgressEvent,
} from "./progress.js"
import type { SystemAccess } from "./access.js"
import type { AnthropicTool } from "./tool-types.js"

export const MULTI_AGENT_TOOL = "dexter__spawn_subagent"

export const MULTI_AGENT_MAX_SPAWNS_PER_RUN = 3

const SUB_AGENT_MAX_STEPS = 12
const SUB_AGENT_MAX_ROUNDS = 6

const SUB_AGENT_SYSTEM = `Você é um sub-agente do Dexter executando UMA subtarefa focada.

Regras:
- Entregue só o resultado factual pedido — sem preâmbulo nem meta-comentário.
- Use tools dos sistemas disponíveis (schema → SQL denso quando couber).
- NÃO chame dexter__spawn_subagent (delegação desligada neste nível).
- Português do Brasil. Tabelas markdown quando houver dados.
- Se faltar dado, diga o que tentou e o que falta.`

export function isMultiAgentToolName(name: string): boolean {
  return name === MULTI_AGENT_TOOL
}

export function buildMultiAgentTools(): AnthropicTool[] {
  return [
    {
      name: MULTI_AGENT_TOOL,
      description:
        "[Dexter · Multi-agentes] Delega uma subtarefa INDEPENDENTE a um sub-agente " +
        "especializado (mesmas permissões do usuário). Use quando o pedido se divide " +
        "em blocos paralelos (ex.: cruzar GoDash + NetworkGo + Notion). Cada spawn " +
        "retorna um relatório factual — VOCÊ consolida a resposta final ao usuário. " +
        "Não use para uma única consulta simples. Máx. 3 spawns por resposta.",
      input_schema: {
        type: "object",
        properties: {
          objetivo: {
            type: "string",
            description:
              "O que o sub-agente deve entregar (específico e verificável).",
          },
          contexto: {
            type: "string",
            description:
              "Contexto mínimo que o sub-agente precisa (IDs, período, entidades).",
          },
        },
        required: ["objetivo"],
      },
    },
  ]
}

export function describeMultiAgentTool(name: string): {
  slug: string
  fn: string
  systemLabel: string
  toolLabel: string
  label: string
} {
  return {
    slug: "dexter",
    fn: "spawn_subagent",
    systemLabel: "Dexter",
    toolLabel: "Sub-agente",
    label:
      name === MULTI_AGENT_TOOL
        ? "Delegando a um sub-agente"
        : "Multi-agentes",
  }
}

export interface SubAgentRunParams {
  objetivo: string
  contexto?: string
  model: string
  access: SystemAccess[]
  connectors?: ConnectorRuntime
  userId: string
  email: string
  /** Projeto do chat pai — o sub-agente lê os mesmos arquivos. */
  projectId?: string
  apiKey?: string
  signal?: AbortSignal
  onProgress?: (evt: AgentProgressEvent) => void
}

function forwardSubProgress(
  onProgress: SubAgentRunParams["onProgress"],
  evt: AgentProgressEvent,
): void {
  if (!onProgress) return
  if (evt.type === "status") {
    onProgress({ type: "status", text: `Sub-agente: ${evt.text}` })
    return
  }
  if (evt.type === "thinking") {
    onProgress({ type: "thinking", text: truncar(evt.text, 120) })
    return
  }
  if (evt.type === "tool_call_start") {
    onProgress({
      ...evt,
      label: `Sub-agente · ${evt.label}`,
    })
    return
  }
  if (evt.type === "tool_call_end") {
    onProgress({
      ...evt,
      summary: truncar(`Sub: ${evt.summary}`, 280),
    })
  }
}

/** Executa um sub-loop agêntico e devolve texto consolidado para o agente pai. */
export async function runSubAgent(
  params: SubAgentRunParams,
): Promise<{ ok: boolean; text: string; steps: number; error?: string }> {
  const objetivo = String(params.objetivo ?? "").trim()
  if (!objetivo) {
    return { ok: false, text: "", steps: 0, error: "objetivo vazio" }
  }

  const contexto = params.contexto?.trim()
  const userContent = contexto
    ? `Objetivo:\n${objetivo}\n\nContexto:\n${contexto}`
    : `Objetivo:\n${objetivo}`

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ]

  let collected = ""
  let steps = 0

  // Import dinâmico evita ciclo agent-loop ↔ tools ↔ multi-agent.
  const { runAgentLoop } = await import("./agent-loop.js")

  try {
    const result = await runAgentLoop({
      model: params.model,
      systemPrompt: SUB_AGENT_SYSTEM,
      messages,
      access: params.access,
      connectors: params.connectors,
      userId: params.userId,
      email: params.email,
      projectId: params.projectId,
      apiKey: params.apiKey,
      signal: params.signal,
      multiAgentEnabled: false,
      onTextDelta: (t) => {
        collected += t
      },
      onToolCall: () => {},
      onProgress: (evt) => forwardSubProgress(params.onProgress, evt),
      maxSteps: SUB_AGENT_MAX_STEPS,
      maxRounds: SUB_AGENT_MAX_ROUNDS,
    })
    steps = result.steps
    const text = collected.trim()
    if (!text) {
      return {
        ok: false,
        text: "",
        steps,
        error: "sub-agente não produziu texto",
      }
    }
    const max = config.AGENT_TOOL_RESULT_MAX_CHARS
    const payload =
      text.length > max
        ? `${text.slice(0, max)}\n…[truncado — peça ao sub-agente um recorte mais focado]`
        : text
    return { ok: true, text: payload, steps }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, text: collected.trim(), steps, error: msg }
  }
}
