/**
 * Passos do agente (o que o Dexter está fazendo) no formato que a UI consome.
 *
 * A fonte é o `event: progress` do SSE (ao vivo) e `GET /api/chats/:id/steps`
 * (histórico, reconstruído da auditoria). Aqui os dois viram o mesmo `RunStep`.
 */
import type { AgentProgressEvent, AgentStepWire } from "@/lib/agentcore/contract"

export type RunStepStatus = "running" | "ok" | "error"

export interface RunStep {
  /** id do bloco tool_use (ao vivo) ou da auditoria (histórico). */
  id: string
  step: number
  tool: string
  system?: string
  systemLabel?: string
  toolLabel?: string
  /** Frase pronta, ex.: "Consultando PipeGo · Consulta SQL (read-only)". */
  label: string
  argsSummary?: string
  status: RunStepStatus
  durationMs?: number
  rows?: number
  summary?: string
  /** `performance`-independente: usado para cronometrar o passo em andamento. */
  startedAt: number
}

export interface RunProgress {
  steps: RunStep[]
  /** Fase atual quando não há tool rodando (ex.: "Gerando resposta"). */
  statusText?: string
  /** Último trecho de raciocínio, quando o modelo expõe (senão, ausente). */
  thinking?: string
  startedAt: number
  finishedAt?: number
  /** Segundos sem evento SSE — aviso de possível travamento. */
  stalledSeconds?: number
}

export function progressoVazio(startedAt = Date.now()): RunProgress {
  return { steps: [], startedAt }
}

/** Converte um passo persistido (histórico) para o formato da UI. */
export function stepFromWire(wire: AgentStepWire): RunStep {
  return {
    id: wire.id,
    step: wire.step,
    tool: wire.tool,
    ...(wire.system ? { system: wire.system } : {}),
    ...(wire.system_label ? { systemLabel: wire.system_label } : {}),
    ...(wire.tool_label ? { toolLabel: wire.tool_label } : {}),
    label: wire.label,
    ...(wire.args_summary ? { argsSummary: wire.args_summary } : {}),
    status: wire.status,
    ...(wire.duration_ms !== undefined ? { durationMs: wire.duration_ms } : {}),
    ...(wire.rows !== undefined ? { rows: wire.rows } : {}),
    summary: wire.summary,
    startedAt: wire.created_at ? Date.parse(wire.created_at) : 0,
  }
}

/**
 * Aplica um evento de progresso, devolvendo um NOVO objeto (identidade nova só
 * quando algo mudou de fato — o painel re-renderiza sem depender dos deltas de
 * texto).
 */
export function aplicarProgresso(
  atual: RunProgress,
  evento: AgentProgressEvent,
): RunProgress {
  switch (evento.type) {
    case "status":
      if (atual.statusText === evento.text) return atual
      return { ...atual, statusText: evento.text }

    case "thinking":
      return { ...atual, thinking: evento.text }

    case "tool_call_start": {
      const novo: RunStep = {
        id: evento.id,
        step: evento.step,
        tool: evento.tool,
        ...(evento.system ? { system: evento.system } : {}),
        ...(evento.system_label ? { systemLabel: evento.system_label } : {}),
        ...(evento.tool_label ? { toolLabel: evento.tool_label } : {}),
        label: evento.label,
        ...(evento.args_summary ? { argsSummary: evento.args_summary } : {}),
        status: "running",
        startedAt: Date.now(),
      }
      return {
        ...atual,
        statusText: evento.label,
        steps: [...atual.steps.filter((s) => s.id !== novo.id), novo],
      }
    }

    case "tool_call_end": {
      let encontrou = false
      const steps = atual.steps.map((s) => {
        if (s.id !== evento.id) return s
        encontrou = true
        return {
          ...s,
          status: evento.status,
          durationMs: evento.duration_ms,
          ...(evento.rows !== undefined ? { rows: evento.rows } : {}),
          summary: evento.summary,
        }
      })
      if (!encontrou) {
        steps.push({
          id: evento.id,
          step: evento.step,
          tool: evento.tool,
          label: evento.tool,
          status: evento.status,
          durationMs: evento.duration_ms,
          ...(evento.rows !== undefined ? { rows: evento.rows } : {}),
          summary: evento.summary,
          startedAt: Date.now() - evento.duration_ms,
        })
      }
      return { ...atual, steps }
    }

    default:
      return atual
  }
}

/** Duração humana curta: "0,8s", "12s", "1m 03s". */
export function formatarDuracao(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${ms}ms`
  const segundos = ms / 1000
  if (segundos < 10) return `${segundos.toFixed(1).replace(".", ",")}s`
  if (segundos < 60) return `${Math.round(segundos)}s`
  const minutos = Math.floor(segundos / 60)
  const resto = Math.round(segundos % 60)
  return `${minutos}m ${String(resto).padStart(2, "0")}s`
}
