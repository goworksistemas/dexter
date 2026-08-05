/**
 * Infraestrutura de fila (BullMQ + Redis) do AgentCore.
 *
 * REGRA CENTRAL: a fila é um UPGRADE, não uma dependência. Sem `REDIS_URL`
 * (dev local, ou Redis fora do ar no boot) `isQueueEnabled()` devolve false e
 * quem chama executa o trabalho inline, exatamente como antes desta camada
 * existir. Nada aqui pode lançar para o caminho do usuário.
 *
 * Topologia: uma fila por tipo de trabalho (`QUEUE_NAMES`), com os workers no
 * MESMO processo Fastify (iniciados no boot, fechados no `onClose`). Multi-
 * réplica é seguro porque o próprio BullMQ entrega cada job a um único worker.
 *
 * Observabilidade: `registerWorker` embrulha todo handler com log estruturado
 * de início/fim/falha (jobId, fila, tentativa, duração) — é o que permite
 * responder "o job rodou?" sem painel novo.
 */
import type { FastifyBaseLogger } from "fastify"
import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq"
import IORedis, { type Redis } from "ioredis"

import { config } from "../config.js"

/** Filas do AgentCore. Uma por tipo de trabalho — facilita ler os contadores. */
export const QUEUE_NAMES = [
  "chat-summary",
  "message-embeddings",
  "workflow-run",
] as const
export type QueueName = (typeof QUEUE_NAMES)[number]

/** Prefixo das chaves no Redis — isola do rate limit e de outros usos. */
const PREFIX = "agentcore"

/**
 * Jobs concluídos/falhados são mantidos só o suficiente para diagnóstico —
 * sem isso o Redis vira um histórico infinito de payloads.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 3_600, count: 200 },
  removeOnFail: { age: 24 * 3_600, count: 500 },
}

let connection: Redis | null = null
/** Depois do shutdown nada mais pode reabrir conexão (enqueue tardio → inline). */
let filaEncerrada = false
const queues = new Map<QueueName, Queue>()
const workers: Worker[] = []

/** A fila está disponível neste processo? (única checagem que os callers fazem) */
export function isQueueEnabled(): boolean {
  return Boolean(config.REDIS_URL) && !filaEncerrada
}

/**
 * Conexão compartilhada com o Redis. `maxRetriesPerRequest: null` é exigência
 * do BullMQ (o worker fica bloqueado em BRPOPLPUSH; com retry finito o ioredis
 * mataria o comando). Erros de conexão viram log, nunca exceção não tratada.
 */
export function getRedis(): Redis | null {
  // Depois do onClose ninguém reabre socket: um enqueue/rate-limit atrasado
  // durante o shutdown deixaria o processo pendurado esperando o Redis.
  if (!config.REDIS_URL || filaEncerrada) return null
  if (connection) return connection
  connection = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  })
  connection.on("error", (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[queue] Redis indisponível:",
      err instanceof Error ? err.message : err,
    )
  })
  return connection
}

/**
 * Teto para qualquer comando que o caminho do usuário espera. Com REDIS_URL
 * configurada mas o Redis fora do ar, o ioredis enfileira o comando offline e a
 * promise ficaria pendurada — aqui ela vira "não deu" e quem chamou executa
 * inline. É o que mantém a regra "a fila é upgrade, não dependência".
 */
const COMANDO_TIMEOUT_MS = 5_000

export async function comTimeout<T>(
  promessa: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promessa,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Redis não respondeu em ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function connectionOptions(): ConnectionOptions | null {
  const redis = getRedis()
  return redis ? (redis as unknown as ConnectionOptions) : null
}

function getQueue(name: QueueName): Queue | null {
  if (!isQueueEnabled()) return null
  const existente = queues.get(name)
  if (existente) return existente
  const conn = connectionOptions()
  if (!conn) return null
  const fila = new Queue(name, {
    connection: conn,
    prefix: PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
  queues.set(name, fila)
  return fila
}

/**
 * Enfileira um job. Devolve `false` quando não há fila (ou o enqueue falhou) —
 * o chamador então executa inline. NUNCA lança.
 */
export async function enqueue<T extends object>(
  name: QueueName,
  data: T,
  opts?: JobsOptions & { jobId?: string },
): Promise<boolean> {
  const fila = getQueue(name)
  if (!fila) return false
  try {
    await comTimeout(fila.add(name, data, opts), COMANDO_TIMEOUT_MS)
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[queue] enqueue em ${name} falhou (segue inline):`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

export interface WorkerOptions {
  /** Jobs simultâneos por processo. Trabalho que chama LLM fica baixo. */
  concurrency?: number
}

/**
 * Registra um worker desta fila no processo atual, com log de ciclo de vida.
 * No-op quando a fila está desligada.
 */
export function registerWorker<T extends object>(
  name: QueueName,
  handler: (data: T, ctx: { jobId: string; log: FastifyBaseLogger }) => Promise<void>,
  log: FastifyBaseLogger,
  opts: WorkerOptions = {},
): void {
  const conn = connectionOptions()
  if (!isQueueEnabled() || !conn) return

  const worker = new Worker(
    name,
    async (job) => {
      const jobId = String(job.id ?? "sem-id")
      const iniciado = Date.now()
      log.info(
        { queue: name, jobId, attempt: job.attemptsMade + 1 },
        "job iniciado",
      )
      await handler(job.data as T, { jobId, log })
      log.info(
        { queue: name, jobId, durationMs: Date.now() - iniciado },
        "job concluído",
      )
    },
    {
      connection: conn,
      prefix: PREFIX,
      concurrency: opts.concurrency ?? 2,
    },
  )

  worker.on("failed", (job, err) => {
    log.error(
      {
        err,
        queue: name,
        jobId: String(job?.id ?? "sem-id"),
        attempt: (job?.attemptsMade ?? 0) + 1,
      },
      "job falhou",
    )
  })
  worker.on("error", (err) => {
    log.warn({ err, queue: name }, "erro no worker da fila")
  })

  workers.push(worker)
}

export interface QueueCounts {
  name: QueueName
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

/** Contadores das filas para a rota admin. Fila desligada → lista vazia. */
export async function queueCounts(): Promise<QueueCounts[]> {
  if (!isQueueEnabled()) return []
  const out: QueueCounts[] = []
  for (const name of QUEUE_NAMES) {
    const fila = getQueue(name)
    if (!fila) continue
    try {
      const c = await comTimeout(
        fila.getJobCounts(
          "waiting",
          "active",
          "completed",
          "failed",
          "delayed",
        ),
        COMANDO_TIMEOUT_MS,
      )
      out.push({
        name,
        waiting: c.waiting ?? 0,
        active: c.active ?? 0,
        completed: c.completed ?? 0,
        failed: c.failed ?? 0,
        delayed: c.delayed ?? 0,
      })
    } catch {
      // Redis fora do ar não pode derrubar o painel admin.
    }
  }
  return out
}

/** Fecha workers, filas e a conexão (hook `onClose` do Fastify). */
export async function closeQueues(): Promise<void> {
  filaEncerrada = true
  await Promise.allSettled(workers.map((w) => w.close()))
  workers.length = 0
  await Promise.allSettled([...queues.values()].map((q) => q.close()))
  queues.clear()
  if (connection) {
    await connection.quit().catch(() => connection?.disconnect())
    connection = null
  }
}
