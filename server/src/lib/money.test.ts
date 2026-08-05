import { describe, expect, it } from "vitest";
import { roundCostUsd } from "./money.js";

describe("roundCostUsd", () => {
  it("arredonda para 2 casas (half-up via Math.round)", () => {
    expect(roundCostUsd(1.234)).toBe(1.23);
    expect(roundCostUsd(1.235)).toBe(1.24);
    expect(roundCostUsd(10)).toBe(10);
  });

  it("trata zero", () => {
    expect(roundCostUsd(0)).toBe(0);
  });

  it("valores minúsculos abaixo de 0.005 viram 0", () => {
    expect(roundCostUsd(0.000001)).toBe(0);
    expect(roundCostUsd(0.004)).toBe(0);
    expect(roundCostUsd(0.005)).toBe(0.01);
  });

  it("preserva sinal em negativos e arredonda half away from zero", () => {
    expect(roundCostUsd(-1.234)).toBe(-1.23);
    expect(roundCostUsd(-0.005)).toBe(-0.01);
    expect(roundCostUsd(-0.006)).toBe(-0.01);
    expect(Object.is(roundCostUsd(-0.001), -0)).toBe(false);
    expect(roundCostUsd(-0.001)).toBe(0);
  });

  it("não-finitos (NaN/Infinity) viram 0", () => {
    expect(roundCostUsd(Number.NaN)).toBe(0);
    expect(roundCostUsd(Number.POSITIVE_INFINITY)).toBe(0);
    expect(roundCostUsd(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
