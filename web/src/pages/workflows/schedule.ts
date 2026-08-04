/**
 * Agendamento de workflows na linguagem do usuário: rótulos em português,
 * conversão para o formato da API e validação do formulário.
 */
import { formatDateTime } from "@/lib/format"
import type {
  WorkflowSchedule,
  WorkflowScheduleFreq,
} from "@/lib/workflows/api"

export const FREQ_LABEL: Record<WorkflowScheduleFreq, string> = {
  daily: "Diário",
  weekly: "Semanal",
  monthly: "Mensal",
  once: "Uma vez",
}

export const FREQ_OPTIONS: WorkflowScheduleFreq[] = [
  "daily",
  "weekly",
  "monthly",
  "once",
]

/** 1 = segunda … 7 = domingo, igual ao contrato da API. */
export const WEEKDAYS: ReadonlyArray<{
  value: number
  short: string
  abbr: string
  label: string
}> = [
  { value: 1, short: "S", abbr: "Seg", label: "Segunda" },
  { value: 2, short: "T", abbr: "Ter", label: "Terça" },
  { value: 3, short: "Q", abbr: "Qua", label: "Quarta" },
  { value: 4, short: "Q", abbr: "Qui", label: "Quinta" },
  { value: 5, short: "S", abbr: "Sex", label: "Sexta" },
  { value: 6, short: "S", abbr: "Sáb", label: "Sábado" },
  { value: 7, short: "D", abbr: "Dom", label: "Domingo" },
]

const horaFormatter = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

function abreviacaoDia(value: number): string {
  return WEEKDAYS.find((d) => d.value === value)?.abbr ?? String(value)
}

/** ["Seg", "Qua", "Sex"] → "Seg, Qua e Sex". */
function listarComE(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? ""
  return `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`
}

/**
 * "YYYY-MM-DD" → "15/08" (com ano quando não é o ano corrente). Parse manual:
 * `new Date("2026-08-15")` é meia-noite UTC e viraria 14/08 no Brasil.
 */
function formatDiaMes(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  const [, ano, mes, dia] = match
  return Number(ano) === new Date().getFullYear()
    ? `${dia}/${mes}`
    : `${dia}/${mes}/${ano}`
}

/** Resumo legível do agendamento: "Seg, Qua e Sex às 09:30". */
export function formatSchedule(
  schedule: WorkflowSchedule | null | undefined,
): string {
  if (!schedule?.freq) return "Sem agendamento"
  const hora = schedule.time || "--:--"
  switch (schedule.freq) {
    case "daily":
      return `Diário às ${hora}`
    case "weekly": {
      const dias = (schedule.weekdays ?? [])
        .filter((d) => d >= 1 && d <= 7)
        .sort((a, b) => a - b)
      if (dias.length === 0) return `Semanal às ${hora}`
      if (dias.length === 7) return `Todos os dias às ${hora}`
      return `${listarComE(dias.map(abreviacaoDia))} às ${hora}`
    }
    case "monthly":
      return `Todo dia ${schedule.day_of_month ?? 1} às ${hora}`
    case "once":
      return schedule.date
        ? `Uma vez em ${formatDiaMes(schedule.date)} às ${hora}`
        : `Uma vez às ${hora}`
    default:
      return `Às ${hora}`
  }
}

/** "hoje 18:00" / "amanhã 08:00" / "12/09/2026 08:00". */
export function formatNextRun(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null

  const hora = horaFormatter.format(date)
  const hoje = new Date()
  const inicioHoje = new Date(
    hoje.getFullYear(),
    hoje.getMonth(),
    hoje.getDate(),
  ).getTime()
  const inicioAlvo = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime()
  const dias = Math.round((inicioAlvo - inicioHoje) / 86_400_000)

  if (dias === 0) return `hoje ${hora}`
  if (dias === 1) return `amanhã ${hora}`
  return formatDateTime(date)
}

/** Duração de uma execução: "42 s" / "2 min 8 s". */
export function formatDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): string | null {
  if (!startedAt || !finishedAt) return null
  const inicio = new Date(startedAt).getTime()
  const fim = new Date(finishedAt).getTime()
  if (Number.isNaN(inicio) || Number.isNaN(fim) || fim < inicio) return null
  const totalSeg = Math.round((fim - inicio) / 1000)
  if (totalSeg < 1) return "menos de 1 s"
  if (totalSeg < 60) return `${totalSeg} s`
  const min = Math.floor(totalSeg / 60)
  const seg = totalSeg % 60
  return seg === 0 ? `${min} min` : `${min} min ${seg} s`
}

/** Estado do bloco de agendamento no dialog. */
export interface ScheduleForm {
  freq: WorkflowScheduleFreq
  time: string
  weekdays: number[]
  dayOfMonth: number
  date: string
}

export const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  freq: "daily",
  time: "08:00",
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  date: "",
}

/** Workflow existente → estado do formulário (sem perder o que não se aplica). */
export function scheduleToForm(
  schedule: WorkflowSchedule | null | undefined,
): ScheduleForm {
  if (!schedule?.freq) return { ...DEFAULT_SCHEDULE_FORM }
  const weekdays = (schedule.weekdays ?? []).filter((d) => d >= 1 && d <= 7)
  return {
    freq: schedule.freq,
    time: /^\d{2}:\d{2}$/.test(schedule.time ?? "")
      ? schedule.time
      : DEFAULT_SCHEDULE_FORM.time,
    weekdays: weekdays.length ? weekdays.sort((a, b) => a - b) : [...DEFAULT_SCHEDULE_FORM.weekdays],
    dayOfMonth: schedule.day_of_month ?? DEFAULT_SCHEDULE_FORM.dayOfMonth,
    date: schedule.date ?? "",
  }
}

/** Só envia os campos da frequência escolhida — o resto sujaria o jsonb. */
export function formToSchedule(form: ScheduleForm): WorkflowSchedule {
  const base: WorkflowSchedule = { freq: form.freq, time: form.time }
  if (form.freq === "weekly") {
    return { ...base, weekdays: [...form.weekdays].sort((a, b) => a - b) }
  }
  if (form.freq === "monthly") return { ...base, day_of_month: form.dayOfMonth }
  if (form.freq === "once") return { ...base, date: form.date }
  return base
}

/** Mensagem de erro em português, ou null quando o agendamento está válido. */
export function validateScheduleForm(form: ScheduleForm): string | null {
  if (!/^\d{2}:\d{2}$/.test(form.time)) {
    return "Informe o horário da execução."
  }
  if (form.freq === "weekly" && form.weekdays.length === 0) {
    return "Escolha pelo menos um dia da semana."
  }
  if (
    form.freq === "monthly" &&
    (!Number.isInteger(form.dayOfMonth) ||
      form.dayOfMonth < 1 ||
      form.dayOfMonth > 28)
  ) {
    return "Escolha um dia do mês entre 1 e 28."
  }
  if (form.freq === "once") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      return "Escolha a data da execução."
    }
    // Data + hora locais: um horário já passado nunca dispararia.
    const alvo = new Date(`${form.date}T${form.time}:00`)
    if (Number.isNaN(alvo.getTime())) return "Escolha a data da execução."
    if (alvo.getTime() <= Date.now()) {
      return "A data e a hora devem estar no futuro."
    }
  }
  return null
}

/** Valor mínimo do input date (hoje, no fuso local). */
export function hojeIso(): string {
  const hoje = new Date()
  const mes = String(hoje.getMonth() + 1).padStart(2, "0")
  const dia = String(hoje.getDate()).padStart(2, "0")
  return `${hoje.getFullYear()}-${mes}-${dia}`
}
