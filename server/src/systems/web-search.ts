/**
 * Busca na internet via SearXNG self-hosted (gratuito, sem API key).
 *
 * - `web__search`: consulta o SearXNG (formato JSON) e devolve título/URL/resumo.
 * - `web__fetch`: baixa uma página específica e devolve o texto limpo.
 *
 * ZERO CONFIG: o backend descobre o SearXNG sozinho — tenta SEARXNG_BASE_URL
 * (se setada), depois http://searxng:8080 (container da stack) e
 * http://localhost:8888 (dev). Onde responder /healthz, as tools aparecem;
 * onde nada responder, elas somem (probe com cache de 60s). Funciona para
 * qualquer provider (Claude, OpenAI-compat, Ollama) porque roda no backend
 * como tool comum. SSRF: web__fetch recusa hosts privados/loopback.
 */
import { config } from "../config.js"
import type { AnthropicTool } from "./tool-types.js"

export const WEB_TOOL_PREFIX = "web__"

const SEARCH_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 1_500
const PROBE_CACHE_MS = 60_000
const MAX_RESULTS_CAP = 10
const DEFAULT_RESULTS = 6
const FETCH_CHARS_CAP = 40_000
const FETCH_CHARS_DEFAULT = 20_000
/** Só engines de qualidade na categoria general — sem isso, quando o Google
 * bloqueia o IP do datacenter sobram engines fracos devolvendo lixo. */
const GENERAL_ENGINES = "google,bing,duckduckgo,brave"
const DEFAULT_LANGUAGE = "pt-BR"

export function isWebToolName(name: string): boolean {
  return name.startsWith(WEB_TOOL_PREFIX)
}

let probeCache: { base: string | null; at: number } | null = null

/** Primeiro SearXNG que responder /healthz (cache 60s; null = indisponível). */
async function resolveSearxBase(): Promise<string | null> {
  if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) {
    return probeCache.base
  }
  const candidatos = [
    config.SEARXNG_BASE_URL,
    "http://searxng:8080",
    "http://localhost:8888",
  ].filter((v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i)

  for (const base of candidatos) {
    try {
      const res = await fetch(new URL("/healthz", base), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (res.ok) {
        probeCache = { base, at: Date.now() }
        return base
      }
    } catch {
      /* candidato fora do ar — tenta o próximo */
    }
  }
  probeCache = { base: null, at: Date.now() }
  return null
}

export async function buildWebTools(): Promise<AnthropicTool[]> {
  if (!(await resolveSearxBase())) return []
  return [
    {
      name: "web__search",
      description:
        "[Internet] Busca na web (SearXNG). Use para informação EXTERNA: notícias, docs públicas, " +
        "preços de mercado, legislação, empresas externas, fatos recentes. NUNCA para dados internos " +
        "GoWork (chamados, OS, clientes, vendas — use as tools dos sistemas). " +
        'Como buscar bem: use aspas para nome/frase exata ("Heritage Realty" São Paulo), ' +
        "adicione contexto que desambigue (cidade, empresa, CNPJ, site:linkedin.com/in para perfis), " +
        "e se os resultados vierem irrelevantes REFINE e tente 2-3 variações antes de desistir. " +
        "Busca em pt-BR por padrão — para conteúdo em inglês passe language. " +
        "Devolve título, URL e resumo; para ler uma página inteira use web__fetch em seguida.",
      input_schema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Termos da busca (como você digitaria no Google)." },
          max_results: {
            type: "number",
            description: `Máx. de resultados (default ${DEFAULT_RESULTS}, cap ${MAX_RESULTS_CAP}).`,
          },
          time_range: {
            type: "string",
            description: "Filtro de recência: day | week | month | year. Opcional.",
          },
          category: {
            type: "string",
            description: "general (default) | news | it | science. Opcional.",
          },
          language: {
            type: "string",
            description:
              `Idioma/região dos resultados (default ${DEFAULT_LANGUAGE}). ` +
              'Use "en-US" para conteúdo em inglês ou "all" para sem filtro.',
          },
        },
        required: ["q"],
      },
    },
    {
      name: "web__fetch",
      description:
        "[Internet] Baixa UMA página web (http/https) e devolve o texto limpo (sem HTML). " +
        "Use depois do web__search quando o resumo não basta. Recusa endereços internos/privados.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL completa http(s) da página." },
          max_chars: {
            type: "number",
            description: `Máx. de caracteres do texto (default ${FETCH_CHARS_DEFAULT}, cap ${FETCH_CHARS_CAP}).`,
          },
        },
        required: ["url"],
      },
    },
  ]
}

export function describeWebTool(name: string): {
  slug: string
  fn: string
  systemLabel: string
  toolLabel: string
  label: string
} {
  const fn = name.slice(WEB_TOOL_PREFIX.length)
  const toolLabel = fn === "fetch" ? "Ler página" : "Busca web"
  return {
    slug: "web",
    fn,
    systemLabel: "Internet",
    toolLabel,
    label: `Buscando na internet · ${toolLabel}`,
  }
}

/** Bloqueia loopback/redes privadas — a tool não é porta para a infra interna. */
function hostBloqueado(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return true
  return false
}

function htmlParaTexto(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
  return { title, text }
}

interface SearxResult {
  title?: string
  url?: string
  content?: string
  publishedDate?: string | null
  engine?: string
}

async function executarBusca(
  base: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const q = String(input.q ?? "").trim()
  if (!q) throw new Error("q é obrigatório")
  const max = Math.min(
    Math.max(1, Number(input.max_results) || DEFAULT_RESULTS),
    MAX_RESULTS_CAP,
  )

  const url = new URL("/search", base)
  url.searchParams.set("q", q)
  url.searchParams.set("format", "json")
  url.searchParams.set("safesearch", "1")

  // Idioma/região: sem isso, busca em português volta lixo genérico dos EUA.
  const language = String(input.language ?? "").trim() || DEFAULT_LANGUAGE
  if (language !== "all") url.searchParams.set("language", language)

  const timeRange = String(input.time_range ?? "").trim()
  if (["day", "week", "month", "year"].includes(timeRange)) {
    url.searchParams.set("time_range", timeRange)
  }
  const category = String(input.category ?? "").trim()
  if (category && category !== "general") {
    url.searchParams.set("categories", category)
  } else {
    url.searchParams.set("engines", GENERAL_ENGINES)
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(
      `SearXNG respondeu ${res.status} — provável formato json desabilitado no settings.yml (search.formats).`,
    )
  }
  const body = (await res.json()) as { results?: SearxResult[] }
  const resultados = (body.results ?? []).slice(0, max).map((r) => ({
    titulo: r.title ?? "",
    url: r.url ?? "",
    resumo: r.content ?? "",
    ...(r.publishedDate ? { publicado_em: r.publishedDate } : {}),
    ...(r.engine ? { fonte_engine: r.engine } : {}),
  }))
  return {
    query: q,
    total_disponivel: body.results?.length ?? 0,
    resultados,
    dica: resultados.length
      ? "Para o conteúdo completo de um resultado, chame web__fetch com a URL."
      : "Nada encontrado — refine os termos, tente variações (aspas, site:, empresa em vez de pessoa) ou language 'all'.",
  }
}

async function executarFetch(input: Record<string, unknown>): Promise<unknown> {
  const raw = String(input.url ?? "").trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`URL inválida: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Só http/https são permitidos.")
  }
  if (hostBloqueado(url.hostname)) {
    throw new Error("Endereço interno/privado bloqueado nesta tool.")
  }
  const maxChars = Math.min(
    Math.max(1_000, Number(input.max_chars) || FETCH_CHARS_DEFAULT),
    FETCH_CHARS_CAP,
  )

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; DexterBot/1.0; +https://dexter.gowork.com.br)",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
    },
  })
  if (!res.ok) throw new Error(`Página respondeu ${res.status} ${res.statusText}`)

  const contentType = res.headers.get("content-type") ?? ""
  if (!/text\/|json|xml/i.test(contentType)) {
    throw new Error(`Conteúdo não textual (${contentType}) — não dá para ler como página.`)
  }

  const bruto = await res.text()
  const { title, text } = /html/i.test(contentType)
    ? htmlParaTexto(bruto)
    : { title: null, text: bruto }
  const cortado = text.length > maxChars
  return {
    url: res.url,
    ...(title ? { titulo: title } : {}),
    conteudo: cortado ? text.slice(0, maxChars) : text,
    ...(cortado ? { aviso: `texto cortado em ${maxChars} chars (original ${text.length})` } : {}),
  }
}

export async function executeWebTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; slug: string; fn: string; result?: unknown; error?: string }> {
  const fn = name.slice(WEB_TOOL_PREFIX.length)
  const base = await resolveSearxBase()
  if (!base) {
    return { ok: false, slug: "web", fn, error: "busca web indisponível (SearXNG fora do ar)" }
  }
  try {
    if (fn === "search") {
      return { ok: true, slug: "web", fn, result: await executarBusca(base, input) }
    }
    if (fn === "fetch") {
      return { ok: true, slug: "web", fn, result: await executarFetch(input) }
    }
    return { ok: false, slug: "web", fn, error: `função web desconhecida: ${fn}` }
  } catch (err) {
    return {
      ok: false,
      slug: "web",
      fn,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
