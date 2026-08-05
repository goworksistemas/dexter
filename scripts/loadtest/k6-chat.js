/**
 * Load test do AgentCore — POST /api/chat (SSE).
 *
 * Meta do projeto: 50 VUs, p95(TTFT) < 3s.
 *
 * TTFT: k6 stock NÃO faz streaming HTTP nativo (k6/experimental/streams não
 * lê o body do http client). Medimos `res.timings.waiting` (TTFB) como
 * aproximação documentada do tempo até o primeiro byte do stream SSE.
 * Limitação: o 1º byte pode ser `progress`/heartbeat antes de `text-delta`.
 * Para TTFT real até `event: text-delta`, use a extensão community xk6-sse
 * (ver README).
 *
 * Env:
 *   K6_JWT       (obrigatório) Bearer JWT Supabase
 *   K6_BASE_URL  default http://localhost:8787
 *   K6_VUS       default 50
 *   K6_DURATION  default 60s
 *   K6_MODEL     opcional — id do modelo no catálogo (ex.: haiku barato)
 *   K6_MESSAGE   opcional — texto do user (default curto p/ reduzir custo)
 */

import http from "k6/http"
import { check, fail } from "k6"
import { Trend, Rate } from "k6/metrics"
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js"

const BASE_URL = (__ENV.K6_BASE_URL || "http://localhost:8787").replace(/\/$/, "")
const JWT = __ENV.K6_JWT || ""
const VUS = Number(__ENV.K6_VUS || "50")
const DURATION = __ENV.K6_DURATION || "60s"
const MODEL = __ENV.K6_MODEL || ""
const MESSAGE =
  __ENV.K6_MESSAGE ||
  "Responda apenas com a palavra ok, sem mais nada."

/** Tempo até o 1º byte do response body (aprox. TTFT / TTFB), em ms. */
const ttft = new Trend("ttft", true)
const chatOk = new Rate("chat_ok")

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    ttft: ["p(95)<3000"],
    checks: ["rate>0.95"],
    chat_ok: ["rate>0.95"],
  },
}

export function setup() {
  if (!JWT) {
    fail("Defina K6_JWT (Bearer do Supabase Auth). Veja scripts/loadtest/README.md")
  }
  return { jwt: JWT }
}

export default function (data) {
  const threadId = uuidv4()
  const messageId = uuidv4()

  const context = {}
  if (MODEL) context.model = MODEL

  const payload = JSON.stringify({
    threadId,
    message: {
      id: messageId,
      role: "user",
      content: MESSAGE,
      createdAt: new Date().toISOString(),
    },
    context,
  })

  const res = http.post(`${BASE_URL}/api/chat`, payload, {
    headers: {
      Authorization: `Bearer ${data.jwt}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    // Corpo completo como texto para inspecionar eventos SSE após o buffer.
    responseType: "text",
    tags: { name: "POST /api/chat" },
    // Chat com tools/LLM pode demorar; timeout generoso por VU.
    timeout: "180s",
  })

  // Aproximação TTFT: waiting = tempo até o 1º byte (após headers).
  ttft.add(res.timings.waiting)

  const body = typeof res.body === "string" ? res.body : ""
  const hasTextDelta = body.includes("event: text-delta")
  const hasDone = body.includes("event: done")
  const ok =
    res.status === 200 && hasTextDelta && hasDone

  chatOk.add(ok)

  check(res, {
    "status 200": (r) => r.status === 200,
    "SSE tem text-delta": () => hasTextDelta,
    "SSE tem done": () => hasDone,
  })
}
