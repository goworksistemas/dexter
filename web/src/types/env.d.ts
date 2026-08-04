// Tipagem das variáveis de ambiente Vite usadas pelo Dexter (evita `any`
// implícito ao ler `import.meta.env.*`). Ambiente global — sem imports.
interface ImportMetaEnv {
  /** URL do backend AgentCore (Fastify). Em dev o Vite faz proxy de /api. */
  readonly VITE_AGENTCORE_URL?: string;
  /** URL do projeto Supabase "agentcore" (auth). Vazio até ser provisionado. */
  readonly VITE_SUPABASE_URL?: string;
  /** Chave anônima (pública) do projeto Supabase "agentcore". */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Versão do app injetada pelo Vite a partir de `web/package.json`. */
declare const __APP_VERSION__: string;

