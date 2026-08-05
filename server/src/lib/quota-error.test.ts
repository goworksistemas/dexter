import { describe, expect, it } from "vitest"
import { isQuotaError } from "./quota-error.js"

describe("isQuotaError", () => {
  it("cota do plano esgotada (OpenAI/Gemini) marca depleted", () => {
    expect(
      isQuotaError(
        "You exceeded your current quota, please check your plan and billing details.",
      ),
    ).toBe(true)
    expect(isQuotaError("insufficient_quota: billing hard limit reached")).toBe(
      true,
    )
    expect(isQuotaError("Your credit balance is too low")).toBe(true)
    expect(isQuotaError("HTTP 402 Payment Required")).toBe(true)
  })

  it("rate limit transitório NÃO marca depleted", () => {
    expect(
      isQuotaError(
        "Quota exceeded for quota metric 'Generate Content API requests per minute'",
      ),
    ).toBe(false)
    expect(
      isQuotaError("Rate limit reached for gpt-4o. Please try again in 20s."),
    ).toBe(false)
    expect(isQuotaError("gemini HTTP 429: resource exhausted")).toBe(false)
    expect(
      isQuotaError(
        "Limite de requisições da gemini atingido (HTTP 429). Aguarde um momento e tente novamente.",
      ),
    ).toBe(false)
  })

  it("erro comum de API não marca depleted", () => {
    expect(isQuotaError("Invalid JSON payload received")).toBe(false)
    expect(isQuotaError("model not found")).toBe(false)
  })
})
