import { describe, expect, it } from "vitest"

import {
  ajustarContexto,
  calcularMetricas,
  CHARS_POR_TOKEN,
  estimarTokens,
  juntarBlocosDinamicos,
  LIMITE_INPUT_FALLBACK_TOKENS,
  MIN_MENSAGENS_JANELA,
  orcamentoDeEntrada,
  type BlocoDinamico,
  type EntradaContexto,
  type MensagemContexto,
} from "./context-budget.js"

/** Texto com tamanho exato em chars — controla os tokens estimados no teste. */
function texto(tokens: number, letra = "x"): string {
  return letra.repeat(tokens * CHARS_POR_TOKEN)
}

function mensagens(qtd: number, tokensPorMsg = 10): MensagemContexto[] {
  return Array.from({ length: qtd }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: texto(tokensPorMsg, i % 2 === 0 ? "u" : "a"),
  }))
}

function entradaBase(over: Partial<EntradaContexto> = {}): EntradaContexto {
  return {
    systemStatic: texto(100),
    blocosDinamicos: [{ tipo: "outro", texto: texto(50) }],
    historico: mensagens(8),
    novaMensagem: texto(10),
    inputTokenLimit: 200_000,
    margemSaidaTokens: 8_000,
    ...over,
  }
}

describe("estimarTokens", () => {
  it("usa a razão de chars por token", () => {
    expect(estimarTokens("")).toBe(0)
    expect(estimarTokens("abcd")).toBe(1)
    expect(estimarTokens("abcde")).toBe(2) // arredonda para cima
    expect(estimarTokens(texto(250))).toBe(250)
  })
})

describe("orcamentoDeEntrada", () => {
  it("desconta a margem de saída do limite do catálogo", () => {
    expect(orcamentoDeEntrada(200_000, 32_000)).toBe(168_000)
  })

  it("cai no fallback conservador quando o catálogo não informa o limite", () => {
    expect(orcamentoDeEntrada(null, 8_000)).toBe(
      LIMITE_INPUT_FALLBACK_TOKENS - 8_000,
    )
    expect(orcamentoDeEntrada(undefined, 0)).toBe(LIMITE_INPUT_FALLBACK_TOKENS)
    expect(orcamentoDeEntrada(0, 0)).toBe(LIMITE_INPUT_FALLBACK_TOKENS)
  })

  it("nunca devolve orçamento não positivo", () => {
    expect(orcamentoDeEntrada(4_000, 32_000)).toBe(1_000)
  })
})

describe("calcularMetricas", () => {
  it("separa resumo e RAG do restante do bloco dinâmico", () => {
    const blocos: BlocoDinamico[] = [
      { tipo: "outro", texto: texto(20) },
      { tipo: "artefatos", texto: texto(30), titulos: texto(3) },
      { tipo: "resumo", texto: texto(40) },
      { tipo: "rag", texto: texto(50) },
    ]
    const m = calcularMetricas({
      systemStatic: texto(100),
      blocosDinamicos: blocos,
      historico: mensagens(4, 10),
      novaMensagem: texto(5),
    })
    expect(m.system_static).toBe(100)
    expect(m.system_dynamic).toBe(50) // outro + artefatos
    expect(m.summary).toBe(40)
    expect(m.rag).toBe(50)
    expect(m.history).toBe(45) // 4×10 + mensagem nova
    expect(m.total).toBe(285)
  })

  it("total é a soma dos componentes", () => {
    const m = calcularMetricas({
      systemStatic: texto(7),
      blocosDinamicos: [{ tipo: "rag", texto: texto(3) }],
      historico: [],
      novaMensagem: texto(2),
    })
    expect(m.total).toBe(
      m.system_static + m.system_dynamic + m.summary + m.rag + m.history,
    )
  })
})

describe("ajustarContexto — sem estouro", () => {
  it("devolve o contexto intacto e sem cortes", () => {
    const entrada = entradaBase()
    const r = ajustarContexto(entrada)
    expect(r.cortes).toEqual([])
    expect(r.dentroDoOrcamento).toBe(true)
    expect(r.historico).toHaveLength(8)
    expect(r.blocosDinamicos).toEqual(entrada.blocosDinamicos)
  })
})

describe("ajustarContexto — degradação", () => {
  it("1º corte: artefatos viram títulos", () => {
    const entrada = entradaBase({
      systemStatic: texto(1_000),
      blocosDinamicos: [
        { tipo: "outro", texto: texto(100) },
        { tipo: "artefatos", texto: texto(5_000), titulos: texto(10) },
      ],
      historico: mensagens(8, 10),
      inputTokenLimit: 4_000,
      margemSaidaTokens: 1_000,
    })
    const r = ajustarContexto(entrada)
    expect(r.cortes.map((c) => c.acao)).toEqual(["artefatos_para_titulos"])
    expect(r.dentroDoOrcamento).toBe(true)
    const art = r.blocosDinamicos.find((b) => b.tipo === "artefatos")
    expect(art?.texto).toBe(texto(10))
    // Histórico e RAG intactos: o corte mais barato bastou.
    expect(r.historico).toHaveLength(8)
  })

  it("2º corte: janela encolhe de 2 em 2 e continua começando em user", () => {
    const entrada = entradaBase({
      systemStatic: texto(100),
      blocosDinamicos: [],
      historico: mensagens(12, 100),
      novaMensagem: texto(10),
      inputTokenLimit: 1_400,
      margemSaidaTokens: 400,
    })
    const r = ajustarContexto(entrada)
    expect(r.cortes.every((c) => c.acao === "encolher_janela")).toBe(true)
    expect(r.cortes.length).toBeGreaterThan(0)
    expect(r.historico.length).toBeLessThan(12)
    expect(r.historico.length % 2).toBe(0)
    expect(r.historico[0]?.role).toBe("user")
  })

  it("3º corte: RAG sai depois que a janela chegou no piso", () => {
    // Orçamento de 2.000 tokens: com a janela no piso (4×300 + 10) o payload só
    // cabe se o bloco de RAG (800) sair.
    const entrada = entradaBase({
      systemStatic: texto(500),
      blocosDinamicos: [
        { tipo: "resumo", texto: texto(200) },
        { tipo: "rag", texto: texto(800) },
      ],
      historico: mensagens(8, 300),
      novaMensagem: texto(10),
      inputTokenLimit: 3_000,
      margemSaidaTokens: 1_000,
    })
    const r = ajustarContexto(entrada)
    const acoes = r.cortes.map((c) => c.acao)
    expect(acoes).toContain("encolher_janela")
    expect(acoes[acoes.length - 1]).toBe("remover_rag")
    expect(r.blocosDinamicos.some((b) => b.tipo === "rag")).toBe(false)
    // Resumo é complementar ao RAG e NUNCA sai na degradação.
    expect(r.blocosDinamicos.some((b) => b.tipo === "resumo")).toBe(true)
    expect(r.historico).toHaveLength(MIN_MENSAGENS_JANELA)
    expect(r.dentroDoOrcamento).toBe(true)
  })

  it("respeita o piso da janela mesmo sem conseguir caber", () => {
    const entrada = entradaBase({
      systemStatic: texto(10_000),
      blocosDinamicos: [],
      historico: mensagens(6, 50),
      novaMensagem: texto(10),
      inputTokenLimit: 2_000,
      margemSaidaTokens: 500,
    })
    const r = ajustarContexto(entrada)
    expect(r.historico.length).toBeGreaterThanOrEqual(MIN_MENSAGENS_JANELA)
    expect(r.dentroDoOrcamento).toBe(false)
  })

  it("não encolhe abaixo do piso quando o histórico já é pequeno", () => {
    const entrada = entradaBase({
      systemStatic: texto(10_000),
      blocosDinamicos: [],
      historico: mensagens(4, 10),
      inputTokenLimit: 1_000,
      margemSaidaTokens: 0,
    })
    const r = ajustarContexto(entrada)
    expect(r.cortes).toEqual([])
    expect(r.historico).toHaveLength(4)
    expect(r.dentroDoOrcamento).toBe(false)
  })

  it("métricas do resultado refletem o contexto JÁ degradado", () => {
    const entrada = entradaBase({
      systemStatic: texto(100),
      blocosDinamicos: [
        { tipo: "artefatos", texto: texto(5_000), titulos: texto(5) },
      ],
      historico: mensagens(8, 10),
      novaMensagem: texto(10),
      inputTokenLimit: 1_000,
      margemSaidaTokens: 100,
    })
    const r = ajustarContexto(entrada)
    expect(r.metricas.system_dynamic).toBe(5)
    expect(r.metricas.total).toBe(r.metricas.system_static + 5 + r.metricas.history)
  })
})

describe("juntarBlocosDinamicos", () => {
  it("concatena na ordem e ignora blocos vazios", () => {
    expect(
      juntarBlocosDinamicos([
        { tipo: "outro", texto: "A" },
        { tipo: "rag", texto: "   " },
        { tipo: "resumo", texto: "B" },
      ]),
    ).toBe("A\n\nB")
  })
})
