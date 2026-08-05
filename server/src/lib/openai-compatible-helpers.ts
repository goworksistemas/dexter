/**
 * Helpers PUROS do client OpenAI-compatible (sem config/banco/log) — é o que
 * os testes cobrem sem subir nada. O client (openai-compatible.ts) importa
 * daqui e re-exporta o que faz parte da API pública dele.
 */

/** Provedores servidos pelo protocolo Chat Completions da OpenAI. */
export type OcProvider = "openai" | "gemini" | "deepseek" | "xai"

/**
 * Sanitiza um JSON Schema de tool para o provider.
 *
 * O validador do endpoint OpenAI-compat do Gemini é mais estrito que o da
 * OpenAI e devolve 400 INVALID_ARGUMENT para o request INTEIRO quando
 * qualquer tool traz:
 *  - `required: []` (array vazio — precisa ser omitido);
 *  - campos que ele não conhece (`$schema`, `additionalProperties`).
 * Como as tools vêm de várias origens (manifest, KB, conectores MCP), a
 * limpeza acontece aqui, na borda do payload — recursiva porque schemas MCP
 * têm objetos aninhados.
 */
export function sanitizeSchemaForProvider(
  node: unknown,
  provider: OcProvider,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeSchemaForProvider(item, provider))
  }
  if (node === null || typeof node !== "object") return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === "required" && Array.isArray(value) && value.length === 0) {
      continue
    }
    if (provider === "gemini" && (key === "$schema" || key === "additionalProperties")) {
      continue
    }
    out[key] = sanitizeSchemaForProvider(value, provider)
  }
  return out
}

/**
 * Extrai a mensagem humana do corpo de erro do provider. OpenAI, Gemini
 * (compat), DeepSeek e xAI usam o envelope `{"error":{"message":"..."}}`;
 * o Google às vezes devolve um ARRAY de envelopes.
 */
function extractProviderErrorMessage(errText: string): string {
  try {
    const parsed = JSON.parse(errText) as unknown
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (first && typeof first === "object") {
      const errField = (first as { error?: unknown }).error
      if (errField && typeof errField === "object") {
        const msg = (errField as { message?: unknown }).message
        if (typeof msg === "string" && msg.trim()) return msg.trim()
      }
      const msg = (first as { message?: unknown }).message
      if (typeof msg === "string" && msg.trim()) return msg.trim()
    }
  } catch {
    /* corpo não-JSON — usa o texto cru */
  }
  return errText.trim()
}

export function formatProviderHttpError(
  provider: string,
  model: string,
  status: number,
  errText: string,
): string {
  const detalhe = extractProviderErrorMessage(errText).slice(0, 240)
  const lower = detalhe.toLowerCase()
  if (
    status === 404 &&
    (lower.includes("no longer available") ||
      lower.includes("not found") ||
      lower.includes("is not found"))
  ) {
    return (
      `Modelo "${model}" não está mais disponível na ${provider}. ` +
      `Escolha outro modelo no seletor (ex.: Gemini 2.5/3.x Flash).`
    )
  }
  if (status === 401 || status === 403) {
    return (
      `A ${provider} recusou a chave de API (HTTP ${status}). ` +
      "Confira a chave no painel admin ou nas suas Configurações."
    )
  }
  if (status === 429) {
    // 429 de cobrança (cota do plano esgotada) ≠ 429 de rate limit por minuto.
    if (/billing|insufficient|credit|check your plan/i.test(lower)) {
      return (
        `A cota do plano da ${provider} esgotou (HTTP 429). ` +
        "Verifique o faturamento da chave ou fale com um administrador."
      )
    }
    return (
      `Limite de requisições da ${provider} atingido (HTTP 429). ` +
      "Aguarde um momento e tente novamente."
    )
  }
  if (status === 400) {
    return (
      `A ${provider} rejeitou a requisição (HTTP 400)` +
      (detalhe ? `: ${detalhe}` : ".")
    )
  }
  if (status >= 500) {
    return (
      `A ${provider} está instável agora (HTTP ${status}). ` +
      "Tente novamente em instantes."
    )
  }
  return `${provider} HTTP ${status}${detalhe ? `: ${detalhe}` : ""}`
}
