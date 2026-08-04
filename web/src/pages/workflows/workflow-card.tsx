/**
 * Card de um workflow na lista: agendamento legível, switch Ativo, badge da
 * última execução, ações e histórico das últimas execuções sob demanda.
 */
import * as React from "react"
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatRelative } from "@/lib/dates"
import { cn } from "@/lib/utils"
import {
  fetchWorkflowRuns,
  type Workflow,
  type WorkflowRun,
} from "@/lib/workflows/api"
import { formatDuration, formatNextRun, formatSchedule } from "./schedule"

const TRIGGER_LABEL: Record<WorkflowRun["trigger"], string> = {
  schedule: "Agendado",
  manual: "Manual",
}

/** Switch acessível (role/aria-checked) com estado ocupado no próprio pino. */
function Switch({
  checked,
  onChange,
  label,
  busy,
}: {
  checked: boolean
  onChange: () => void
  label: string
  busy?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-flex size-4 items-center justify-center rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      >
        {busy ? (
          <Loader2 className="size-2.5 animate-spin text-muted-foreground" />
        ) : null}
      </span>
    </button>
  )
}

/** Badge da última execução; o erro completo fica no tooltip. */
function LastRunBadge({
  run,
  onOpenChat,
}: {
  run: WorkflowRun
  onOpenChat: (chatId: string) => void
}) {
  const quando = formatRelative(run.started_at)

  if (run.status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3 animate-spin" />
        Executando…
      </span>
    )
  }

  if (run.status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/30"
            >
              <X aria-hidden className="size-3" />
              Falhou {quando}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {run.error || "Sem detalhes do erro."}
          </TooltipContent>
        </Tooltip>
        {run.chat_id ? (
          <VerResultado chatId={run.chat_id} onOpenChat={onOpenChat} />
        ) : null}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-600/30 bg-emerald-600/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
        <Check aria-hidden className="size-3" />
        Concluído {quando}
      </span>
      {run.chat_id ? (
        <VerResultado chatId={run.chat_id} onOpenChat={onOpenChat} />
      ) : null}
    </span>
  )
}

function VerResultado({
  chatId,
  onOpenChat,
}: {
  chatId: string
  onOpenChat: (chatId: string) => void
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto p-0 text-xs"
      onClick={() => onOpenChat(chatId)}
    >
      Ver resultado
    </Button>
  )
}

export interface WorkflowCardProps {
  workflow: Workflow
  toggling: boolean
  running: boolean
  deleting: boolean
  onToggle: () => void
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenChat: (chatId: string) => void
}

export function WorkflowCard({
  workflow,
  toggling,
  running,
  deleting,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onOpenChat,
}: WorkflowCardProps) {
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [runs, setRuns] = React.useState<WorkflowRun[]>([])
  const [loadingRuns, setLoadingRuns] = React.useState(false)
  const [runsError, setRunsError] = React.useState<string | null>(null)
  const [runsToken, setRunsToken] = React.useState(0)

  const lastRun = workflow.lastRun ?? null
  const emExecucao = running || lastRun?.status === "running"
  const proxima = workflow.enabled ? formatNextRun(workflow.next_run_at) : null

  // Recarrega ao abrir e a cada mudança da última execução (o poll da página
  // atualiza `lastRun`, então o histórico aberto não fica velho).
  React.useEffect(() => {
    if (!historyOpen) return
    const controller = new AbortController()
    setLoadingRuns(true)
    setRunsError(null)
    fetchWorkflowRuns(workflow.id, controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setRuns(list)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setRunsError(
          err instanceof Error ? err.message : "Falha ao carregar o histórico.",
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRuns(false)
      })
    return () => controller.abort()
  }, [historyOpen, workflow.id, lastRun?.id, lastRun?.status, runsToken])

  const historyId = `workflow-history-${workflow.id}`

  return (
    <div
      aria-busy={deleting || undefined}
      className={cn(
        "rounded-xl border border-border bg-card p-4 transition-opacity",
        deleting && "pointer-events-none opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-card-foreground">
            {workflow.name}
          </h2>
          {workflow.description ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {workflow.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {workflow.enabled ? "Ativo" : "Pausado"}
          </span>
          <Switch
            checked={workflow.enabled}
            busy={toggling}
            onChange={onToggle}
            label={
              workflow.enabled
                ? `Pausar workflow ${workflow.name}`
                : `Ativar workflow ${workflow.name}`
            }
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock aria-hidden className="size-3.5" />
          {formatSchedule(workflow.schedule)}
        </span>
        {proxima ? (
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock aria-hidden className="size-3.5" />
            Próxima: {proxima}
          </span>
        ) : null}
        {lastRun ? (
          <LastRunBadge run={lastRun} onOpenChat={onOpenChat} />
        ) : (
          <span>Nunca executado</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={emExecucao}
          onClick={onRunNow}
        >
          {emExecucao ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          {emExecucao ? "Executando…" : "Executar agora"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
          Editar
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          Excluir
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5"
          aria-expanded={historyOpen}
          aria-controls={historyId}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 transition-transform",
              historyOpen && "rotate-180",
            )}
          />
          Histórico
        </Button>
      </div>

      {historyOpen ? (
        <div id={historyId} className="mt-3 border-t border-border pt-3">
          {loadingRuns ? (
            <p className="text-xs text-muted-foreground">
              Carregando execuções…
            </p>
          ) : runsError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <p className="text-xs font-medium text-destructive">
                Não foi possível carregar o histórico.
              </p>
              <p className="mt-1 text-xs break-words text-muted-foreground">
                {runsError}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setRunsToken((t) => t + 1)}
              >
                Tentar novamente
              </Button>
            </div>
          ) : runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhuma execução ainda.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {runs.map((run) => {
                const duracao = formatDuration(run.started_at, run.finished_at)
                const chatId = run.chat_id
                return (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                  >
                    {run.status === "running" ? (
                      <Loader2
                        aria-label="Executando"
                        className="size-3.5 shrink-0 animate-spin"
                      />
                    ) : run.status === "error" ? (
                      <AlertCircle
                        aria-label="Erro"
                        className="size-3.5 shrink-0 text-destructive"
                      />
                    ) : (
                      <Check
                        aria-label="Sucesso"
                        className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                      />
                    )}
                    <span className="text-foreground">
                      {formatRelative(run.started_at)}
                    </span>
                    <span aria-hidden>·</span>
                    <span>{TRIGGER_LABEL[run.trigger]}</span>
                    {duracao ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{duracao}</span>
                      </>
                    ) : null}
                    {run.status === "error" && run.error ? (
                      <span className="min-w-0 basis-full truncate text-destructive sm:basis-auto">
                        {run.error}
                      </span>
                    ) : null}
                    {chatId ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="ml-auto gap-1"
                        onClick={() => onOpenChat(chatId)}
                      >
                        <MessageSquare className="size-3" />
                        Conversa
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
