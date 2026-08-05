import { describe, expect, it } from "vitest"

import {
  BULK_CHATS_MAX_IDS,
  parseBulkChatsBody,
  type BulkChatsRequest,
} from "./chat-bulk.js"

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function esperaOk(body: unknown): BulkChatsRequest {
  const parsed = parseBulkChatsBody(body)
  if (!parsed.ok) {
    throw new Error(`esperava ok, veio erro: ${parsed.error}`)
  }
  return parsed.value
}

function esperaErro(body: unknown): string {
  const parsed = parseBulkChatsBody(body)
  if (parsed.ok) {
    throw new Error("esperava erro, veio ok")
  }
  return parsed.error
}

describe("parseBulkChatsBody", () => {
  it("aceita archive/unarchive/delete sem projectId", () => {
    for (const action of ["archive", "unarchive", "delete"] as const) {
      const value = esperaOk({ ids: [uuid(1), uuid(2)], action })
      expect(value.action).toBe(action)
      expect(value.ids).toEqual([uuid(1), uuid(2)])
      expect(value.projectId).toBeNull()
    }
  })

  it("aceita move com projectId uuid", () => {
    const value = esperaOk({
      ids: [uuid(1)],
      action: "move",
      projectId: uuid(9),
    })
    expect(value).toEqual({
      action: "move",
      ids: [uuid(1)],
      projectId: uuid(9),
    })
  })

  it("aceita move com projectId null (remover do projeto)", () => {
    const value = esperaOk({ ids: [uuid(1)], action: "move", projectId: null })
    expect(value.projectId).toBeNull()
  })

  it("rejeita move sem projectId — pedido ambíguo não vira default", () => {
    const erro = esperaErro({ ids: [uuid(1)], action: "move" })
    expect(erro).toMatch(/projectId/)
  })

  it("rejeita projectId em ação que não é move", () => {
    for (const action of ["archive", "unarchive", "delete"] as const) {
      const erro = esperaErro({ ids: [uuid(1)], action, projectId: uuid(9) })
      expect(erro).toMatch(/projectId/)
    }
  })

  it("rejeita projectId que não é uuid nem null", () => {
    esperaErro({ ids: [uuid(1)], action: "move", projectId: "meu-projeto" })
  })

  it("descarta ids duplicados mantendo a ordem", () => {
    const value = esperaOk({
      ids: [uuid(1), uuid(2), uuid(1), uuid(2), uuid(3)],
      action: "archive",
    })
    expect(value.ids).toEqual([uuid(1), uuid(2), uuid(3)])
  })

  it("rejeita lista vazia de ids", () => {
    esperaErro({ ids: [], action: "delete" })
  })

  it(`rejeita mais de ${BULK_CHATS_MAX_IDS} ids`, () => {
    const ids = Array.from({ length: BULK_CHATS_MAX_IDS + 1 }, (_, i) =>
      uuid(i + 1),
    )
    esperaErro({ ids, action: "archive" })
  })

  it(`aceita exatamente ${BULK_CHATS_MAX_IDS} ids`, () => {
    const ids = Array.from({ length: BULK_CHATS_MAX_IDS }, (_, i) =>
      uuid(i + 1),
    )
    const value = esperaOk({ ids, action: "archive" })
    expect(value.ids).toHaveLength(BULK_CHATS_MAX_IDS)
  })

  it("rejeita id que não é uuid", () => {
    esperaErro({ ids: ["abc"], action: "archive" })
  })

  it("rejeita action desconhecida", () => {
    esperaErro({ ids: [uuid(1)], action: "purge" })
  })

  it("rejeita body vazio/undefined/null", () => {
    esperaErro(undefined)
    esperaErro(null)
    esperaErro({})
  })
})
