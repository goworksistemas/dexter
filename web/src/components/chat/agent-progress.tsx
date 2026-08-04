/**
 * Painel de atividade do agente — o que o Dexter está fazendo em tempo real.
 *
 * Colapsado: bolinhas + fase atual ("Consultando PipeGo…") + tempo decorrido.
 * Expandido: timeline dos passos (tool, sistema, duração, resumo do retorno).
 * Depois de concluído vira um "Ver detalhes" discreto com o histórico daquela
 * resposta (do run ao vivo ou de `GET /api/chats/:id/steps`).
 *
 * Os resumos já vêm truncados do backend (`server/src/systems/progress.ts`) —
 * aqui não há payload cru.
 */
import { useEffect, useId, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  Wrench,
} from "lucide-react"

import { formatarDuracao, type RunStep } from "@/lib/chats"
import { cn } from "@/lib/utils"

/** Preferência de expansão dentro da sessão: quem abriu uma vez continua vendo. */
let preferenciaExpandido = false

interface AgentActivityProps {
  steps: RunStep[]
  /** Fase atual (ex.: "Gerando resposta") — só faz sentido enquanto roda. */
  statusText?: string
  running: boolean
  startedAt?: number
  finishedAt?: number
}

function useCronometro(ativo: boolean, inicio?: number, fim?: number): number {
  const [agora, setAgora] = useState(() => Date.now())

  useEffect(() => {
    if (!ativo) return
    setAgora(Date.now())
    const id = window.setInterval(() => setAgora(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [ativo])

  if (inicio === undefined) return 0
  const referencia = ativo ? agora : (fim ?? agora)
  return Math.max(0, referencia - inicio)
}

export function AgentActivity({
  steps,
  statusText,
  running,
  startedAt,
  finishedAt,
}: AgentActivityProps) {
  const [aberto, setAberto] = useState(() => running && preferenciaExpandido)
  const painelId = useId()
  const listaRef = useRef<HTMLOListElement>(null)
  const decorrido = useCronometro(running, startedAt, finishedAt)

  useEffect(() => {
    if (!aberto) return
    const el = listaRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [aberto, steps])

  if (!running && steps.length === 0) return null

  const passos = steps.length
  const sufixoPassos =
    passos > 0 ? ` · ${passos} ${passos === 1 ? "passo" : "passos"}` : ""
  const travado = running && (statusText?.startsWith("Sem resposta há") ?? false)
  const titulo = running
    ? `${statusText ?? "Processando"}…${sufixoPassos}`
    : `Ver detalhes${sufixoPassos}`

  const tempo = running
    ? formatarDuracao(decorrido)
    : finishedAt !== undefined && startedAt !== undefined
      ? formatarDuracao(finishedAt - startedAt)
      : ""

  const alternar = () => {
    setAberto((v) => {
      if (running) preferenciaExpandido = !v
      return !v
    })
  }

  return (
    <div className="w-full">
      {/* Região live separada do botão: leitores de tela anunciam a fase atual
          sem competir com o nome acessível do próprio botão. */}
      <span role="status" aria-live="polite" className="sr-only">
        {running ? `Dexter: ${statusText ?? "processando"}` : ""}
      </span>
      <button
        type="button"
        onClick={alternar}
        aria-expanded={aberto}
        aria-controls={painelId}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] transition-colors sm:text-xs",
          travado
            ? "border-amber-500/40 bg-amber-500/10 text-amber-800 hover:border-amber-500/55 dark:text-amber-300"
            : running
              ? "border-primary/25 bg-primary/[0.06] text-foreground/90 hover:border-primary/40"
              : "border-border/60 bg-card/50 text-muted-foreground hover:border-primary/25 hover:bg-card hover:text-foreground",
        )}
      >
        {running ? (
          <BolinhasProcessando />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-primary/70" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{titulo}</span>
        {tempo && (
          <span className="shrink-0 tabular-nums text-muted-foreground">{tempo}</span>
        )}
        {aberto ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {aberto && (
        <ol
          id={painelId}
          ref={listaRef}
          className="scroll-thin mt-1.5 max-h-72 space-y-0.5 overflow-y-auto rounded-xl border border-border/60 bg-card/40 p-1.5"
        >
          {steps.length === 0 ? (
            <li className="px-1.5 py-1 text-[11px] text-muted-foreground sm:text-xs">
              {statusText ?? "Pensando"}… nenhuma consulta necessária até agora.
            </li>
          ) : (
            steps.map((step) => <PassoItem key={step.id} step={step} />)
          )}
          {running && steps.length > 0 && (
            <li className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-muted-foreground sm:text-xs">
              <CircleDashed className="size-3.5 shrink-0 animate-spin text-primary/60" />
              Em andamento…
            </li>
          )}
        </ol>
      )}
    </div>
  )
}

function PassoItem({ step }: { step: RunStep }) {
  const erro = step.status === "error"
  return (
    <li className="flex gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/40">
      <span className="mt-0.5 shrink-0">
        {step.status === "running" ? (
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
        ) : erro ? (
          <CircleAlert className="size-3.5 text-destructive" />
        ) : (
          <CircleCheck className="size-3.5 text-primary/80" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground sm:text-xs"
            title={step.tool}
          >
            {step.label}
          </span>
          {step.durationMs !== undefined && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatarDuracao(step.durationMs)}
            </span>
          )}
        </div>
        {step.argsSummary && (
          <p className="mt-0.5 break-words font-mono text-[11px] leading-snug text-muted-foreground/90">
            {step.argsSummary}
          </p>
        )}
        {step.status !== "running" && step.summary && (
          <p
            className={cn(
              "mt-0.5 break-words text-[11px] leading-snug",
              erro ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {erro ? `Falhou: ${step.summary}` : step.summary}
          </p>
        )}
      </div>
    </li>
  )
}

function BolinhasProcessando() {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1">
      <span className="size-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-primary/70" />
    </span>
  )
}
