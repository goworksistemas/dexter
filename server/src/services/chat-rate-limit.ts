/**
 * Rate limit do POST /api/chat por USUÁRIO autenticado (item 4.3).
 *
 * O `@fastify/rate-limit` global do index.ts continua valendo como camada
 * externa, mas ele é por IP: atrás do Traefik o escritório inteiro compartilha
 * um IP e um usuário sozinho consegue consumir a cota de todo mundo. Aqui a
 * chave é o `userId`, então a checagem só faz sentido DEPOIS da autenticação.
 *
 * Janela deslizante simples:
 *  - com Redis (`REDIS_URL`), um sorted set por usuário — funciona entre
 *    réplicas e expira sozinho;
 *  - sem Redis, um Map em memória com o mesmo comportamento por processo.
 *    Em dev local (1 processo) é equivalente; em produção o Redis já está lá.
 */
import { config } from "../config.js"
import { comTimeout, getRedis } from "../lib/queue.js"

/**
 * O rate limit está NO caminho do request: se o Redis não responder rápido, a
 * checagem cai no fallback em memória em vez de segurar a resposta.
 */
const REDIS_TIMEOUT_MS = 2_000

export interface ResultadoRateLimit {
  permitido: boolean
  /** Requisições já usadas na janela (inclui a atual quando permitida). */
  usadas: number
  limite: number
  /** Tamanho da janela em segundos — entra na mensagem de erro. */
  janelaSec: number
  /** Segundos até liberar — só faz sentido quando `permitido` é false. */
  retryAfterSec: number
}

/** Estado do fallback em memória: timestamps das requisições na janela. */
const memoria = new Map<string, number[]>()

/** Teto de usuários rastreados em memória — evita crescer sem limite. */
const MAX_USUARIOS_MEMORIA = 5_000

function chave(userId: string): string {
  return `ratelimit:chat:${userId}`
}

function aplicarEmMemoria(
  userId: string,
  agora: number,
  janelaMs: number,
  max: number,
): ResultadoRateLimit {
  const anteriores = (memoria.get(userId) ?? []).filter(
    (t) => t > agora - janelaMs,
  )
  if (anteriores.length >= max) {
    memoria.set(userId, anteriores)
    const maisAntigo = anteriores[0] ?? agora
    return {
      permitido: false,
      usadas: anteriores.length,
      limite: max,
      janelaSec: Math.round(janelaMs / 1_000),
      retryAfterSec: Math.max(
        1,
        Math.ceil((janelaMs - (agora - maisAntigo)) / 1_000),
      ),
    }
  }
  anteriores.push(agora)
  memoria.set(userId, anteriores)
  if (memoria.size > MAX_USUARIOS_MEMORIA) {
    // Descarta o registro mais antigo do Map (ordem de inserção) — no pior caso
    // um usuário ganha uma janela nova, o que é aceitável para um fallback.
    const primeiro = memoria.keys().next().value
    if (primeiro && primeiro !== userId) memoria.delete(primeiro)
  }
  return {
    permitido: true,
    usadas: anteriores.length,
    limite: max,
    janelaSec: Math.round(janelaMs / 1_000),
    retryAfterSec: 0,
  }
}

async function aplicarNoRedis(
  userId: string,
  agora: number,
  janelaMs: number,
  max: number,
): Promise<ResultadoRateLimit> {
  const redis = getRedis()
  if (!redis) throw new Error("sem conexão Redis")
  const k = chave(userId)
  const membro = `${agora}-${Math.random().toString(36).slice(2, 10)}`

  const resultados = await comTimeout(
    redis
      .multi()
      .zremrangebyscore(k, 0, agora - janelaMs)
      .zadd(k, agora, membro)
      .zcard(k)
      .pexpire(k, janelaMs)
      .exec(),
    REDIS_TIMEOUT_MS,
  )

  const cardinalidade = Number(resultados?.[2]?.[1] ?? 0)
  if (cardinalidade <= max) {
    return {
      permitido: true,
      usadas: cardinalidade,
      limite: max,
      janelaSec: Math.round(janelaMs / 1_000),
      retryAfterSec: 0,
    }
  }

  // Requisição barrada não ocupa vaga na janela — senão um cliente em loop
  // empurraria o próprio desbloqueio para sempre.
  await comTimeout(redis.zrem(k, membro), REDIS_TIMEOUT_MS)
  // Score do item mais antigo da janela = quando a primeira vaga é liberada.
  const maisAntigo = await comTimeout(
    redis.zrange(k, "0", "0", "WITHSCORES"),
    REDIS_TIMEOUT_MS,
  )
  const scoreAntigo = Number(maisAntigo?.[1] ?? agora)
  return {
    permitido: false,
    usadas: cardinalidade - 1,
    limite: max,
    janelaSec: Math.round(janelaMs / 1_000),
    retryAfterSec: Math.max(
      1,
      Math.ceil((janelaMs - (agora - scoreAntigo)) / 1_000),
    ),
  }
}

/**
 * Consome uma vaga da janela deste usuário. Nunca lança: falha de Redis cai no
 * fallback em memória (rate limit degradado é melhor que chat fora do ar).
 */
export async function consumirCotaDeChat(
  userId: string,
  opts: { max?: number; janelaMs?: number } = {},
): Promise<ResultadoRateLimit> {
  const max = opts.max ?? config.CHAT_RATE_LIMIT_MAX
  const janelaMs = opts.janelaMs ?? config.CHAT_RATE_LIMIT_WINDOW_MS
  const agora = Date.now()

  if (getRedis()) {
    try {
      return await aplicarNoRedis(userId, agora, janelaMs, max)
    } catch {
      // cai no fallback abaixo
    }
  }
  return aplicarEmMemoria(userId, agora, janelaMs, max)
}

/** Mensagem 429 em português — o front mostra como está. */
export function mensagemLimiteAtingido(r: ResultadoRateLimit): string {
  const janela =
    r.janelaSec === 60 ? "por minuto" : `a cada ${r.janelaSec} segundos`
  return (
    `Você atingiu o limite de ${r.limite} mensagens ${janela}. ` +
    `Aguarde ${r.retryAfterSec}s e envie novamente.`
  )
}

/** Só para testes/manutenção: zera o estado em memória. */
export function limparRateLimitEmMemoria(): void {
  memoria.clear()
}
