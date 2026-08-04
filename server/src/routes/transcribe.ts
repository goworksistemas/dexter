/**
 * POST /api/transcribe — fala → texto (STT OpenAI-compatible).
 * Body multipart/form-data: campo `file` (áudio) + campos `mimeType`/`language`.
 * O áudio chega cru (sem base64) — o front manda o Blob direto.
 */
import multipart, { type MultipartFields } from "@fastify/multipart"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { SttError, sttConfigured, transcribeAudio } from "../lib/stt.js"
import { resolveUser } from "../services/auth.js"

/** Mesmo teto do stt.ts — corta o upload antes de bufferizar 25 MB+. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

const fieldsSchema = z.object({
  mimeType: z.string().max(120).optional(),
  language: z.string().max(16).optional(),
})

/** Valor de um campo de texto do multipart (ignora arquivos e repetições). */
function textField(field: MultipartFields[string]): string | undefined {
  const part = Array.isArray(field) ? field[0] : field
  if (part && part.type === "field" && typeof part.value === "string") {
    return part.value
  }
  return undefined
}

export default async function transcribeRoutes(
  app: FastifyInstance,
): Promise<void> {
  // Escopo deste plugin: só as rotas daqui aceitam multipart.
  await app.register(multipart, {
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 8 },
  })

  app.get("/api/transcribe/status", async (request) => {
    await resolveUser(request)
    return {
      configured: await sttConfigured(),
      model: (await import("../config.js")).config.STT_MODEL,
    }
  })

  app.post("/api/transcribe", async (request, reply) => {
    await resolveUser(request)

    if (!request.isMultipart()) {
      return reply.code(415).send({
        error: "invalid_body",
        message: "Envie o áudio como multipart/form-data (campo file).",
      })
    }

    const file = await request.file()
    if (!file) {
      return reply.code(400).send({
        error: "invalid_body",
        message: "Envie o áudio no campo file (e opcionalmente mimeType/language).",
      })
    }

    let bytes: Buffer
    try {
      bytes = await file.toBuffer()
    } catch {
      // fileSize estourado: o plugin aborta o stream em vez de acumular tudo.
      return reply.code(413).send({
        error: "audio_too_large",
        message: "Áudio maior que 25 MB.",
      })
    }

    const parsed = fieldsSchema.safeParse({
      mimeType: textField(file.fields.mimeType),
      language: textField(file.fields.language),
    })
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        message: "Campos mimeType/language inválidos.",
      })
    }

    try {
      const result = await transcribeAudio({
        bytes,
        mimeType: parsed.data.mimeType || file.mimetype || "audio/webm",
        language: parsed.data.language || "pt",
      })
      return { text: result.text, model: result.model }
    } catch (err) {
      if (err instanceof SttError) {
        return reply.code(err.statusCode).send({
          error: "stt_failed",
          message: err.message,
        })
      }
      throw err
    }
  })
}
