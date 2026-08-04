/**
 * Ditado por voz ao vivo: grava em segmentos (~2s), transcreve no STT
 * e atualiza o texto continuamente (parcial → final no stop).
 */
import * as React from "react"
import { toast } from "sonner"

import { transcribeAudioBlob } from "./api"

export type VoiceDictationStatus = "idle" | "recording" | "transcribing"

/** Intervalo entre segmentos enviados ao STT. */
const SEGMENT_MS = 2000
/** Áudio abaixo disso costuma ser ruído/silêncio. */
const MIN_BLOB_BYTES = 256

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]
  return candidates.find((t) => MediaRecorder.isTypeSupported(t))
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Une texto já confirmado com o do segmento novo.
 * Evita append cego quando o modelo devolve frase sobreposta/inteira.
 */
export function mergeTranscriptSegment(committed: string, incoming: string): string {
  const a = normalizeWs(committed)
  const b = normalizeWs(incoming)
  if (!b) return a
  if (!a) return b

  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()

  if (bLower.startsWith(aLower)) return b
  if (aLower.startsWith(bLower)) return a
  if (aLower.endsWith(bLower)) return a

  const maxOverlap = Math.min(a.length, b.length, 80)
  for (let len = maxOverlap; len >= 6; len--) {
    if (aLower.slice(-len) === bLower.slice(0, len)) {
      return normalizeWs(a + b.slice(len))
    }
  }

  // Sobreposição por palavras finais (STT costuma repetir a última frase).
  const aWords = a.split(" ")
  const bWords = b.split(" ")
  const maxWords = Math.min(aWords.length, bWords.length, 12)
  for (let n = maxWords; n >= 2; n--) {
    const suffix = aWords.slice(-n).join(" ").toLowerCase()
    const prefix = bWords.slice(0, n).join(" ").toLowerCase()
    if (suffix === prefix) {
      return normalizeWs([...aWords, ...bWords.slice(n)].join(" "))
    }
  }

  return normalizeWs(`${a} ${b}`)
}

function isBenignSttError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes("nenhuma fala") ||
    msg.includes("áudio vazio") ||
    msg.includes("aborted") ||
    err.name === "AbortError"
  )
}

export function useVoiceDictation(opts: {
  /** Texto ditado da sessão atual (já mergeado). Chamado a cada segmento e no final. */
  onTranscript: (dictatedText: string) => void
  /** Disparado ao começar a gravar — capture o texto base do composer aqui. */
  onRecordingStart?: () => void
  disabled?: boolean
}) {
  const [status, setStatus] = React.useState<VoiceDictationStatus>("idle")
  const [liveText, setLiveText] = React.useState("")

  const mediaRef = React.useRef<MediaStream | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const mimeTypeRef = React.useRef<string | undefined>(undefined)
  const segmentTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionActiveRef = React.useRef(false)
  const rotatingRef = React.useRef(false)
  const committedRef = React.useRef("")
  const queueRef = React.useRef<Blob[]>([])
  const processingRef = React.useRef(false)
  const abortRef = React.useRef<AbortController | null>(null)
  const sessionIdRef = React.useRef(0)
  const pendingFinalRef = React.useRef<((value: void) => void) | null>(null)

  const onTranscriptRef = React.useRef(opts.onTranscript)
  onTranscriptRef.current = opts.onTranscript
  const onRecordingStartRef = React.useRef(opts.onRecordingStart)
  onRecordingStartRef.current = opts.onRecordingStart

  const clearSegmentTimer = React.useCallback(() => {
    if (segmentTimerRef.current != null) {
      clearTimeout(segmentTimerRef.current)
      segmentTimerRef.current = null
    }
  }, [])

  const emitTranscript = React.useCallback((text: string) => {
    committedRef.current = text
    setLiveText(text)
    onTranscriptRef.current(text)
  }, [])

  const stopTracks = React.useCallback(() => {
    mediaRef.current?.getTracks().forEach((t) => t.stop())
    mediaRef.current = null
  }, [])

  const cleanupStream = React.useCallback(() => {
    clearSegmentTimer()
    stopTracks()
    recorderRef.current = null
    chunksRef.current = []
    rotatingRef.current = false
  }, [clearSegmentTimer, stopTracks])

  const stopRecorderToBlob = React.useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          const type =
            recorder.mimeType || mimeTypeRef.current || "audio/webm"
          const parts = chunksRef.current
          chunksRef.current = []
          recorderRef.current = null
          resolve(parts.length ? new Blob(parts, { type }) : null)
        },
        { once: true },
      )
      try {
        if (recorder.state === "recording") recorder.requestData()
      } catch {
        /* ignore */
      }
      try {
        recorder.stop()
      } catch {
        resolve(null)
      }
    })
  }, [])

  const startRecorderOnStream = React.useCallback(() => {
    const stream = mediaRef.current
    if (!stream) return false
    chunksRef.current = []
    const mimeType = mimeTypeRef.current
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)
    recorderRef.current = recorder
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunksRef.current.push(ev.data)
    }
    recorder.start(250)
    return true
  }, [])

  const processQueue = React.useCallback(async () => {
    if (processingRef.current) return
    processingRef.current = true
    const sessionId = sessionIdRef.current

    while (queueRef.current.length > 0) {
      if (sessionIdRef.current !== sessionId) break
      const blob = queueRef.current.shift()
      if (!blob || blob.size < MIN_BLOB_BYTES) continue

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const text = await transcribeAudioBlob(blob, {
          language: "pt",
          signal: controller.signal,
        })
        if (sessionIdRef.current !== sessionId || controller.signal.aborted) {
          continue
        }
        const merged = mergeTranscriptSegment(committedRef.current, text)
        emitTranscript(merged)
      } catch (err) {
        if (controller.signal.aborted || sessionIdRef.current !== sessionId) {
          continue
        }
        if (isBenignSttError(err)) continue
        // Erro pontual não encerra a gravação.
        if (sessionActiveRef.current) {
          toast.message(
            err instanceof Error
              ? err.message
              : "Falha ao transcrever um trecho — continuando.",
          )
        } else {
          toast.error(
            err instanceof Error
              ? err.message
              : "Falha ao transcrever o áudio.",
          )
        }
      }
    }

    processingRef.current = false
    if (queueRef.current.length > 0 && sessionIdRef.current === sessionId) {
      void processQueue()
      return
    }
    pendingFinalRef.current?.()
    pendingFinalRef.current = null
  }, [emitTranscript])

  const enqueueBlob = React.useCallback(
    (blob: Blob | null) => {
      if (!blob || blob.size < MIN_BLOB_BYTES) return
      queueRef.current.push(blob)
      void processQueue()
    },
    [processQueue],
  )

  const rotateSegment = React.useCallback(async () => {
    if (!sessionActiveRef.current || rotatingRef.current) return
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== "recording") return

    rotatingRef.current = true
    clearSegmentTimer()
    try {
      const blob = await stopRecorderToBlob()
      if (sessionActiveRef.current) {
        startRecorderOnStream()
        segmentTimerRef.current = setTimeout(() => {
          void rotateSegment()
        }, SEGMENT_MS)
      }
      enqueueBlob(blob)
    } finally {
      rotatingRef.current = false
    }
  }, [
    clearSegmentTimer,
    enqueueBlob,
    startRecorderOnStream,
    stopRecorderToBlob,
  ])

  const waitForQueue = React.useCallback(async () => {
    if (!processingRef.current && queueRef.current.length === 0) return
    await new Promise<void>((resolve) => {
      pendingFinalRef.current = resolve
      // Caso a fila já tenha esvaziado entre o check e o await.
      if (!processingRef.current && queueRef.current.length === 0) {
        pendingFinalRef.current = null
        resolve()
      }
    })
  }, [])

  React.useEffect(() => {
    return () => {
      sessionActiveRef.current = false
      sessionIdRef.current += 1
      abortRef.current?.abort()
      clearSegmentTimer()
      try {
        recorderRef.current?.stop()
      } catch {
        /* ignore */
      }
      cleanupStream()
    }
  }, [cleanupStream, clearSegmentTimer])

  const stopAndFinalize = React.useCallback(async () => {
    if (!sessionActiveRef.current && status !== "recording") {
      setStatus("idle")
      return
    }

    sessionActiveRef.current = false
    clearSegmentTimer()
    setStatus("transcribing")

    // Evita race com rotate em andamento.
    while (rotatingRef.current) {
      await new Promise((r) => setTimeout(r, 30))
    }

    const blob = await stopRecorderToBlob()
    stopTracks()
    recorderRef.current = null
    chunksRef.current = []

    enqueueBlob(blob)
    await waitForQueue()

    const finalText = committedRef.current
    if (!finalText) {
      toast.message("Não capturamos fala reconhecível. Tente de novo.")
    } else {
      emitTranscript(finalText)
    }

    setStatus("idle")
  }, [
    clearSegmentTimer,
    emitTranscript,
    enqueueBlob,
    status,
    stopRecorderToBlob,
    stopTracks,
    waitForQueue,
  ])

  const startRecording = React.useCallback(async () => {
    if (opts.disabled) return
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Este navegador não permite microfone.")
      return
    }
    if (typeof MediaRecorder === "undefined") {
      toast.error("Gravação de áudio não suportada neste navegador.")
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      })

      sessionIdRef.current += 1
      abortRef.current?.abort()
      queueRef.current = []
      processingRef.current = false
      committedRef.current = ""
      setLiveText("")
      mediaRef.current = stream
      mimeTypeRef.current = pickMimeType()
      sessionActiveRef.current = true

      onRecordingStartRef.current?.()

      if (!startRecorderOnStream()) {
        throw new Error("Não foi possível iniciar a gravação.")
      }

      setStatus("recording")
      segmentTimerRef.current = setTimeout(() => {
        void rotateSegment()
      }, SEGMENT_MS)
    } catch (err) {
      sessionActiveRef.current = false
      cleanupStream()
      setStatus("idle")
      const name = err instanceof DOMException ? err.name : ""
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        toast.error("Permissão de microfone negada.")
        return
      }
      toast.error(
        err instanceof Error ? err.message : "Não foi possível abrir o microfone.",
      )
    }
  }, [cleanupStream, opts.disabled, rotateSegment, startRecorderOnStream])

  const toggle = React.useCallback(() => {
    if (opts.disabled) return
    if (status === "transcribing") return
    if (status === "recording") {
      void stopAndFinalize()
      return
    }
    void startRecording()
  }, [opts.disabled, startRecording, status, stopAndFinalize])

  const cancel = React.useCallback(() => {
    sessionActiveRef.current = false
    sessionIdRef.current += 1
    abortRef.current?.abort()
    queueRef.current = []
    processingRef.current = false
    pendingFinalRef.current?.()
    pendingFinalRef.current = null
    clearSegmentTimer()
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop()
      }
    } catch {
      /* ignore */
    }
    cleanupStream()
    committedRef.current = ""
    setLiveText("")
    setStatus("idle")
  }, [cleanupStream, clearSegmentTimer])

  return {
    status,
    liveText,
    isRecording: status === "recording",
    isTranscribing: status === "transcribing",
    toggle,
    cancel,
    supported:
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined",
  }
}
