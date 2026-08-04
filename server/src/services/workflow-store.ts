/**
 * Persistência dos workflows agendados via Supabase (service role).
 * Tabelas (projeto "agentcore"): agent_workflows, agent_workflow_runs.
 * Tudo escopado por user_id — service_role bypassa RLS, então a checagem de
 * ownership é obrigatória no código (anti-IDOR).
 */
import {
  computeNextRun,
  DEFAULT_TIMEZONE,
  normalizeSchedule,
  parseSchedule,
  type WorkflowSchedule,
} from "../lib/schedule.js"
import { supabase } from "../lib/supabase.js"
import { NotFoundError } from "./auth.js"

/** Teto por usuário — cada workflow custa execuções de modelo no agendador. */
export const MAX_WORKFLOWS_PER_USER = 20
/** Janela do claim: se a réplica morrer no meio, outra reassume depois disso.
 * Tem que cobrir o TICK inteiro do runner, não uma execução: o lote claimado
 * roda em série (até 3 workflows × 5 min de teto cada), então o último do lote
 * só começa ~10 min depois do claim — com lock menor que isso outra réplica
 * reclamaria a mesma linha e a run sairia duplicada. */
const LOCK_MINUTES = 20
/** Runs listadas por workflow no histórico. */
const RUNS_DEFAULT_LIMIT = 20
/** Run 'running' mais velha que isso é considerada órfã (processo morreu). */
const STALE_RUN_MINUTES = 15

export type WorkflowRunStatus = "running" | "success" | "error"
export type WorkflowRunTrigger = "schedule" | "manual"

export interface WorkflowRecord {
  id: string
  name: string
  description: string
  prompt: string
  schedule: WorkflowSchedule
  timezone: string
  enabled: boolean
  model_id: string | null
  next_run_at: string | null
  last_run_at: string | null
  created_at: string
  updated_at: string
}

/** Linha completa (com dono) — usada pelo runner. */
export interface WorkflowJob extends WorkflowRecord {
  user_id: string
}

export interface WorkflowRunRecord {
  id: string
  workflow_id: string
  status: WorkflowRunStatus
  trigger: WorkflowRunTrigger
  started_at: string
  finished_at: string | null
  chat_id: string | null
  error: string | null
}

export interface WorkflowWithLastRun extends WorkflowRecord {
  lastRun: WorkflowRunRecord | null
}

export interface CreateWorkflowParams {
  userId: string
  name: string
  description?: string
  prompt: string
  schedule: WorkflowSchedule
  timezone?: string
  enabled?: boolean
  modelId?: string | null
}

export interface UpdateWorkflowParams {
  name?: string
  description?: string
  prompt?: string
  schedule?: WorkflowSchedule
  timezone?: string
  enabled?: boolean
  modelId?: string | null
}

const COLUMNS =
  "id, user_id, name, description, prompt, schedule, timezone, enabled, " +
  "model_id, next_run_at, last_run_at, created_at, updated_at"

const RUN_COLUMNS =
  "id, workflow_id, status, trigger, started_at, finished_at, chat_id, error"

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/** Linha crua do PostgREST → WorkflowJob (o select usa lista de colunas
 * montada em runtime, então o supabase-js não infere o tipo da linha). */
function mapJob(row: unknown): WorkflowJob {
  const raw = row as Record<string, unknown>
  return {
    ...(raw as unknown as WorkflowJob),
    // O jsonb foi validado na escrita; legado/estranho volta como veio.
    schedule:
      parseSchedule(raw.schedule) ?? (raw.schedule as WorkflowSchedule),
  }
}

/** Remove o user_id — o que vai para o front. */
function toPublic(job: WorkflowJob): WorkflowRecord {
  const { user_id: _userId, ...rest } = job
  return rest
}

/** next_run_at de um workflow: null quando desativado ou 'once' já passado. */
function nextRunIso(
  schedule: WorkflowSchedule,
  timezone: string,
  enabled: boolean,
  from: Date = new Date(),
): string | null {
  if (!enabled) return null
  const next = computeNextRun(schedule, timezone, from)
  return next ? next.toISOString() : null
}

/** Workflows do usuário (mais recentes primeiro) com a última run resumida. */
export async function listWorkflows(
  userId: string,
): Promise<WorkflowWithLastRun[]> {
  const { data, error } = await supabase
    .from("agent_workflows")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`listWorkflows falhou: ${error.message}`)
  }

  const jobs = (data ?? []).map((row) => mapJob(row))
  if (jobs.length === 0) return []

  // Uma consulta por workflow (limite 1, índice workflow_id+started_at desc).
  // São no máximo MAX_WORKFLOWS_PER_USER e correm em paralelo — mais barato que
  // trazer o histórico todo só para achar a última de cada um.
  const ultimas = await Promise.all(
    jobs.map((job) => lastRun(job.id, userId)),
  )

  return jobs.map((job, i) => ({
    ...toPublic(job),
    lastRun: ultimas[i] ?? null,
  }))
}

/** Última execução (qualquer status) de um workflow do próprio usuário. */
export async function lastRun(
  workflowId: string,
  userId: string,
): Promise<WorkflowRunRecord | null> {
  const { data, error } = await supabase
    .from("agent_workflow_runs")
    .select(RUN_COLUMNS)
    .eq("workflow_id", workflowId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`lastRun falhou: ${error.message}`)
  }
  return (data as WorkflowRunRecord | null) ?? null
}

/** Workflow do próprio usuário — inexistente/de outro dono → null. */
export async function getWorkflow(
  workflowId: string,
  userId: string,
): Promise<WorkflowJob | null> {
  const { data, error } = await supabase
    .from("agent_workflows")
    .select(COLUMNS)
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    throw new Error(`getWorkflow falhou: ${error.message}`)
  }
  if (!data) return null
  return mapJob(data)
}

export async function countWorkflows(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("agent_workflows")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)

  if (error) {
    throw new Error(`countWorkflows falhou: ${error.message}`)
  }
  return count ?? 0
}

/** Cria o workflow já com o próximo disparo calculado. */
export async function createWorkflow(
  params: CreateWorkflowParams,
): Promise<WorkflowRecord> {
  const total = await countWorkflows(params.userId)
  if (total >= MAX_WORKFLOWS_PER_USER) {
    throw badRequest(
      `Você já tem ${MAX_WORKFLOWS_PER_USER} workflows — o limite por usuário. Exclua um antes de criar outro.`,
    )
  }

  const schedule = normalizeSchedule(params.schedule)
  const timezone = params.timezone?.trim() || DEFAULT_TIMEZONE
  const enabled = params.enabled ?? true

  const { data, error } = await supabase
    .from("agent_workflows")
    .insert({
      user_id: params.userId,
      name: params.name.trim(),
      description: params.description?.trim() ?? "",
      prompt: params.prompt.trim(),
      schedule,
      timezone,
      enabled,
      model_id: params.modelId ?? null,
      next_run_at: nextRunIso(schedule, timezone, enabled),
    })
    .select(COLUMNS)
    .single()

  if (error) {
    throw new Error(`createWorkflow falhou: ${error.message}`)
  }
  return toPublic(mapJob(data))
}

/**
 * Atualiza o workflow. next_run_at é recalculado sempre que schedule, timezone
 * ou enabled mudam (e o lock é liberado — o agendamento novo manda).
 */
export async function updateWorkflow(
  workflowId: string,
  userId: string,
  patch: UpdateWorkflowParams,
): Promise<WorkflowRecord> {
  const atual = await getWorkflow(workflowId, userId)
  if (!atual) {
    throw new NotFoundError("Workflow não encontrado.")
  }

  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.description !== undefined) {
    row.description = patch.description.trim()
  }
  if (patch.prompt !== undefined) row.prompt = patch.prompt.trim()
  if (patch.modelId !== undefined) row.model_id = patch.modelId

  const schedule =
    patch.schedule !== undefined
      ? normalizeSchedule(patch.schedule)
      : atual.schedule
  const timezone = patch.timezone?.trim() || atual.timezone
  const enabled = patch.enabled ?? atual.enabled

  const agendamentoMudou =
    patch.schedule !== undefined ||
    (patch.timezone !== undefined && timezone !== atual.timezone) ||
    (patch.enabled !== undefined && enabled !== atual.enabled)

  if (patch.schedule !== undefined) row.schedule = schedule
  if (patch.timezone !== undefined) row.timezone = timezone
  if (patch.enabled !== undefined) row.enabled = enabled
  if (agendamentoMudou) {
    row.next_run_at = nextRunIso(schedule, timezone, enabled)
    row.locked_until = null
  }

  const { data, error } = await supabase
    .from("agent_workflows")
    .update(row)
    .eq("id", workflowId)
    .eq("user_id", userId)
    .select(COLUMNS)
    .maybeSingle()

  if (error) {
    throw new Error(`updateWorkflow falhou: ${error.message}`)
  }
  if (!data) {
    throw new NotFoundError("Workflow não encontrado.")
  }
  return toPublic(mapJob(data))
}

/** Exclui o workflow (cascade nas runs). Inexistente → false. */
export async function deleteWorkflow(
  workflowId: string,
  userId: string,
): Promise<boolean> {
  const { error, count } = await supabase
    .from("agent_workflows")
    .delete({ count: "exact" })
    .eq("id", workflowId)
    .eq("user_id", userId)

  if (error) {
    throw new Error(`deleteWorkflow falhou: ${error.message}`)
  }
  return (count ?? 0) > 0
}

/** Histórico de execuções de um workflow do próprio usuário. */
export async function listRuns(
  workflowId: string,
  userId: string,
  limit: number = RUNS_DEFAULT_LIMIT,
): Promise<WorkflowRunRecord[]> {
  const { data, error } = await supabase
    .from("agent_workflow_runs")
    .select(RUN_COLUMNS)
    .eq("workflow_id", workflowId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100))

  if (error) {
    throw new Error(`listRuns falhou: ${error.message}`)
  }
  return (data ?? []) as WorkflowRunRecord[]
}

/**
 * Run em andamento deste workflow (guard contra execução paralela).
 * Runs 'running' mais antigas que STALE_RUN_MINUTES são ignoradas: se o
 * processo morreu no meio, elas ficariam penduradas para sempre e travariam
 * qualquer execução nova.
 */
export async function findRunningRun(
  workflowId: string,
  userId: string,
): Promise<WorkflowRunRecord | null> {
  const limite = new Date(
    Date.now() - STALE_RUN_MINUTES * 60_000,
  ).toISOString()
  const { data, error } = await supabase
    .from("agent_workflow_runs")
    .select(RUN_COLUMNS)
    .eq("workflow_id", workflowId)
    .eq("user_id", userId)
    .eq("status", "running")
    .gte("started_at", limite)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`findRunningRun falhou: ${error.message}`)
  }
  return (data as WorkflowRunRecord | null) ?? null
}

export async function createRun(params: {
  workflowId: string
  userId: string
  trigger: WorkflowRunTrigger
}): Promise<WorkflowRunRecord> {
  const { data, error } = await supabase
    .from("agent_workflow_runs")
    .insert({
      workflow_id: params.workflowId,
      user_id: params.userId,
      status: "running",
      trigger: params.trigger,
    })
    .select(RUN_COLUMNS)
    .single()

  if (error) {
    throw new Error(`createRun falhou: ${error.message}`)
  }
  return data as WorkflowRunRecord
}

/** Fecha a run. `error` deve vir sanitizado (sem stack/SQL). */
export async function finishRun(params: {
  runId: string
  status: Exclude<WorkflowRunStatus, "running">
  chatId?: string | null
  error?: string | null
}): Promise<void> {
  const { error } = await supabase
    .from("agent_workflow_runs")
    .update({
      status: params.status,
      finished_at: new Date().toISOString(),
      chat_id: params.chatId ?? null,
      error: params.error ?? null,
    })
    .eq("id", params.runId)

  if (error) {
    throw new Error(`finishRun falhou: ${error.message}`)
  }
}

/**
 * Marca que o workflow rodou e agenda o próximo disparo (sem backfill: parte
 * de `from`, não do horário perdido). Libera o lock do claim.
 */
export async function markWorkflowRan(
  workflow: WorkflowJob,
  from: Date = new Date(),
): Promise<string | null> {
  const nextRunAt = nextRunIso(
    workflow.schedule,
    workflow.timezone,
    workflow.enabled,
    from,
  )
  const { error } = await supabase
    .from("agent_workflows")
    .update({
      last_run_at: from.toISOString(),
      next_run_at: nextRunAt,
      locked_until: null,
    })
    .eq("id", workflow.id)
    .eq("user_id", workflow.user_id)

  if (error) {
    throw new Error(`markWorkflowRan falhou: ${error.message}`)
  }
  return nextRunAt
}

/**
 * Claim dos workflows vencidos: marca `locked_until = now + 10 min` e devolve
 * só as linhas que ESTE processo conseguiu marcar. Multi-réplica: o UPDATE
 * trava a linha e o Postgres reavalia o filtro depois do lock (READ
 * COMMITTED), então a segunda réplica não recebe a linha de volta.
 * A seleção prévia existe só para limitar a quantidade (PostgREST não tem
 * LIMIT em UPDATE).
 */
export async function claimDueWorkflows(
  now: Date = new Date(),
  limit = 3,
): Promise<WorkflowJob[]> {
  const nowIso = now.toISOString()
  const livre = `locked_until.is.null,locked_until.lt.${nowIso}`

  const { data: candidatos, error: selError } = await supabase
    .from("agent_workflows")
    .select("id")
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .or(livre)
    .order("next_run_at", { ascending: true })
    .limit(limit)

  if (selError) {
    throw new Error(`claimDueWorkflows (select) falhou: ${selError.message}`)
  }
  const ids = (candidatos ?? []).map((r) => (r as { id: string }).id)
  if (ids.length === 0) return []

  const lockedUntil = new Date(
    now.getTime() + LOCK_MINUTES * 60_000,
  ).toISOString()

  const { data, error } = await supabase
    .from("agent_workflows")
    .update({ locked_until: lockedUntil })
    .in("id", ids)
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .or(livre)
    .select(COLUMNS)

  if (error) {
    throw new Error(`claimDueWorkflows (update) falhou: ${error.message}`)
  }
  return (data ?? []).map((row) => mapJob(row))
}
