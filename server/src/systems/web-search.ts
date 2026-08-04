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
/** Teto absoluto do corpo baixado (bytes) — nunca bufferiza um arquivo enorme. */
const FETCH_MAX_BYTES = 5_000_000
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

/** Deadline da tool + cancelamento do run (o que vier primeiro). */
function comDeadline(timeoutMs: number, externo?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return externo ? AbortSignal.any([deadline, externo]) : deadline
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

function charsetDoContentType(contentType: string): string {
  const raw = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim() ?? ""
  return raw.replace(/^["']|["']$/g, "").toLowerCase() || "utf-8"
}

/** Lê o corpo em STREAMING com corte rígido: a URL vem do modelo, então um
 * link para um arquivo gigante (ou resposta chunked infinita) não pode ir
 * inteiro para o heap — nem passar pelas regex de htmlParaTexto. */
async function lerCorpoLimitado(
  res: Response,
  maxBytes: number,
  contentType: string,
): Promise<{ bruto: string; cortadoNoDownload: boolean }> {
  if (!res.body) return { bruto: "", cortadoNoDownload: false }
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charsetDoContentType(contentType))
  } catch {
    decoder = new TextDecoder("utf-8")
  }
  const reader = res.body.getReader()
  let bruto = ""
  let bytes = 0
  let cortadoNoDownload = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      bruto += decoder.decode(value, { stream: true })
      if (bytes >= maxBytes) {
        cortadoNoDownload = true
        break
      }
    }
    if (!cortadoNoDownload) bruto += decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return { bruto, cortadoNoDownload }
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
  signal?: AbortSignal,
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
    signal: comDeadline(SEARCH_TIMEOUT_MS, signal),
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

async function executarFetch(
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
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
    signal: comDeadline(FETCH_TIMEOUT_MS, signal),
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; DexterBot/1.0; +https://dexter.gowork.com.br)",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
    },
  })
  // Todo caminho que desiste da resposta cancela o corpo: sem isso o body fica
  // pendente (socket preso até o GC) — e aqui o corpo descartado pode ser um
  // binário de vários GB.
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`Página respondeu ${res.status} ${res.statusText}`)
  }

  const contentType = res.headers.get("content-type") ?? ""
  if (!/text\/|json|xml/i.test(contentType)) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`Conteúdo não textual (${contentType}) — não dá para ler como página.`)
  }

  const declarado = Number(res.headers.get("content-length"))
  if (Number.isFinite(declarado) && declarado > FETCH_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(
      `Página muito grande para ler (${Math.round(declarado / 1_000_000)} MB).`,
    )
  }

  // Em HTML a proporção markup:texto útil é imprevisível (head, scripts e
  // style inline sozinhos passam de 100 KB), então o teto é só o absoluto —
  // o corte por chars acontece depois, no texto extraído. Em texto puro/JSON
  // um teto proporcional já basta.
  const { bruto, cortadoNoDownload } = await lerCorpoLimitado(
    res,
    /html|xml/i.test(contentType)
      ? FETCH_MAX_BYTES
      : Math.min(maxChars * 4, FETCH_MAX_BYTES),
    contentType,
  )
  const { title, text } = /html/i.test(contentType)
    ? htmlParaTexto(bruto)
    : { title: null, text: bruto }
  const cortado = text.length > maxChars
  const aviso = cortado
    ? `texto cortado em ${maxChars} chars (lido ${text.length})`
    : cortadoNoDownload
      ? "download interrompido no limite de tamanho — conteúdo parcial"
      : null
  return {
    url: res.url,
    ...(title ? { titulo: title } : {}),
    conteudo: cortado ? text.slice(0, maxChars) : text,
    ...(aviso ? { aviso } : {}),
  }
}

export async function executeWebTool(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; slug: string; fn: string; result?: unknown; error?: string }> {
  const fn = name.slice(WEB_TOOL_PREFIX.length)
  const base = await resolveSearxBase()
  if (!base) {
    return { ok: false, slug: "web", fn, error: "busca web indisponível (SearXNG fora do ar)" }
  }
  try {
    if (fn === "search") {
      return { ok: true, slug: "web", fn, result: await executarBusca(base, input, signal) }
    }
    if (fn === "fetch") {
      return { ok: true, slug: "web", fn, result: await executarFetch(input, signal) }
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
