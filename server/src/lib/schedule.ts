/**
 * Agendamento amigável dos workflows (sem cron string) + cálculo do próximo
 * disparo.
 *
 * LIMITAÇÃO DE TIMEZONE: a conversão local↔UTC usa OFFSET FIXO por timezone
 * (mapa abaixo), não o banco de fusos do sistema. Isso vale para o Brasil, que
 * não tem horário de verão desde 2019 (Decreto 9.772/2019) — e para UTC. Fusos
 * com DST (Europa/EUA) ficariam 1h deslocados em parte do ano, por isso eles
 * NÃO são aceitos: `isSupportedTimezone` recusa o que não está no mapa. Se um
 * dia precisar de DST, trocar as duas funções `local*` por Intl/Temporal.
 */
import { z } from "zod"

export const DEFAULT_TIMEZONE = "America/Sao_Paulo"

/** Offset fixo (minutos em relação a UTC) dos fusos aceitos. */
const TIMEZONE_OFFSET_MINUTES: Record<string, number> = {
  "America/Noronha": -120,
  "America/Sao_Paulo": -180,
  "America/Bahia": -180,
  "America/Belem": -180,
  "America/Fortaleza": -180,
  "America/Maceio": -180,
  "America/Recife": -180,
  "America/Araguaina": -180,
  "America/Santarem": -180,
  "America/Campo_Grande": -240,
  "America/Cuiaba": -240,
  "America/Manaus": -240,
  "America/Boa_Vista": -240,
  "America/Porto_Velho": -240,
  "America/Rio_Branco": -300,
  "America/Eirunepe": -300,
  UTC: 0,
  "Etc/UTC": 0,
}

/** true se o fuso tem offset fixo conhecido (ver limitação no topo). */
export function isSupportedTimezone(timezone: string): boolean {
  return Object.hasOwn(TIMEZONE_OFFSET_MINUTES, timezone)
}

/** Offset do fuso; desconhecido cai no default (America/Sao_Paulo). */
export function timezoneOffsetMinutes(timezone: string): number {
  return (
    TIMEZONE_OFFSET_MINUTES[timezone] ??
    TIMEZONE_OFFSET_MINUTES[DEFAULT_TIMEZONE] ??
    0
  )
}

export const SCHEDULE_FREQS = ["daily", "weekly", "monthly", "once"] as const
export type ScheduleFreq = (typeof SCHEDULE_FREQS)[number]

export interface WorkflowSchedule {
  freq: ScheduleFreq
  /** HH:mm (24h) no timezone do workflow. */
  time: string
  /** ISO: 1=segunda … 7=domingo. Só em freq='weekly'. */
  weekdays?: number[]
  /** 1..28 — evita meses curtos. Só em freq='monthly'. */
  day_of_month?: number
  /** YYYY-MM-DD. Só em freq='once'. */
  date?: string
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const MINUTE_MS = 60_000

/** Data de calendário existente (recusa 2026-02-31). */
function isRealDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  const probe = new Date(Date.UTC(y, m - 1, d))
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  )
}

/** Validação do JSON de agendamento vindo do front (ver rotas /api/workflows). */
export const scheduleSchema = z
  .strictObject({
    freq: z.enum(SCHEDULE_FREQS),
    time: z
      .string()
      .regex(TIME_RE, "time deve estar no formato HH:mm (24h), ex. 08:30."),
    weekdays: z
      .array(
        z
          .number()
          .int()
          .min(1, "weekdays vai de 1 (segunda) a 7 (domingo).")
          .max(7, "weekdays vai de 1 (segunda) a 7 (domingo)."),
      )
      .min(1, "Informe ao menos um dia da semana em weekdays.")
      .max(7, "weekdays aceita no máximo 7 dias.")
      .optional(),
    day_of_month: z
      .number()
      .int()
      .min(1, "day_of_month vai de 1 a 28.")
      .max(28, "day_of_month vai de 1 a 28 (evita meses curtos).")
      .optional(),
    date: z
      .string()
      .regex(DATE_RE, "date deve estar no formato YYYY-MM-DD.")
      .optional(),
  })
  .superRefine((s, ctx) => {
    if (s.freq === "weekly" && (!s.weekdays || s.weekdays.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["weekdays"],
        message:
          "Para freq 'weekly', informe weekdays (1=segunda … 7=domingo).",
      })
    }
    if (s.freq === "monthly" && s.day_of_month === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["day_of_month"],
        message: "Para freq 'monthly', informe day_of_month (1 a 28).",
      })
    }
    if (s.freq === "once") {
      if (!s.date) {
        ctx.addIssue({
          code: "custom",
          path: ["date"],
          message: "Para freq 'once', informe date (YYYY-MM-DD).",
        })
      } else if (!isRealDate(s.date)) {
        ctx.addIssue({
          code: "custom",
          path: ["date"],
          message: "date não é uma data de calendário válida.",
        })
      }
    }
  })

/** Descarta campos que não pertencem à frequência e ordena weekdays. */
export function normalizeSchedule(schedule: WorkflowSchedule): WorkflowSchedule {
  const base = { freq: schedule.freq, time: schedule.time }
  if (schedule.freq === "weekly") {
    return {
      ...base,
      weekdays: [...new Set(schedule.weekdays ?? [])].sort((a, b) => a - b),
    }
  }
  if (schedule.freq === "monthly") {
    return { ...base, day_of_month: schedule.day_of_month }
  }
  if (schedule.freq === "once") {
    return { ...base, date: schedule.date }
  }
  return base
}

/** Lê um schedule persistido (jsonb) — inválido/legado → null. */
export function parseSchedule(raw: unknown): WorkflowSchedule | null {
  const parsed = scheduleSchema.safeParse(raw)
  return parsed.success ? normalizeSchedule(parsed.data) : null
}

function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(":").map(Number) as [number, number]
  return { hours: h, minutes: m }
}

/** Instante UTC (ms) de um horário de parede no fuso do workflow. */
function localToUtcMs(
  parts: {
    year: number
    month: number
    day: number
    hours: number
    minutes: number
  },
  offsetMinutes: number,
): number {
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hours,
      parts.minutes,
      0,
      0,
    ) -
    offsetMinutes * MINUTE_MS
  )
}

/** Componentes do horário de parede de um instante, no fuso do workflow. */
function utcToLocalParts(
  at: Date,
  offsetMinutes: number,
): { year: number; month: number; day: number; isoWeekday: number } {
  const shifted = new Date(at.getTime() + offsetMinutes * MINUTE_MS)
  const dow = shifted.getUTCDay()
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    isoWeekday: dow === 0 ? 7 : dow,
  }
}

/** ISO weekday (1=segunda … 7=domingo) de uma data de calendário. */
function isoWeekdayOf(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dow === 0 ? 7 : dow
}

/**
 * Próximo disparo ESTRITAMENTE depois de `from`.
 * - daily: próxima ocorrência do horário
 * - weekly: próximo dia da lista `weekdays`
 * - monthly: próximo `day_of_month`
 * - once: data+hora única — já passou → null (não agenda mais nada)
 * Schedule inconsistente (weekly sem weekdays etc.) → null.
 */
export function computeNextRun(
  schedule: WorkflowSchedule,
  timezone: string,
  from: Date,
): Date | null {
  const offset = timezoneOffsetMinutes(timezone)
  const { hours, minutes } = parseTime(schedule.time)
  const local = utcToLocalParts(from, offset)
  const fromMs = from.getTime()

  if (schedule.freq === "once") {
    if (!schedule.date || !isRealDate(schedule.date)) return null
    const [year, month, day] = schedule.date.split("-").map(Number) as [
      number,
      number,
      number,
    ]
    const at = localToUtcMs({ year, month, day, hours, minutes }, offset)
    return at > fromMs ? new Date(at) : null
  }

  if (schedule.freq === "daily") {
    for (let i = 0; i <= 1; i++) {
      const at = localToUtcMs(
        {
          year: local.year,
          month: local.month,
          day: local.day + i,
          hours,
          minutes,
        },
        offset,
      )
      if (at > fromMs) return new Date(at)
    }
    return null
  }

  if (schedule.freq === "weekly") {
    const weekdays = [...new Set(schedule.weekdays ?? [])]
    if (weekdays.length === 0) return null
    // Até 8 dias à frente cobre qualquer dia da lista (inclusive hoje amanhã).
    for (let i = 0; i <= 7; i++) {
      const probe = new Date(
        Date.UTC(local.year, local.month - 1, local.day + i),
      )
      const dow = isoWeekdayOf(
        probe.getUTCFullYear(),
        probe.getUTCMonth() + 1,
        probe.getUTCDate(),
      )
      if (!weekdays.includes(dow)) continue
      const at = localToUtcMs(
        {
          year: local.year,
          month: local.month,
          day: local.day + i,
          hours,
          minutes,
        },
        offset,
      )
      if (at > fromMs) return new Date(at)
    }
    return null
  }

  // monthly
  const dom = schedule.day_of_month
  if (dom === undefined) return null
  for (let i = 0; i <= 1; i++) {
    const at = localToUtcMs(
      {
        year: local.year,
        month: local.month + i,
        day: dom,
        hours,
        minutes,
      },
      offset,
    )
    if (at > fromMs) return new Date(at)
  }
  return null
}

/** "DD/MM" no fuso do workflow — título da conversa gerada pela execução. */
export function formatLocalDayMonth(at: Date, timezone: string): string {
  const { day, month } = utcToLocalParts(at, timezoneOffsetMinutes(timezone))
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`
}
