/**
 * Chamadas HTTP para /api/workflows — rotinas que o Dexter executa sozinho no
 * horário agendado e entrega como conversa (CRUD, execução manual, histórico).
 */
import { getAccessToken } from "@/lib/supabase/auth"

const BASE_URL = "/api"

/** Fuso padrão do produto quando o navegador não informa nada utilizável. */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo"

/** Teto por usuário imposto pelo AgentCore — a UI avisa antes de tentar. */
export const WORKFLOW_LIMIT = 20

export type WorkflowScheduleFreq = "daily" | "weekly" | "monthly" | "once"

export interface WorkflowSchedule {
  freq: WorkflowScheduleFreq
  /** "HH:mm" no timezone do workflow. */
  time: string
  /** 1 = segunda … 7 = domingo (apenas em freq "weekly"). */
  weekdays?: number[]
  /** 1–28 (apenas em freq "monthly"). */
  day_of_month?: number
  /** "YYYY-MM-DD" (apenas em freq "once"). */
  date?: string
}

export type WorkflowRunStatus = "running" | "success" | "error"
export type WorkflowRunTrigger = "schedule" | "manual"

export interface WorkflowRun {
  id: string
  status: WorkflowRunStatus
  trigger: WorkflowRunTrigger
  started_at: string
  finished_at: string | null
  /** Conversa gerada pela execução — nula enquanto o run não a cria. */
  chat_id: string | null
  error: string | null
}

export interface Workflow {
  id: string
  name: string
  description: string | null
  prompt: string
  schedule: WorkflowSchedule
  timezone: string
  enabled: boolean
  model_id: string | null
  next_run_at: string | null
  last_run_at: string | null
  created_at: string
  updated_at: string
  lastRun?: WorkflowRun | null
}

export interface CreateWorkflowInput {
  name: string
  description?: string | null
  prompt: string
  schedule: WorkflowSchedule
  timezone?: string
  enabled?: boolean
  model_id?: string | null
}

export type UpdateWorkflowInput = Partial<CreateWorkflowInput>

/**
 * Erro de API com o status HTTP preservado: a UI precisa distinguir o 409
 * ("já está em execução") de uma falha genérica.
 */
export class WorkflowApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "WorkflowApiError"
    this.status = status
  }
}

async function authHeaders(json = false): Promise<Record<string, string>> {
  const token = await getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json) headers["Content-Type"] = "application/json"
  return headers
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }
    if (body.message) return body.message
  } catch {
    /* ignore */
  }
  return fallback
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = "GET", body, signal } = options
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: await authHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    // Abort é fluxo normal (troca de página): quem chamou checa o signal.
    if (signal?.aborted) throw err
    throw new WorkflowApiError(
      "AgentCore inacessível. Confirme que o backend está rodando (porta 8787).",
      0,
    )
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new WorkflowApiError("Sessão inválida. Faça login novamente.", 401)
    }
    // Só a listagem: em `/workflows/:id/...` o 404 é "workflow não existe" e a
    // mensagem do server (em PT) é a que interessa.
    if (response.status === 404 && method === "GET" && path === "/workflows") {
      throw new WorkflowApiError(
        "GET /api/workflows não encontrado (404). Reinicie o AgentCore com o código atual (porta 8787).",
        404,
      )
    }
    throw new WorkflowApiError(
      await parseError(response, `${method} /api${path} respondeu ${response.status}`),
      response.status,
    )
  }
  return (await response.json()) as T
}

export async function fetchWorkflows(signal?: AbortSignal): Promise<Workflow[]> {
  const data = await request<{ workflows?: Workflow[] }>("/workflows", { signal })
  return data.workflows ?? []
}

export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<Workflow> {
  const data = await request<{ workflow: Workflow }>("/workflows", {
    method: "POST",
    body: input,
  })
  return data.workflow
}

export async function updateWorkflow(
  workflowId: string,
  input: UpdateWorkflowInput,
): Promise<Workflow> {
  const data = await request<{ workflow: Workflow }>(`/workflows/${workflowId}`, {
    method: "PATCH",
    body: input,
  })
  return data.workflow
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await request<{ ok: true }>(`/workflows/${workflowId}`, { method: "DELETE" })
}

/** Dispara agora, em background. Lança WorkflowApiError 409 se já rodando. */
export async function runWorkflow(workflowId: string): Promise<WorkflowRun> {
  const data = await request<{ run: WorkflowRun }>(
    `/workflows/${workflowId}/run`,
    { method: "POST" },
  )
  return data.run
}

/** Últimas 20 execuções do workflow, mais recentes primeiro. */
export async function fetchWorkflowRuns(
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowRun[]> {
  const data = await request<{ runs?: WorkflowRun[] }>(
    `/workflows/${workflowId}/runs`,
    { signal },
  )
  return data.runs ?? []
}

/** Fusos aceitos pelo server (offset fixo — ver server/src/lib/schedule.ts). */
const SUPPORTED_TIMEZONES = new Set([
  "America/Noronha",
  "America/Sao_Paulo",
  "America/Bahia",
  "America/Belem",
  "America/Fortaleza",
  "America/Maceio",
  "America/Recife",
  "America/Araguaina",
  "America/Santarem",
  "America/Campo_Grande",
  "America/Cuiaba",
  "America/Manaus",
  "America/Boa_Vista",
  "America/Porto_Velho",
  "America/Rio_Branco",
  "America/Eirunepe",
  "UTC",
  "Etc/UTC",
])

/** Fuso do navegador (IANA) para novos workflows; cai no padrão do produto
 * quando o fuso local não é um dos suportados pelo server. */
export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && SUPPORTED_TIMEZONES.has(tz) ? tz : DEFAULT_TIMEZONE
  } catch {
    return DEFAULT_TIMEZONE
  }
}
