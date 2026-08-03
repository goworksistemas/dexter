/**
 * Configuração validada do AgentCore.
 *
 * NÃO usa arquivo `.env` — todas as variáveis vêm do ambiente, injetadas pelo
 * Infisical (projeto "agentcore"). Em dev: `infisical run -- pnpm dev`.
 * Em prod (Portainer): variáveis vêm do Infisical/stack. Valida com zod e
 * falha rápido/claro se faltar algo.
 */
import { z } from "zod"

const schema = z
  .object({
    PORT: z.coerce.number().default(8787),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:5273,http://localhost:5274"),

    // --- Roteador de LLM ---
    // "anthropic" (Claude via API) ou "ollama" (modelo self-hosted GoWork).
    LLM_PROVIDER: z.enum(["anthropic", "ollama"]).default("anthropic"),

    // Anthropic — obrigatório SÓ quando LLM_PROVIDER=anthropic (ver refine).
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

    // Ollama self-hosted (GoWork). Sem chave — protegido por rede/host.
    OLLAMA_BASE_URL: z.string().url().default("https://ollama.gowork.com.br"),
    OLLAMA_MODEL: z.string().default("qwen2.5:7b"),
    OLLAMA_NUM_CTX: z.coerce.number().default(4096),

    // Supabase (projeto agentcore) — URL tem default (conhecido); só o
    // service_role precisa ser cadastrado (é secret, obrigatório).
    SUPABASE_URL: z
      .string()
      .url()
      .default("https://jtvscxbwralvzpfhtqcs.supabase.co"),
    SUPABASE_SERVICE_ROLE_KEY: z
      .string()
      .min(1, "SUPABASE_SERVICE_ROLE_KEY é obrigatório"),

    // uuid usado como user_id só quando ALLOW_DEV_USER=true e não há JWT.
    DEV_USER_ID: z
      .string()
      .min(1)
      .default("00000000-0000-4000-8000-000000000001"),

    // Em prod deve ficar false/ausente. Em dev local pode ser true para
    // testar o AgentCore sem o front autenticado.
    ALLOW_DEV_USER: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    RATE_LIMIT_MAX: z.coerce.number().default(60),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  })
  .superRefine((val, ctx) => {
    if (val.LLM_PROVIDER === "anthropic" && !val.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message:
          "ANTHROPIC_API_KEY é obrigatório quando LLM_PROVIDER=anthropic (ou troque para LLM_PROVIDER=ollama)",
      })
    }
  })

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n")
  // eslint-disable-next-line no-console
  console.error(
    `\n[AgentCore] Configuração inválida — variáveis de ambiente faltando ou erradas:\n${issues}\n` +
      `As variáveis vêm do Infisical (projeto agentcore). Rode via \`infisical run -- pnpm dev\`.\n`
  )
  process.exit(1)
}

export const config = parsed.data

/** Lista de origens permitidas no CORS, já normalizada. */
export const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
