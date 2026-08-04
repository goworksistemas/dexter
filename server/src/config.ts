/**
 * Configuração validada do AgentCore.
 *
 * NÃO usa arquivo `.env` — todas as variáveis vêm do ambiente, injetadas pelo
 * Infisical (projeto "agentcore"). Em dev: `infisical run -- pnpm dev`.
 * Em prod (Portainer): variáveis vêm do Infisical/stack. Valida com zod e
 * falha rápido/claro se faltar algo.
 *
 * Catálogo de modelos é dinâmico (APIs dos providers). Aqui só secrets/infra.
 * Admin só guarda overrides (ocultar/default) em `dexter_model_overrides`.
 */
import { z } from "zod"

const schema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5273,http://localhost:5274"),

  /** @deprecated Não controla mais o catálogo; mantido por compat. */
  LLM_PROVIDER: z
    .enum(["anthropic", "ollama", "openai", "gemini"])
    .default("anthropic"),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** @deprecated Default vem do discovery + override admin. */
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),

  /**
   * Segredo (>=16 chars) do AES-256-GCM das chaves de API guardadas no banco
   * (globais do admin + BYOK por usuário). ÚNICO segredo de LLM que precisa
   * ficar no ambiente — as chaves dos provedores agora vivem no banco e as
   * variáveis *_API_KEY acima são só fallback legado. Sem ele, a gestão de
   * chaves pela UI fica desabilitada.
   */
  USER_API_KEYS_SECRET: z.string().min(16).optional(),

  OLLAMA_BASE_URL: z.string().url().default("https://ollama.gowork.com.br"),
  /** Usado só para o seed ollama-default / api_model efetivo. */
  OLLAMA_MODEL: z.string().default("qwen2.5:7b"),
  OLLAMA_NUM_CTX: z.coerce.number().default(4096),

  /**
   * Speech-to-text (OpenAI-compatible `/v1/audio/transcriptions`).
   * Vazio → api.openai.com. Pode apontar pro server dedicado (ex. Ollama/Whisper).
   */
  STT_BASE_URL: z.string().url().optional(),
  STT_MODEL: z.string().default("gpt-4o-transcribe"),
  /** Se vazio, usa OPENAI_API_KEY (ou OLLAMA_API_KEY se a base for Ollama). */
  STT_API_KEY: z.string().optional(),

  SUPABASE_URL: z
    .string()
    .url()
    .default("https://jtvscxbwralvzpfhtqcs.supabase.co"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY é obrigatório"),

  DEV_USER_ID: z
    .string()
    .min(1)
    .default("00000000-0000-4000-8000-000000000001"),

  ALLOW_DEV_USER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Fallback de domínios permitidos (CSV) se a tabela
   * dexter_allowed_email_domains estiver vazia/indisponível.
   */
  ALLOWED_EMAIL_DOMAINS: z.string().default("gowork.com.br"),

  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  /** Room for dossiê (schema + SQLs densos) without cutting mid-investigation. */
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(28),
  AGENT_MAX_ROUNDS: z.coerce.number().int().positive().default(14),

  /**
   * Busca na internet GRATUITA via SearXNG self-hosted (todos os modelos).
   * Ex.: https://searx.gowork.com.br — habilita as tools web__search/web__fetch.
   * settings.yml do SearXNG precisa de `search.formats: [html, json]`.
   */
  SEARXNG_BASE_URL: z.string().url().optional(),

  /**
   * Busca nativa da Anthropic (server-side, PAGA: ~US$10/1k buscas na
   * ANTHROPIC_API_KEY; só modelos Claude). Desligada por default — o caminho
   * padrão é o SearXNG acima. Ligue só se quiser as citações nativas.
   */
  WEB_SEARCH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Máximo de buscas nativas por resposta (contém custo/latência). */
  WEB_SEARCH_MAX_USES: z.coerce.number().int().positive().default(5),
  AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(480_000),
  AGENT_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Teto do tool_result no contexto. Notion MCP (schema/markdown) precisa de folga. */
  AGENT_TOOL_RESULT_MAX_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(24_000),

  /**
   * URL pública do AgentCore (callbacks OAuth).
   * Ex.: https://agentcore.gowork.com.br ou http://localhost:8787
   */
  AGENTCORE_PUBLIC_URL: z.string().url().optional(),
  /** URL do app Dexter após OAuth (default: primeiro CORS_ORIGINS). */
  DEXTER_APP_URL: z.string().url().optional(),

  /**
   * Notion (legado REST) — NÃO necessário no caminho produto.
   * Produto: MCP OAuth em mcp.notion.com (DCR+PKCE), sem Client ID.
   */
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  NOTION_REDIRECT_URI: z.string().url().optional(),

  /**
   * Fallback admin-only: token de integração workspace.
   * NÃO usar em produção multi-user. Só se NOTION_ALLOW_WORKSPACE_TOKEN=true.
   */
  NOTION_TOKEN: z.string().optional(),
  NOTION_ALLOW_WORKSPACE_TOKEN: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Debug: stdio MCP Notion (opcional). Produto usa MCP HTTP remoto. */
  MCP_NOTION_COMMAND: z.string().optional(),
  MCP_NOTION_ARGS: z.string().optional(),

  /**
   * Outlook / Microsoft Graph — OAuth delegated (authorization code + refresh).
   * Infisical (1×): CLIENT_ID/SECRET/TENANT — tokens por user_id no DB.
   * Redirect: {AGENTCORE_PUBLIC_URL}/api/connectors/outlook/callback
   * TENANT: guid do tenant ou "organizations".
   */
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  MICROSOFT_REDIRECT_URI: z.string().url().optional(),
  /** Debug: stdio MCP Outlook (opcional). Produto usa Graph REST. */
  MCP_OUTLOOK_COMMAND: z.string().optional(),
  MCP_OUTLOOK_ARGS: z.string().optional(),

  /** Timeout de tools MCP / Graph / Notion (ms). */
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n")
  // eslint-disable-next-line no-console
  console.error(
    `\n[AgentCore] Configuração inválida — variáveis de ambiente faltando ou erradas:\n${issues}\n` +
      `As variáveis vêm do Infisical (projeto agentcore). Rode via \`infisical run -- pnpm dev\`.\n`,
  )
  process.exit(1)
}

export const config = parsed.data

/** Lista de origens permitidas no CORS, já normalizada. */
export const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
