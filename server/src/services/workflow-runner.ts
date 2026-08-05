/**
 * Runner dos workflows agendados.
 *
 * Tick de 60s: faz o claim dos workflows vencidos (no máximo alguns por tick) e
 * executa cada um com as permissões do dono, gravando o resultado como uma
 * conversa nova (agent_chats) — é o "resultado" que o usuário abre depois.
 *
 * Com Redis (item 2.1) o tick só DECIDE o que está vencido: a execução vira job
 * BullMQ com retry (o claim no banco continua sendo a fonte de verdade contra
 * multi-réplica). Sem Redis, executa inline no próprio tick — igual a antes.
 *
 * Sem backfill: se o horário passou (server desligado), o próximo disparo é
 * recalculado a partir de agora — não roda o atrasado várias vezes.
 * Nunca roda o mesmo workflow em paralelo (claim no banco + guard em memória +
 * run 'running' na tabela).
 */
import { randomUUID } from "node:crypto"

import type { FastifyBaseLogger } from "fastify"

import { resolveConnectorRuntime } from "../connectors/status.js"
import { enqueue } from "../lib/queue.js"
import type { ConnectorRuntime } from "../connectors/types.js"
import { isErroSanitizado } from "../lib/erro-modelo.js"
import { isOpenAiCompatibleProvider } from "../lib/openai-compatible.js"
import { formatLocalDayMonth } from "../lib/schedule.js"
import { supabase } from "../lib/supabase.js"
import type { Provider } from "../llm/models.js"
import { getEffectiveKey, isKeyProvider } from "./llm-keys.js"
import { resolveModelForUser } from "./model-access.js"
import { streamChat } from "../llm/router.js"
import {
  DEXTER_SYSTEM_PROMPT,
  flattenSystemPrompt,
  type SystemPromptParts,
} from "../llm/system-prompt.js"
import { runAgentLoop, type ToolCallRecord } from "../systems/agent-loop.js"
import { accessSummary, resolveAccess, type SystemAccess } from "../systems/access.js"
import { auditToolCalls } from "../systems/audit.js"
import { runOpenAiAgentLoop } from "../systems/openai-agent-loop.js"
import { insertMessage, upsertChat } from "./chat-store.js"
import { computeMessageCostUsd } from "./model-pricing.js"
import {
  createRun,
  finishRun,
  claimDueWorkflows,
  findRunningRun,
  getWorkflow,
  markWorkflowRan,
  type WorkflowJob,
  type WorkflowRunRecord,
  type WorkflowRunTrigger,
} from "./workflow-store.js"

/** Intervalo do agendador. */
const TICK_MS = 60_000
/** Workflows executados por tick — evita rajada de chamadas ao modelo. */
const MAX_POR_TICK = 3
/** Teto duro de uma execução agendada (o loop do chat tem o seu próprio). */
const RUN_TIMEOUT_MS = 5 * 60_000
/** Mensagem de erro guardada na run — nunca stack/SQL. */
const ERRO_MAX_CHARS = 400

let timer: NodeJS.Timeout | null = null
let tickEmAndamento = false
/** Workflows rodando NESTE processo (o claim cobre as outras réplicas). */
const emExecucao = new Set<string>()

function log(msg: string, extra?: unknown): void {
  // eslint-disable-next-line no-console
  console.info(`[workflows] ${msg}`, extra ?? "")
}

function logErro(msg: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[workflows] ${msg}`, err instanceof Error ? err.message : err)
}

function conflito(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 })
}

/** Mensagem curta e sem detalhe interno para gravar na run. */
function mensagemErroRun(err: unknown, abortado: boolean): string {
  if (abortado) {
    return "A execução passou do tempo limite (5 minutos) e foi interrompida."
  }
  if (isErroSanitizado(err)) return err.message.slice(0, ERRO_MAX_CHARS)
  const msg = err instanceof Error ? err.message : ""
  if (/overloaded|529/i.test(msg)) {
    return "O modelo estava sobrecarregado no horário do disparo."
  }
  if (/rate.?limit|429|quota/i.test(msg)) {
    return "Limite de requisições do provider atingido nesta execução."
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(msg)) {
    return "A chamada ao modelo demorou demais e foi interrompida."
  }
  if (/context.?length|too many tokens|maximum context/i.test(msg)) {
    return "O contexto ficou grande demais nesta execução. Reduza o escopo das instruções."
  }
  return "Não consegui concluir esta execução. Verifique os logs do AgentCore."
}

/** Email do dono (identidade usada pelas RPCs dos sistemas). */
async function resolveOwnerEmail(userId: string): Promise<string | undefined> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (error) {
      logErro(`email do dono indisponível (user ${userId})`, error)
      return undefined
    }
    return data.user?.email ?? undefined
  } catch (err) {
    logErro(`email do dono indisponível (user ${userId})`, err)
    return undefined
  }
}

function tituloDaExecucao(workflow: WorkflowJob, at: Date): string {
  return `⚡ ${workflow.name} — ${formatLocalDayMonth(at, workflow.timezone)}`
}

/** Base do Dexter fica no bloco estático (cacheável); acesso do dono e dados
 * do workflow mudam por execução, então vão no dinâmico. */
function systemPromptDoWorkflow(
  workflow: WorkflowJob,
  access: SystemAccess[],
): SystemPromptParts {
  return {
    staticBlock: DEXTER_SYSTEM_PROMPT,
    dynamicBlock:
      "## Acesso deste usuário aos sistemas GoWork\n" +
      accessSummary(access) +
      "\n\n## Execução agendada de workflow\n" +
      `Esta é uma execução automática do workflow "${workflow.name}". ` +
      "Execute as instruções e produza a resposta final completa — não há usuário " +
      "para responder perguntas; se faltar informação, explique o que assumiu.",
  }
}

interface ResultadoLoop {
  texto: string
  model: string
  tokensIn?: number
  tokensOut?: number
  toolCalls: ToolCallRecord[]
}

/** Roda o agent loop sem streaming: coleta o texto final e as tool calls. */
async function rodarLoop(params: {
  workflow: WorkflowJob
  email: string
  access: SystemAccess[]
  connectors: ConnectorRuntime
  provider: Provider
  model: string
  systemPrompt: SystemPromptParts
  signal: AbortSignal
  apiKey?: string
}): Promise<ResultadoLoop> {
  let texto = ""
  const toolCalls: ToolCallRecord[] = []
  const onTextDelta = (t: string): void => {
    texto += t
  }
  const onToolCall = (rec: ToolCallRecord): void => {
    toolCalls.push(rec)
  }
  const comum = {
    model: params.model,
    systemPrompt: params.systemPrompt,
    access: params.access,
    connectors: params.connectors,
    userId: params.workflow.user_id,
    email: params.email,
    signal: params.signal,
    apiKey: params.apiKey,
    onTextDelta,
    onToolCall,
    // Sem UI para acompanhar — progresso é descartado.
    onProgress: () => {},
  }

  if (params.provider === "anthropic") {
    const r = await runAgentLoop({
      ...comum,
      messages: [{ role: "user", content: params.workflow.prompt }],
    })
    return {
      texto,
      model: r.model,
      tokensIn: r.inputTokens,
      tokensOut: r.outputTokens,
      toolCalls,
    }
  }

  if (isOpenAiCompatibleProvider(params.provider)) {
    const r = await runOpenAiAgentLoop({
      ...comum,
      provider: params.provider,
      messages: [{ role: "user", content: params.workflow.prompt }],
    })
    return {
      texto,
      model: r.model,
      tokensIn: r.inputTokens,
      tokensOut: r.outputTokens,
      toolCalls,
    }
  }

  // Ollama — streaming simples, sem tools.
  const handle = streamChat({
    provider: "ollama",
    model: params.model,
    systemPrompt: flattenSystemPrompt(params.systemPrompt),
    messages: [{ role: "user", content: params.workflow.prompt }],
    signal: params.signal,
  })
  for await (const delta of handle.textDeltas) {
    texto += delta
  }
  const r = await handle.result()
  return {
    texto,
    model: r.model,
    tokensIn: r.inputTokens,
    tokensOut: r.outputTokens,
    toolCalls,
  }
}

/**
 * Executa o workflow de ponta a ponta: cria a conversa, roda o loop, persiste
 * mensagens/auditoria, fecha a run e reagenda o próximo disparo.
 * Nunca lança: a falha vira `status = 'error'` na run e o workflow segue vivo.
 */
export async function runWorkflow(
  workflow: WorkflowJob,
  trigger: WorkflowRunTrigger,
  runExistente?: WorkflowRunRecord,
): Promise<void> {
  if (emExecucao.has(workflow.id)) {
    log(`workflow ${workflow.id} já está em execução neste processo — ignorado`)
    // Run já aberta (disparo manual que perdeu a corrida) não pode ficar
    // pendurada em 'running' — fecha aqui mesmo.
    if (runExistente) {
      await finishRun({
        runId: runExistente.id,
        status: "error",
        error: "Este workflow já estava em execução.",
      }).catch((err) => {
        logErro(`não consegui fechar a run ${runExistente.id}`, err)
      })
    }
    return
  }
  emExecucao.add(workflow.id)

  let run: WorkflowRunRecord
  try {
    run = runExistente ?? (await createRun({
      workflowId: workflow.id,
      userId: workflow.user_id,
      trigger,
    }))
  } catch (err) {
    emExecucao.delete(workflow.id)
    logErro(`não consegui abrir a run do workflow ${workflow.id}`, err)
    return
  }

  const iniciado = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
  let chatId: string | null = null

  try {
    const email = await resolveOwnerEmail(workflow.user_id)
    const [access, connectors, modelInfo] = await Promise.all([
      email ? resolveAccess(email) : Promise.resolve([] as SystemAccess[]),
      resolveConnectorRuntime(workflow.user_id),
      resolveModelForUser(workflow.model_id ?? undefined, {
        userId: workflow.user_id,
      }),
    ])

    const agora = new Date()
    chatId = randomUUID()
    await upsertChat({
      id: chatId,
      userId: workflow.user_id,
      agent: "dexter",
      channel: "web",
      title: tituloDaExecucao(workflow, agora),
      projectId: null,
      model: modelInfo.id,
    })
    await insertMessage({
      chatId,
      userId: workflow.user_id,
      role: "user",
      content: workflow.prompt,
    })

    const resultado = await rodarLoop({
      workflow,
      email: email ?? "",
      access,
      connectors,
      provider: modelInfo.provider,
      model: modelInfo.model,
      systemPrompt: systemPromptDoWorkflow(workflow, access),
      signal: controller.signal,
      apiKey: isKeyProvider(modelInfo.provider)
        ? await getEffectiveKey(modelInfo.provider, workflow.user_id)
        : undefined,
    })

    const conteudo =
      resultado.texto.trim() ||
      "_(a execução terminou sem texto do modelo — veja os passos)_"
    const costUsd = await computeMessageCostUsd(
      modelInfo.id,
      resultado.tokensIn,
      resultado.tokensOut,
    )
    const messageId = await insertMessage({
      chatId,
      userId: workflow.user_id,
      role: "assistant",
      content: conteudo,
      model: resultado.model,
      tokensIn: resultado.tokensIn,
      tokensOut: resultado.tokensOut,
      costUsd,
    })

    if (resultado.toolCalls.length > 0) {
      try {
        await auditToolCalls(
          resultado.toolCalls.map((tc) => ({
            chatId: chatId as string,
            userId: workflow.user_id,
            messageId,
            toolName: tc.toolName,
            input: tc.input,
            output: tc.ok ? tc.output : { error: tc.error },
            status: tc.ok ? ("ok" as const) : ("error" as const),
            durationMs: tc.durationMs,
          })),
        )
      } catch (err) {
        logErro(`auditoria das tool calls falhou (run ${run.id})`, err)
      }
    }

    await finishRun({ runId: run.id, status: "success", chatId })
    const proximo = await markWorkflowRan(workflow)
    log(
      `run ${run.id} ok — workflow "${workflow.name}" (${trigger}), ` +
        `${resultado.toolCalls.length} tools, ${Date.now() - iniciado}ms, ` +
        `chat ${chatId}, próximo ${proximo ?? "nenhum"}`,
    )
  } catch (err) {
    const message = mensagemErroRun(err, controller.signal.aborted)
    logErro(`run ${run.id} falhou — workflow "${workflow.name}"`, err)
    // A conversa já foi criada com a instrução do usuário. Sem escrever nada
    // aqui ela fica órfã na lista de conversas (pergunta sem resposta) —
    // acontece sempre que o loop estoura os 5 min ou o provider falha.
    if (chatId) {
      try {
        await insertMessage({
          chatId,
          userId: workflow.user_id,
          role: "assistant",
          content: `_Execução interrompida: ${message}_`,
        })
      } catch (msgErr) {
        logErro(`não consegui gravar o erro no chat ${chatId}`, msgErr)
      }
    }
    try {
      await finishRun({ runId: run.id, status: "error", chatId, error: message })
    } catch (finishErr) {
      logErro(`não consegui fechar a run ${run.id}`, finishErr)
    }
    // O agendamento segue em frente mesmo com erro — um disparo ruim não pode
    // travar o workflow para sempre.
    try {
      await markWorkflowRan(workflow)
    } catch (schedErr) {
      logErro(`não consegui reagendar o workflow ${workflow.id}`, schedErr)
    }
  } finally {
    clearTimeout(timeout)
    emExecucao.delete(workflow.id)
  }
}

/**
 * Disparo manual (botão "Executar agora"): abre a run, responde na hora e
 * segue em background. 409 se já houver execução em andamento.
 */
export async function startManualRun(
  workflow: WorkflowJob,
): Promise<WorkflowRunRecord> {
  if (emExecucao.has(workflow.id)) {
    throw conflito("Este workflow já está em execução.")
  }
  const running = await findRunningRun(workflow.id, workflow.user_id)
  if (running) {
    throw conflito("Este workflow já está em execução.")
  }

  const run = await createRun({
    workflowId: workflow.id,
    userId: workflow.user_id,
    trigger: "manual",
  })
  void runWorkflow(workflow, "manual", run).catch((err) => {
    logErro(`execução manual do workflow ${workflow.id} falhou`, err)
  })
  return run
}

/** Payload do job `workflow-run` (só ids — a linha é relida no worker). */
export interface WorkflowRunJobData {
  workflowId: string
  userId: string
  trigger: WorkflowRunTrigger
  /** ISO do claim que originou o job — compõe o jobId (dedupe do mesmo claim). */
  claimedAt: string
}

/**
 * Consumo do job: relê o workflow (a linha pode ter sido editada/desativada
 * entre o claim e o processamento) e executa. Lançar aqui é o que faz o BullMQ
 * tentar de novo — por isso só o que é infraestrutura (workflow sumido, erro de
 * leitura) sobe; falha de modelo já é tratada dentro de `runWorkflow` e vira
 * `status = 'error'` na run.
 */
export async function executarJobDeWorkflow(
  data: WorkflowRunJobData,
  jobLog: FastifyBaseLogger,
): Promise<void> {
  const workflow = await getWorkflow(data.workflowId, data.userId)
  if (!workflow) {
    jobLog.warn(
      { workflowId: data.workflowId },
      "workflow do job não existe mais — nada a executar",
    )
    return
  }
  await runWorkflow(workflow, data.trigger)
}

/**
 * Manda a execução para a fila (com retry) ou roda inline quando não há Redis.
 * Nunca lança: o tick não pode morrer por causa de um workflow.
 */
async function despacharExecucao(
  workflow: WorkflowJob,
  trigger: WorkflowRunTrigger,
  claimedAt: string,
): Promise<void> {
  const data: WorkflowRunJobData = {
    workflowId: workflow.id,
    userId: workflow.user_id,
    trigger,
    claimedAt,
  }
  try {
    const enfileirou = await enqueue("workflow-run", data, {
      jobId: `workflow:${workflow.id}:${claimedAt}`,
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
    })
    if (enfileirou) {
      log(`workflow "${workflow.name}" enfileirado (claim ${claimedAt})`)
      return
    }
    await runWorkflow(workflow, trigger)
  } catch (err) {
    // runWorkflow já trata os erros dele; aqui é só rede de segurança.
    logErro(`execução agendada do workflow ${workflow.id} falhou`, err)
  }
}

async function tick(): Promise<void> {
  if (tickEmAndamento) return
  tickEmAndamento = true
  try {
    const agora = new Date()
    const vencidos = await claimDueWorkflows(agora, MAX_POR_TICK)
    if (vencidos.length === 0) return
    log(`${vencidos.length} workflow(s) vencido(s) neste tick`)
    const claimedAt = agora.toISOString()
    for (const workflow of vencidos) {
      await despacharExecucao(workflow, "schedule", claimedAt)
    }
  } catch (err) {
    logErro("tick do agendador falhou", err)
  } finally {
    tickEmAndamento = false
  }
}

/** Liga o agendador (idempotente). O timer é `unref` — não segura o processo. */
export function startWorkflowRunner(): void {
  if (timer) return
  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  timer.unref()
  log(`agendador iniciado (tick ${TICK_MS / 1000}s, até ${MAX_POR_TICK} por tick)`)
}

export function stopWorkflowRunner(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  log("agendador parado")
}
