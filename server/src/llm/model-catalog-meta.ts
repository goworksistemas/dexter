/**
 * Origem da chave de API efetiva por provider (BYOK vs corporativa).
 */
import { KEY_PROVIDERS, type KeyProvider } from "../services/llm-keys.js"
import type { ModelProvider } from "../services/model-store.js"

export type ModelKeySource = "free" | "personal" | "company"

const BILLED_PROVIDERS = new Set<string>(KEY_PROVIDERS)

export function keySourceForProvider(
  provider: ModelProvider,
  personalProviders: ReadonlySet<string>,
): ModelKeySource {
  if (!BILLED_PROVIDERS.has(provider)) return "free"
  return personalProviders.has(provider as KeyProvider)
    ? "personal"
    : "company"
}
