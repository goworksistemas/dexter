import { describe, expect, it } from "vitest"

import type { SSEEvent } from "../lib/sse.js"
import {
  ChatRunRegistry,
  type RunAssinante,
} from "./chat-run-registry.js"

const CHAT_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "user-1"
const OUTRO_USER = "user-2"

function assinanteFake(): RunAssinante & { eventos: SSEEvent[] } {
  const eventos: SSEEvent[] = []
  return {
    eventos,
    emitir(evt: SSEEvent) {
      eventos.push(evt)
    },
  }
}

function textDelta(texto: string): SSEEvent {
  return { event: "text-delta", data: { textDelta: texto } }
}

const PROGRESSO: SSEEvent = {
  event: "progress",
  data: { type: "status", text: "Gerando resposta" },
}

describe("ChatRunRegistry.publicar", () => {
  it("acumula text-delta e repassa aos assinantes", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    const a = assinanteFake()
    registry.assinar(run, a)

    registry.publicar(run, textDelta("olá "))
    registry.publicar(run, textDelta("mundo"))

    expect(run.textoAcumulado).toBe("olá mundo")
    expect(a.eventos).toEqual([textDelta("olá "), textDelta("mundo")])
  })

  it("ignora eventos depois do terminal", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    registry.publicar(run, { event: "done", data: {} })
    registry.publicar(run, textDelta("tarde demais"))

    expect(run.status).toBe("done")
    expect(run.textoAcumulado).toBe("")
  })

  it("assinante que lança é removido sem derrubar os demais", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    const quebrado: RunAssinante = {
      emitir() {
        throw new Error("conexão morta")
      },
    }
    const saudavel = assinanteFake()
    registry.assinar(run, quebrado)
    registry.assinar(run, saudavel)

    registry.publicar(run, textDelta("olá"))

    expect(run.assinantes.has(quebrado)).toBe(false)
    expect(saudavel.eventos).toEqual([textDelta("olá")])
  })
})

describe("ChatRunRegistry.anexar", () => {
  it("devolve replay com progresso, texto acumulado único e segue ao vivo", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    registry.publicar(run, PROGRESSO)
    registry.publicar(run, textDelta("olá "))
    registry.publicar(run, textDelta("mundo"))

    const a = assinanteFake()
    const anexo = registry.anexar(CHAT_ID, USER_ID, a)
    expect(anexo).not.toBeNull()
    expect(anexo!.ativo).toBe(true)
    expect(anexo!.replay).toEqual([PROGRESSO, textDelta("olá mundo")])

    registry.publicar(run, textDelta("!"))
    expect(a.eventos).toEqual([textDelta("!")])
  })

  it("run encerrado (janela pós-fim): replay inclui o terminal e não assina", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    registry.publicar(run, textDelta("resposta"))
    registry.publicar(run, { event: "done", data: {} })

    const a = assinanteFake()
    const anexo = registry.anexar(CHAT_ID, USER_ID, a)
    expect(anexo).not.toBeNull()
    expect(anexo!.ativo).toBe(false)
    expect(anexo!.replay).toEqual([
      textDelta("resposta"),
      { event: "done", data: {} },
    ])
    expect(run.assinantes.size).toBe(0)
  })

  it("nega anexar/obter/cancelar de outro usuário (anti-IDOR)", () => {
    const registry = new ChatRunRegistry()
    registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })

    expect(registry.anexar(CHAT_ID, OUTRO_USER, assinanteFake())).toBeNull()
    expect(registry.obter(CHAT_ID, OUTRO_USER)).toBeNull()
    expect(registry.cancelar(CHAT_ID, OUTRO_USER)).toBe(false)
  })

  it("chat desconhecido devolve null", () => {
    const registry = new ChatRunRegistry()
    expect(registry.anexar(CHAT_ID, USER_ID, assinanteFake())).toBeNull()
  })
})

describe("ChatRunRegistry.iniciar", () => {
  it("run novo no mesmo chat aborta e substitui o anterior", () => {
    const registry = new ChatRunRegistry()
    const controllerAntigo = new AbortController()
    const antigo = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: controllerAntigo,
    })

    const novo = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })

    expect(controllerAntigo.signal.aborted).toBe(true)
    expect(antigo.status).toBe("cancelled")
    expect(registry.obter(CHAT_ID, USER_ID)).toBe(novo)
  })
})

describe("ChatRunRegistry.cancelar / encerrar", () => {
  it("cancelar aborta o controller e marca cancelled", () => {
    const registry = new ChatRunRegistry()
    const controller = new AbortController()
    const run = registry.iniciar({ chatId: CHAT_ID, userId: USER_ID, controller })

    expect(registry.cancelar(CHAT_ID, USER_ID)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(run.status).toBe("cancelled")
    // Segundo cancelamento: nada mais rodando.
    expect(registry.cancelar(CHAT_ID, USER_ID)).toBe(false)
  })

  it("encerrar publica done sintético preservando o status cancelled", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    const a = assinanteFake()
    registry.assinar(run, a)
    registry.cancelar(CHAT_ID, USER_ID)

    registry.encerrar(run, "cancelled")

    expect(run.status).toBe("cancelled")
    expect(run.eventoTerminal).toEqual({ event: "done", data: {} })
    expect(a.eventos).toEqual([{ event: "done", data: {} }])
  })

  it("encerrar é no-op quando o run já emitiu terminal", () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    registry.publicar(run, { event: "error", data: { message: "falhou" } })

    registry.encerrar(run, "done")

    expect(run.status).toBe("error")
    expect(run.eventoTerminal).toEqual({
      event: "error",
      data: { message: "falhou" },
    })
  })

  it("aguardarFim resolve quando o terminal é publicado", async () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })

    let resolveu = false
    const espera = registry.aguardarFim(run, 5_000).then(() => {
      resolveu = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(resolveu).toBe(false)

    registry.publicar(run, { event: "done", data: {} })
    await espera
    expect(resolveu).toBe(true)
    expect(run.esperasFim.size).toBe(0)
  })

  it("aguardarFim resolve na hora se o run já terminou", async () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    registry.publicar(run, { event: "done", data: {} })

    await registry.aguardarFim(run, 5_000)
    expect(run.esperasFim.size).toBe(0)
  })

  it("aguardarFim desiste no timeout sem pendurar", async () => {
    const registry = new ChatRunRegistry()
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })

    await registry.aguardarFim(run, 5)
    // O resolver expirado sai do set — terminal futuro não chama função morta.
    expect(run.esperasFim.size).toBe(0)
  })

  it("run encerrado sai do registro depois do TTL", async () => {
    const registry = new ChatRunRegistry(5)
    const run = registry.iniciar({
      chatId: CHAT_ID,
      userId: USER_ID,
      controller: new AbortController(),
    })
    registry.publicar(run, { event: "done", data: {} })
    expect(registry.obter(CHAT_ID, USER_ID)).toBe(run)

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(registry.obter(CHAT_ID, USER_ID)).toBeNull()
  })
})
