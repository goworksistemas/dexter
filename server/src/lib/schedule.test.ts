import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  computeNextRun,
  formatLocalDayMonth,
  isSupportedTimezone,
  normalizeSchedule,
  parseSchedule,
  timezoneOffsetMinutes,
  type WorkflowSchedule,
} from "./schedule.js";

describe("isSupportedTimezone / timezoneOffsetMinutes", () => {
  it("aceita America/Sao_Paulo e UTC", () => {
    expect(isSupportedTimezone("America/Sao_Paulo")).toBe(true);
    expect(isSupportedTimezone("UTC")).toBe(true);
    expect(isSupportedTimezone("Europe/Lisbon")).toBe(false);
  });

  it("offset de SP é -180; desconhecido cai no default", () => {
    expect(timezoneOffsetMinutes("America/Sao_Paulo")).toBe(-180);
    expect(timezoneOffsetMinutes("UTC")).toBe(0);
    expect(timezoneOffsetMinutes("Europe/Lisbon")).toBe(
      timezoneOffsetMinutes(DEFAULT_TIMEZONE),
    );
  });
});

describe("parseSchedule / normalizeSchedule", () => {
  it("normaliza weekly ordenando e deduplicando weekdays", () => {
    expect(
      normalizeSchedule({
        freq: "weekly",
        time: "09:00",
        weekdays: [3, 1, 1, 7],
      }),
    ).toEqual({ freq: "weekly", time: "09:00", weekdays: [1, 3, 7] });
  });

  it("daily descarta campos estranhos", () => {
    expect(
      normalizeSchedule({
        freq: "daily",
        time: "08:30",
        weekdays: [1],
        day_of_month: 10,
        date: "2026-01-01",
      } as WorkflowSchedule),
    ).toEqual({ freq: "daily", time: "08:30" });
  });

  it("parse rejeita weekly sem weekdays e once com data impossível", () => {
    expect(parseSchedule({ freq: "weekly", time: "10:00" })).toBeNull();
    expect(
      parseSchedule({ freq: "once", time: "10:00", date: "2026-02-31" }),
    ).toBeNull();
    expect(
      parseSchedule({ freq: "monthly", time: "10:00", day_of_month: 15 }),
    ).toEqual({ freq: "monthly", time: "10:00", day_of_month: 15 });
  });

  it("parse rejeita day_of_month > 28", () => {
    expect(
      parseSchedule({ freq: "monthly", time: "10:00", day_of_month: 31 }),
    ).toBeNull();
  });
});

describe("computeNextRun", () => {
  const tz = "America/Sao_Paulo";

  it("daily: se o horário de hoje já passou, agenda amanhã", () => {
    const from = new Date("2026-08-05T18:00:00.000Z");
    const next = computeNextRun({ freq: "daily", time: "09:00" }, tz, from);
    expect(next?.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });

  it("daily: se ainda não chegou o horário de hoje, agenda hoje", () => {
    const from = new Date("2026-08-05T11:00:00.000Z");
    const next = computeNextRun({ freq: "daily", time: "09:00" }, tz, from);
    expect(next?.toISOString()).toBe("2026-08-05T12:00:00.000Z");
  });

  it("daily: disparo deve ser estritamente depois de from", () => {
    const exactly = new Date("2026-08-05T12:00:00.000Z");
    const next = computeNextRun({ freq: "daily", time: "09:00" }, tz, exactly);
    expect(next?.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });

  it("weekly: weekday já passado na semana atual pula para a próxima ocorrência", () => {
    const from = new Date("2026-08-05T12:00:00.000Z");
    const next = computeNextRun(
      { freq: "weekly", time: "09:00", weekdays: [1] },
      tz,
      from,
    );
    expect(next?.toISOString()).toBe("2026-08-10T12:00:00.000Z");
  });

  it("weekly: se hoje é o weekday e o horário ainda não passou, usa hoje", () => {
    const from = new Date("2026-08-05T11:00:00.000Z");
    const next = computeNextRun(
      { freq: "weekly", time: "09:00", weekdays: [3] },
      tz,
      from,
    );
    expect(next?.toISOString()).toBe("2026-08-05T12:00:00.000Z");
  });

  it("weekly sem weekdays retorna null", () => {
    expect(
      computeNextRun({ freq: "weekly", time: "09:00" }, tz, new Date()),
    ).toBeNull();
  });

  it("monthly: dia 28 no fim do mês curto vai para o próximo mês", () => {
    const from = new Date("2026-02-28T13:00:00.000Z");
    const next = computeNextRun(
      { freq: "monthly", time: "09:00", day_of_month: 28 },
      tz,
      from,
    );
    expect(next?.toISOString()).toBe("2026-03-28T12:00:00.000Z");
  });

  it("monthly: day_of_month já passado no mês atual vai ao próximo mês", () => {
    const from = new Date("2026-01-15T15:00:00.000Z");
    const next = computeNextRun(
      { freq: "monthly", time: "08:00", day_of_month: 1 },
      tz,
      from,
    );
    expect(next?.toISOString()).toBe("2026-02-01T11:00:00.000Z");
  });

  it("monthly sem day_of_month retorna null", () => {
    expect(
      computeNextRun({ freq: "monthly", time: "09:00" }, tz, new Date()),
    ).toBeNull();
  });

  it("once futuro retorna a data; once passado retorna null", () => {
    const from = new Date("2026-08-05T12:00:00.000Z");
    const future = computeNextRun(
      { freq: "once", time: "15:00", date: "2026-08-10" },
      tz,
      from,
    );
    expect(future?.toISOString()).toBe("2026-08-10T18:00:00.000Z");
    const past = computeNextRun(
      { freq: "once", time: "08:00", date: "2026-08-01" },
      tz,
      from,
    );
    expect(past).toBeNull();
  });

  it("usa offset de UTC quando timezone é UTC", () => {
    const from = new Date("2026-08-05T08:00:00.000Z");
    const next = computeNextRun({ freq: "daily", time: "09:00" }, "UTC", from);
    expect(next?.toISOString()).toBe("2026-08-05T09:00:00.000Z");
  });
});

describe("formatLocalDayMonth", () => {
  it("formata DD/MM no fuso America/Sao_Paulo", () => {
    expect(
      formatLocalDayMonth(
        new Date("2026-08-05T02:00:00.000Z"),
        "America/Sao_Paulo",
      ),
    ).toBe("04/08");
    expect(
      formatLocalDayMonth(
        new Date("2026-08-05T03:00:00.000Z"),
        "America/Sao_Paulo",
      ),
    ).toBe("05/08");
  });

  it("em UTC não desloca o dia", () => {
    expect(
      formatLocalDayMonth(new Date("2026-01-05T00:30:00.000Z"), "UTC"),
    ).toBe("05/01");
  });
});
