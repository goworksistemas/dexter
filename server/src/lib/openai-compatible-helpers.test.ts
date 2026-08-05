import { describe, expect, it } from "vitest"
import {
  formatProviderHttpError,
  sanitizeSchemaForProvider,
} from "./openai-compatible-helpers.js"

describe("sanitizeSchemaForProvider", () => {
  it("remove required vazio para qualquer provider (Gemini devolve 400)", () => {
    const schema = {
      type: "object",
      properties: { termo: { type: "string" } },
      required: [],
    }
    expect(sanitizeSchemaForProvider(schema, "gemini")).toEqual({
      type: "object",
      properties: { termo: { type: "string" } },
    })
    expect(sanitizeSchemaForProvider(schema, "openai")).toEqual({
      type: "object",
      properties: { termo: { type: "string" } },
    })
  })

  it("mantém required não-vazio", () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    }
    expect(sanitizeSchemaForProvider(schema, "gemini")).toEqual(schema)
  })

  it("remove $schema e additionalProperties só para o Gemini", () => {
    const schema = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: { id: { type: "string" } },
    }
    expect(sanitizeSchemaForProvider(schema, "gemini")).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    })
    expect(sanitizeSchemaForProvider(schema, "openai")).toEqual(schema)
  })

  it("limpa schemas aninhados (tools MCP dos conectores)", () => {
    const schema = {
      type: "object",
      properties: {
        filtro: {
          type: "object",
          required: [],
          additionalProperties: true,
          properties: { nome: { type: "string" } },
        },
        itens: {
          type: "array",
          items: { type: "object", properties: {}, required: [] },
        },
      },
      required: ["filtro"],
    }
    expect(sanitizeSchemaForProvider(schema, "gemini")).toEqual({
      type: "object",
      properties: {
        filtro: {
          type: "object",
          properties: { nome: { type: "string" } },
        },
        itens: {
          type: "array",
          items: { type: "object", properties: {} },
        },
      },
      required: ["filtro"],
    })
  })
})

describe("formatProviderHttpError", () => {
  it("extrai a mensagem do envelope de erro do Google (400)", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'Invalid JSON payload received. Unknown name "required".',
        status: "INVALID_ARGUMENT",
      },
    })
    const msg = formatProviderHttpError("gemini", "gemini-2.5-flash", 400, body)
    expect(msg).toContain("HTTP 400")
    expect(msg).toContain("Invalid JSON payload received")
    expect(msg).not.toContain("INVALID_ARGUMENT")
  })

  it("extrai a mensagem quando o Google devolve um array de envelopes", () => {
    const body = JSON.stringify([
      { error: { code: 400, message: "detalhe do erro", status: "INVALID_ARGUMENT" } },
    ])
    const msg = formatProviderHttpError("gemini", "gemini-2.5-pro", 400, body)
    expect(msg).toContain("detalhe do erro")
  })

  it("modelo removido do provider vira orientação de troca", () => {
    const body = JSON.stringify({
      error: { code: 404, message: "models/gemini-1.0-pro is not found" },
    })
    const msg = formatProviderHttpError("gemini", "gemini-1.0-pro", 404, body)
    expect(msg).toContain("não está mais disponível")
  })

  it("429 transitório orienta aguardar; 429 de cobrança aponta o plano", () => {
    const transitorio = formatProviderHttpError(
      "gemini",
      "gemini-2.5-flash",
      429,
      JSON.stringify({ error: { message: "Resource exhausted, slow down" } }),
    )
    expect(transitorio).toContain("Aguarde")

    const cobranca = formatProviderHttpError(
      "gemini",
      "gemini-2.5-flash",
      429,
      JSON.stringify({
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details.",
        },
      }),
    )
    expect(cobranca).toContain("cota do plano")
  })

  it("chave recusada e provider instável têm mensagens próprias", () => {
    expect(formatProviderHttpError("gemini", "m", 401, "")).toContain("chave")
    expect(formatProviderHttpError("gemini", "m", 500, "")).toContain("instável")
  })
})
