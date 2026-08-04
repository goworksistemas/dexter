/**
 * Ditado por voz — grava o áudio INTEIRO e transcreve UMA vez no stop
 * (mesmo fluxo do Claude/ChatGPT). Sem segmentação: o modelo recebe a fala
 * completa com contexto, o que elimina palavras cortadas e frases coladas
 * erradas que o modo "ao vivo" de 2s produzia.
 */
import * as React from "react"
import { toast } from "sonner"

import { transcribeAudioBlob } from "./api"

export type VoiceDictationStatus = "idle" | "recording" | "transcribing"

/** Áudio abaixo disso costuma ser ruído/clique sem fala. */
const MIN_BLOB_BYTES = 1_024

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

export function useVoiceDictation(opts: {
  /** Texto final do ditado (chamado uma vez, ao concluir a transcrição). */
  onTranscript: (dictatedText: string) => void
  /** Disparado ao começar a gravar — capture o texto base do composer aqui. */
  onRecordingStart?: () => void
  disabled?: boolean
}) {
  const [status, setStatus] = React.useState<VoiceDictationStatus>("idle")

  const mediaRef = React.useRef<MediaStream | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const abortRef = React.useRef<AbortController | null>(null)
  const sessionIdRef = React.useRef(0)

  const onTranscriptRef = React.useRef(opts.onTranscript)
  onTranscriptRef.current = opts.onTranscript
  const onRecordingStartRef = React.useRef(opts.onRecordingStart)
  onRecordingStartRef.current = opts.onRecordingStart

  const stopTracks = React.useCallback(() => {
    mediaRef.current?.getTracks().forEach((t) => t.stop())
    mediaRef.current = null
  }, [])

  const stopRecorderToBlob = React.useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          const type = recorder.mimeType || "audio/webm"
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

  React.useEffect(() => {
    return () => {
      sessionIdRef.current += 1
      abortRef.current?.abort()
      try {
        recorderRef.current?.stop()
      } catch {
        /* ignore */
      }
      recorderRef.current = null
      chunksRef.current = []
      stopTracks()
    }
  }, [stopTracks])

  const stopAndFinalize = React.useCallback(async () => {
    const sessionId = sessionIdRef.current
    setStatus("transcribing")

    const blob = await stopRecorderToBlob()
    stopTracks()

    if (sessionIdRef.current !== sessionId) return
    if (!blob || blob.size < MIN_BLOB_BYTES) {
      toast.message("Não capturamos fala reconhecível. Tente de novo.")
      setStatus("idle")
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const text = await transcribeAudioBlob(blob, {
        language: "pt",
        signal: controller.signal,
      })
      if (sessionIdRef.current !== sessionId || controller.signal.aborted) return
      if (text) onTranscriptRef.current(text)
    } catch (err) {
      if (sessionIdRef.current !== sessionId || controller.signal.aborted) return
      toast.error(
        err instanceof Error ? err.message : "Falha ao transcrever o áudio.",
      )
    } finally {
      if (sessionIdRef.current === sessionId) setStatus("idle")
    }
  }, [stopRecorderToBlob, stopTracks])

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
      chunksRef.current = []
      mediaRef.current = stream

      onRecordingStartRef.current?.()

      const mimeType = pickMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      recorder.start(1000)

      setStatus("recording")
    } catch (err) {
      stopTracks()
      recorderRef.current = null
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
  }, [opts.disabled, stopTracks])

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
    sessionIdRef.current += 1
    abortRef.current?.abort()
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop()
      }
    } catch {
      /* ignore */
    }
    recorderRef.current = null
    chunksRef.current = []
    stopTracks()
    setStatus("idle")
  }, [stopTracks])

  return {
    status,
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
