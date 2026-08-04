/**
 * Dialog de criar/editar workflow: nome, descrição, instruções e agendamento
 * amigável (diário / semanal / mensal / uma vez).
 */
import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  browserTimezone,
  createWorkflow,
  updateWorkflow,
  type Workflow,
  type WorkflowScheduleFreq,
} from "@/lib/workflows/api"
import {
  DEFAULT_SCHEDULE_FORM,
  FREQ_LABEL,
  FREQ_OPTIONS,
  WEEKDAYS,
  formToSchedule,
  hojeIso,
  scheduleToForm,
  validateScheduleForm,
  type ScheduleForm,
} from "./schedule"

const PROMPT_PLACEHOLDER =
  "Resuma os chamados NetworkGo abertos ontem, destaque os urgentes e os sem responsável."

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"

/** Switch acessível do formulário (mesmo desenho do card). */
function Switch({
  id,
  checked,
  onChange,
  label,
}: {
  id: string
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      />
    </button>
  )
}

export interface WorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null/undefined → criação. */
  workflow?: Workflow | null
  onSaved: (workflow: Workflow, mode: "create" | "edit") => void
}

export function WorkflowDialog({
  open,
  onOpenChange,
  workflow,
  onSaved,
}: WorkflowDialogProps) {
  const mode: "create" | "edit" = workflow ? "edit" : "create"

  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [prompt, setPrompt] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)
  const [schedule, setSchedule] = React.useState<ScheduleForm>({
    ...DEFAULT_SCHEDULE_FORM,
  })
  const [saving, setSaving] = React.useState(false)
  const [nameError, setNameError] = React.useState<string | null>(null)
  const [promptError, setPromptError] = React.useState<string | null>(null)
  const [scheduleError, setScheduleError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setNameError(null)
    setPromptError(null)
    setScheduleError(null)
    if (workflow) {
      setName(workflow.name)
      setDescription(workflow.description ?? "")
      setPrompt(workflow.prompt)
      setEnabled(workflow.enabled)
      setSchedule(scheduleToForm(workflow.schedule))
    } else {
      setName("")
      setDescription("")
      setPrompt("")
      setEnabled(true)
      setSchedule({ ...DEFAULT_SCHEDULE_FORM })
    }
  }, [open, workflow])

  const patchSchedule = (patch: Partial<ScheduleForm>) => {
    setSchedule((prev) => ({ ...prev, ...patch }))
    setScheduleError(null)
  }

  const toggleWeekday = (value: number) => {
    setSchedule((prev) => ({
      ...prev,
      weekdays: prev.weekdays.includes(value)
        ? prev.weekdays.filter((d) => d !== value)
        : [...prev.weekdays, value].sort((a, b) => a - b),
    }))
    setScheduleError(null)
  }

  const handleSave = async () => {
    const nome = name.trim()
    const instrucoes = prompt.trim()
    let invalido = false

    if (!nome || nome.length > 120) {
      setNameError("Informe um nome de 1 a 120 caracteres.")
      invalido = true
    }
    if (!instrucoes) {
      setPromptError("Escreva o que o Dexter deve fazer nesta rotina.")
      invalido = true
    }
    const erroAgenda = validateScheduleForm(schedule)
    if (erroAgenda) {
      setScheduleError(erroAgenda)
      invalido = true
    }
    if (invalido) {
      toast.error(erroAgenda ?? "Revise os campos destacados.")
      return
    }

    setSaving(true)
    try {
      if (mode === "create") {
        const created = await createWorkflow({
          name: nome,
          description: description.trim() || null,
          prompt: instrucoes,
          schedule: formToSchedule(schedule),
          timezone: browserTimezone(),
          enabled,
        })
        toast.success("Workflow criado.")
        onSaved(created, "create")
      } else if (workflow) {
        const updated = await updateWorkflow(workflow.id, {
          name: nome,
          description: description.trim() || null,
          prompt: instrucoes,
          schedule: formToSchedule(schedule),
          enabled,
        })
        toast.success("Workflow atualizado.")
        onSaved(updated, "edit")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Falha ao salvar o workflow.",
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Novo workflow" : "Editar workflow"}
          </DialogTitle>
          <DialogDescription>
            O Dexter executa as instruções no horário escolhido e entrega o
            resultado como uma conversa.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSave()
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="workflow-name" className="text-sm font-medium">
              Nome
            </label>
            <Input
              id="workflow-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameError(null)
              }}
              placeholder="Ex.: Resumo diário dos chamados"
              maxLength={120}
              autoFocus
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "workflow-name-error" : undefined}
            />
            {nameError ? (
              <p id="workflow-name-error" className="text-xs text-destructive">
                {nameError}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="workflow-description"
              className="text-sm font-medium"
            >
              Descrição{" "}
              <span className="font-normal text-muted-foreground">
                (opcional)
              </span>
            </label>
            <Input
              id="workflow-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Para que serve esta rotina"
              maxLength={280}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="workflow-prompt" className="text-sm font-medium">
              Instruções
            </label>
            <Textarea
              id="workflow-prompt"
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value)
                setPromptError(null)
              }}
              placeholder={PROMPT_PLACEHOLDER}
              className="min-h-36"
              aria-invalid={promptError ? true : undefined}
              aria-describedby={
                promptError ? "workflow-prompt-error" : undefined
              }
            />
            {promptError ? (
              <p id="workflow-prompt-error" className="text-xs text-destructive">
                {promptError}
              </p>
            ) : null}
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <span className="text-sm font-medium">Agendamento</span>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="workflow-freq"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Frequência
                </label>
                <select
                  id="workflow-freq"
                  className={selectClass}
                  value={schedule.freq}
                  onChange={(e) =>
                    patchSchedule({
                      freq: e.target.value as WorkflowScheduleFreq,
                    })
                  }
                >
                  {FREQ_OPTIONS.map((freq) => (
                    <option key={freq} value={freq}>
                      {FREQ_LABEL[freq]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="workflow-time"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Horário
                </label>
                <Input
                  id="workflow-time"
                  type="time"
                  value={schedule.time}
                  onChange={(e) => patchSchedule({ time: e.target.value })}
                />
              </div>
            </div>

            {schedule.freq === "weekly" ? (
              <div className="space-y-1.5">
                <span
                  id="workflow-weekdays-label"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Dias da semana
                </span>
                <div
                  role="group"
                  aria-labelledby="workflow-weekdays-label"
                  className="flex flex-wrap gap-1.5"
                >
                  {WEEKDAYS.map((dia) => {
                    const ativo = schedule.weekdays.includes(dia.value)
                    return (
                      <button
                        key={dia.value}
                        type="button"
                        aria-label={dia.label}
                        aria-pressed={ativo}
                        title={dia.label}
                        onClick={() => toggleWeekday(dia.value)}
                        className={cn(
                          "size-8 rounded-full border text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                          ativo
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {dia.short}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {schedule.freq === "monthly" ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="workflow-day-of-month"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Dia do mês
                </label>
                <select
                  id="workflow-day-of-month"
                  className={cn(selectClass, "sm:w-32")}
                  value={schedule.dayOfMonth}
                  onChange={(e) =>
                    patchSchedule({ dayOfMonth: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((dia) => (
                    <option key={dia} value={dia}>
                      {dia}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Até o dia 28 para cair em todos os meses.
                </p>
              </div>
            ) : null}

            {schedule.freq === "once" ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="workflow-date"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Data
                </label>
                <Input
                  id="workflow-date"
                  type="date"
                  className="sm:w-48"
                  min={hojeIso()}
                  value={schedule.date}
                  onChange={(e) => patchSchedule({ date: e.target.value })}
                />
              </div>
            ) : null}

            {scheduleError ? (
              <p className="text-xs text-destructive">{scheduleError}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="workflow-enabled"
              checked={enabled}
              onChange={() => setEnabled((v) => !v)}
              label={enabled ? "Desativar workflow" : "Ativar workflow"}
            />
            <label htmlFor="workflow-enabled" className="text-sm">
              Ativo
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === "create" ? "Criar workflow" : "Salvar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
