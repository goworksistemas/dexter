/**
 * POST /api/transcribe — fala → texto (STT OpenAI-compatible).
 * Body JSON: { audioBase64, mimeType?, language? }
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { SttError, sttConfigured, transcribeAudio } from "../lib/stt.js"
import { resolveUser } from "../services/auth.js"

const bodySchema = z.object({
  audioBase64: z.string().min(1).max(36_000_000),
  mimeType: z.string().max(120).optional(),
  language: z.string().max(16).optional(),
})

export default async function transcribeRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api/transcribe/status", async (request) => {
    await resolveUser(request)
    return {
      configured: sttConfigured(),
      model: (await import("../config.js")).config.STT_MODEL,
    }
  })

  app.post("/api/transcribe", async (request, reply) => {
    await resolveUser(request)
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        message: "Envie audioBase64 (e opcionalmente mimeType/language).",
      })
    }

    const { audioBase64, mimeType, language } = parsed.data
    const raw = audioBase64.includes(",")
      ? audioBase64.slice(audioBase64.indexOf(",") + 1)
      : audioBase64

    let bytes: Buffer
    try {
      bytes = Buffer.from(raw, "base64")
    } catch {
      return reply.code(400).send({
        error: "invalid_audio",
        message: "audioBase64 inválido.",
      })
    }

    try {
      const result = await transcribeAudio({
        bytes,
        mimeType: mimeType || "audio/webm",
        language: language || "pt",
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
