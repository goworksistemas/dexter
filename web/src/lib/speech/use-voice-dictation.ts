/**
 * Ditado por voz ao vivo com autocorreção (estilo Claude).
 *
 * Em vez de transcrever fatias isoladas (que cortam palavras e perdem
 * contexto), cada passada retranscreve o ÁUDIO ACUMULADO desde o início:
 * o texto aparece enquanto você fala e vai se CORRIGINDO sozinho, porque o
 * modelo sempre revê a fala completa. Ao parar, uma passada final garante
 * o texto definitivo. Uma requisição em voo por vez.
 */
import * as React from "react"
import { toast } from "sonner"

import { transcribeAudioBlob } from "./api"

export type VoiceDictationStatus = "idle" | "recording" | "transcribing"

/** Intervalo mínimo entre passadas ao vivo. */
const LIVE_PASS_MS = 2_500
/** Áudio abaixo disso costuma ser ruído/clique sem fala. */
const MIN_BLOB_BYTES = 1_024
/** A cada bloco desses o intervalo ao vivo aumenta (o payload é cumulativo). */
const LIVE_STEP_BYTES = 512 * 1_024
/** Acima disso a prévia ao vivo para — só a passada final continua valendo. */
const LIVE_MAX_BYTES = 1_500_000
/** Idem por duração da sessão. */
const LIVE_MAX_MS = 60_000
/** MediaRecorder pode não emitir "stop" — não travar o botão esperando. */
const STOP_TIMEOUT_MS = 1_500

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
  /** Texto da sessão de ditado — chamado a cada passada (substitui, não anexa). */
  onTranscript: (dictatedText: string) => void
  /** Disparado ao começar a gravar — capture o texto base do composer aqui. */
  onRecordingStart?: () => void
  disabled?: boolean
}) {
  const [status, setStatus] = React.useState<VoiceDictationStatus>("idle")
  const [liveText, setLiveText] = React.useState("")

  const mediaRef = React.useRef<MediaStream | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  /** Todos os chunks da sessão — o Blob acumulado é um webm/opus válido. */
  const chunksRef = React.useRef<Blob[]>([])
  const mimeRef = React.useRef<string>("audio/webm")
  const abortRef = React.useRef<AbortController | null>(null)
  const sessionIdRef = React.useRef(0)
  const inFlightRef = React.useRef(false)
  const liveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bytes acumulados na sessão e início dela — teto das passadas ao vivo. */
  const totalBytesRef = React.useRef(0)
  const startedAtRef = React.useRef(0)
  const liveCapNoticeRef = React.useRef(false)

  const onTranscriptRef = React.useRef(opts.onTranscript)
  onTranscriptRef.current = opts.onTranscript
  const onRecordingStartRef = React.useRef(opts.onRecordingStart)
  onRecordingStartRef.current = opts.onRecordingStart

  const clearLiveTimer = React.useCallback(() => {
    if (liveTimerRef.current != null) {
      clearTimeout(liveTimerRef.current)
      liveTimerRef.current = null
    }
  }, [])

  const stopTracks = React.useCallback(() => {
    mediaRef.current?.getTracks().forEach((t) => t.stop())
    mediaRef.current = null
  }, [])

  const emitTranscript = React.useCallback((text: string) => {
    setLiveText(text)
    onTranscriptRef.current(text)
  }, [])

  const cumulativeBlob = React.useCallback((): Blob | null => {
    const parts = chunksRef.current
    if (!parts.length) return null
    const blob = new Blob(parts, { type: mimeRef.current })
    return blob.size >= MIN_BLOB_BYTES ? blob : null
  }, [])

  /**
   * Uma passada de transcrição do áudio acumulado. `final=false` é a passada
   * ao vivo (falha silenciosa — a próxima corrige); `final=true` é a do stop.
   */
  const transcribePass = React.useCallback(
    async (final: boolean): Promise<void> => {
      const sessionId = sessionIdRef.current
      const blob = cumulativeBlob()
      if (!blob) return
      if (inFlightRef.current && !final) return

      if (final) abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      inFlightRef.current = true
      try {
        const text = await transcribeAudioBlob(blob, {
          language: "pt",
          signal: controller.signal,
        })
        if (sessionIdRef.current !== sessionId || controller.signal.aborted) return
        // Substituição total: a passada nova viu TODO o áudio, então ela
        // corrige o que a anterior errou — nada de merge heurístico.
        if (text) emitTranscript(text)
      } catch (err) {
        if (sessionIdRef.current !== sessionId || controller.signal.aborted) return
        // Passada ao vivo que falhou não interrompe o ditado.
        if (final) {
          toast.error(
            err instanceof Error ? err.message : "Falha ao transcrever o áudio.",
          )
        }
      } finally {
        inFlightRef.current = false
      }
    },
    [cumulativeBlob, emitTranscript],
  )

  const scheduleLivePass = React.useCallback(() => {
    clearLiveTimer()
    const sessionId = sessionIdRef.current

    // Cada passada reenvia TODO o áudio da sessão: sem teto o tráfego e a CPU
    // crescem de forma quadrática (e o body estoura no proxy).
    const bytes = totalBytesRef.current
    const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0
    if (bytes > LIVE_MAX_BYTES || elapsed > LIVE_MAX_MS) {
      if (!liveCapNoticeRef.current) {
        liveCapNoticeRef.current = true
        toast.message(
          "Ditado longo: a prévia ao vivo pausou. O texto final vem ao parar a gravação.",
        )
      }
      return
    }
    const delay =
      LIVE_PASS_MS * Math.max(1, Math.ceil(bytes / LIVE_STEP_BYTES))

    liveTimerRef.current = setTimeout(async () => {
      if (sessionIdRef.current !== sessionId) return
      if (recorderRef.current?.state === "recording") {
        try {
          recorderRef.current.requestData()
        } catch {
          /* ignore */
        }
        await transcribePass(false)
        if (sessionIdRef.current === sessionId) scheduleLivePass()
      }
    }, delay)
  }, [clearLiveTimer, transcribePass])

  const stopRecorder = React.useCallback((): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === "inactive") {
      recorderRef.current = null
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true })
      try {
        if (recorder.state === "recording") recorder.requestData()
      } catch {
        /* ignore */
      }
      try {
        recorder.stop()
      } catch {
        resolve()
      }
    }).then(() => {
      recorderRef.current = null
    })
  }, [])

  React.useEffect(() => {
    return () => {
      sessionIdRef.current += 1
      abortRef.current?.abort()
      clearLiveTimer()
      try {
        recorderRef.current?.stop()
      } catch {
        /* ignore */
      }
      recorderRef.current = null
      chunksRef.current = []
      stopTracks()
    }
  }, [clearLiveTimer, stopTracks])

  const stopAndFinalize = React.useCallback(async () => {
    clearLiveTimer()
    setStatus("transcribing")
    const sessionId = sessionIdRef.current

    try {
      // Se o evento "stop" não chegar (device removido, recorder inconsistente),
      // o timeout garante que o botão de ditado não fique travado.
      await Promise.race([
        stopRecorder(),
        new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
      ])
      stopTracks()

      if (!cumulativeBlob()) {
        if (!liveText) {
          toast.message("Não capturamos fala reconhecível. Tente de novo.")
        }
        return
      }

      await transcribePass(true)
    } finally {
      // Sessão nova (cancel/novo start) já cuidou do próprio estado.
      if (sessionIdRef.current === sessionId) {
        chunksRef.current = []
        setStatus("idle")
      }
    }
  }, [
    clearLiveTimer,
    cumulativeBlob,
    liveText,
    stopRecorder,
    stopTracks,
    transcribePass,
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
      inFlightRef.current = false
      chunksRef.current = []
      totalBytesRef.current = 0
      startedAtRef.current = Date.now()
      liveCapNoticeRef.current = false
      setLiveText("")
      mediaRef.current = stream

      onRecordingStartRef.current?.()

      const mimeType = pickMimeType()
      mimeRef.current = mimeType?.split(";")[0] ?? "audio/webm"
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          chunksRef.current.push(ev.data)
          totalBytesRef.current += ev.data.size
        }
      }
      recorder.start(500)

      setStatus("recording")
      scheduleLivePass()
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
  }, [opts.disabled, scheduleLivePass, stopTracks])

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
    clearLiveTimer()
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop()
      }
    } catch {
      /* ignore */
    }
    recorderRef.current = null
    chunksRef.current = []
    totalBytesRef.current = 0
    startedAtRef.current = 0
    stopTracks()
    setLiveText("")
    setStatus("idle")
  }, [clearLiveTimer, stopTracks])

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
