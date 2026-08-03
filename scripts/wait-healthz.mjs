#!/usr/bin/env node
/**
 * Espera o AgentCore responder em /healthz e avisa quando o stack está pronto.
 * Nunca falha o processo: é só sinalização de log, não deve derrubar o dev.
 *
 * Uso: node scripts/wait-healthz.mjs [url] [timeoutMs]
 */
const url = process.argv[2] ?? 'http://127.0.0.1:8787/healthz'
const timeoutMs = Number.parseInt(process.argv[3] ?? '60000', 10)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const startedAt = Date.now()

while (Date.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (response.ok) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`AgentCore ok em ${url} (${elapsed}s) — abra a URL Local do [web] acima`)
      process.exit(0)
    }
  } catch {
    /* ainda subindo */
  }
  await sleep(500)
}

console.warn(`sem resposta de ${url} em ${timeoutMs / 1000}s — veja os logs do [server] acima`)
process.exit(0)
