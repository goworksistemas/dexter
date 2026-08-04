/**
 * Base de conhecimento da empresa (contexto GoWork do Dexter).
 * Tabela (projeto "agentcore"): public.agent_kb_docs — RLS sem policies, então
 * todo acesso passa por aqui com o client service_role.
 *
 * Dois consumidores:
 *  - Painel admin (CRUD) — rotas /api/admin/kb com gate admin/master.
 *  - Runtime do chat — `getKbPromptContext()` injeta os docs `always_load` no
 *    system prompt e `searchKbDocs()` atende a tool kb__buscar (sob demanda).
 */
import { supabase } from "../lib/supabase.js"
import { NotFoundError } from "./errors.js"

/** Mesmo domínio do check `agent_kb_docs_category_chk` (migration 0020). */
export const KB_CATEGORIES = [
  "empresa",
  "sistemas",
  "projetos",
  "pessoas",
  "glossario",
  "geral",
] as const

export type KbCategory = (typeof KB_CATEGORIES)[number]

export interface KbDoc {
  id: string
  slug: string
  title: string
  category: KbCategory
  content: string
  enabled: boolean
  always_load: boolean
  sort: number
  created_at: string
  updated_at: string
}

export interface CreateKbDocParams {
  slug?: string
  title: string
  category: KbCategory
  content: string
  enabled?: boolean
  always_load?: boolean
  sort?: number
}

export interface KbDocPatch {
  slug?: string
  title?: string
  category?: KbCategory
  content?: string
  enabled?: boolean
  always_load?: boolean
  sort?: number
}

const SELECT_COLS =
  "id, slug, title, category, content, enabled, always_load, sort, created_at, updated_at"

/** Contexto injetado em toda conversa — cache curto evita 1 query por mensagem. */
const PROMPT_CACHE_TTL_MS = 60_000
/** Teto por doc devolvido na busca (o modelo não precisa de 60k chars de uma vez). */
const SEARCH_CONTENT_CAP = 8_000
/** Máx. de documentos completos por busca. */
const SEARCH_MAX_DOCS = 5

function normalize(raw: Record<string, unknown>): KbDoc {
  return {
    id: String(raw.id),
    slug: String(raw.slug),
    title: String(raw.title),
    category: String(raw.category ?? "geral") as KbCategory,
    content: String(raw.content ?? ""),
    enabled: raw.enabled !== false,
    always_load: Boolean(raw.always_load),
    sort: Number(raw.sort ?? 100),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  }
}

function badRequest(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { statusCode: number }).statusCode = 400
  return err
}

/** Viola unique (slug) ou check do banco → 400 com mensagem em português.
 * Qualquer outro erro sobe como 500 (mensagem interna fica só no log). */
function mapDbError(
  error: { code?: string; message: string },
  op: string,
): Error {
  const code = error.code ?? ""
  const msg = error.message ?? ""
  if (code === "23505" || /duplicate key|already exists/i.test(msg)) {
    return badRequest(
      "Já existe um documento com esse slug. Escolha outro identificador.",
    )
  }
  if (code === "23514" || /violates check constraint/i.test(msg)) {
    if (/slug_fmt/.test(msg)) {
      return badRequest(
        "Slug inválido: use 2 a 81 caracteres, só letras minúsculas, números e hífen, começando por letra ou número.",
      )
    }
    if (/title_len/.test(msg)) {
      return badRequest("Título inválido: informe de 1 a 160 caracteres.")
    }
    if (/category_chk/.test(msg)) {
      return badRequest(
        `Categoria inválida. Use uma destas: ${KB_CATEGORIES.join(", ")}.`,
      )
    }
    if (/content_len/.test(msg)) {
      return badRequest("Conteúdo muito grande: limite de 60.000 caracteres.")
    }
    return badRequest("Documento inválido: algum campo não passou na validação do banco.")
  }
  return new Error(`${op} falhou: ${msg}`)
}

/** Slug a partir do título: minúsculas, sem acento, hífens.
 * Casa com o check `^[a-z0-9][a-z0-9-]{1,80}$`. */
export function slugify(input: string): string {
  const base = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 81)
    .replace(/-+$/g, "")

  // Precisa começar com [a-z0-9] e ter no mínimo 2 chars.
  if (!/^[a-z0-9]/.test(base)) {
    return `doc-${Date.now().toString(36)}`
  }
  if (base.length < 2) {
    return `${base}-${Date.now().toString(36)}`.slice(0, 81)
  }
  return base
}

// ---------------------------------------------------------------------------
// Cache do contexto de prompt (invalidado em toda escrita)
// ---------------------------------------------------------------------------

export interface KbIndexEntry {
  slug: string
  title: string
  category: KbCategory
}

export interface KbPromptContext {
  /** enabled && always_load, na ordem de `sort` — vão inteiros no system prompt. */
  alwaysDocs: KbDoc[]
  /** enabled && !always_load — só o índice; o conteúdo sai via kb__buscar. */
  index: KbIndexEntry[]
}

let promptCache: { at: number; ctx: KbPromptContext } | null = null

export function invalidateKbCache(): void {
  promptCache = null
}

/** Docs sempre carregados + índice do resto. Cache em memória de 60s. */
export async function getKbPromptContext(): Promise<KbPromptContext> {
  if (promptCache && Date.now() - promptCache.at < PROMPT_CACHE_TTL_MS) {
    return promptCache.ctx
  }
  const { data, error } = await supabase
    .from("agent_kb_docs")
    .select(SELECT_COLS)
    .eq("enabled", true)
    .order("sort", { ascending: true })
    .order("title", { ascending: true })

  if (error) throw new Error(`getKbPromptContext falhou: ${error.message}`)

  const rows = (data ?? []).map((r) => normalize(r as Record<string, unknown>))
  const ctx: KbPromptContext = {
    alwaysDocs: rows.filter((d) => d.always_load),
    index: rows
      .filter((d) => !d.always_load)
      .map((d) => ({ slug: d.slug, title: d.title, category: d.category })),
  }
  promptCache = { at: Date.now(), ctx }
  return ctx
}

// ---------------------------------------------------------------------------
// CRUD (painel admin)
// ---------------------------------------------------------------------------

/** Todos os documentos (inclusive desabilitados) — só para o painel admin. */
export async function listKbDocs(): Promise<KbDoc[]> {
  const { data, error } = await supabase
    .from("agent_kb_docs")
    .select(SELECT_COLS)
    .order("category", { ascending: true })
    .order("sort", { ascending: true })
    .order("title", { ascending: true })

  if (error) throw new Error(`listKbDocs falhou: ${error.message}`)
  return (data ?? []).map((r) => normalize(r as Record<string, unknown>))
}

export async function createKbDoc(
  params: CreateKbDocParams,
  updatedBy?: string,
): Promise<KbDoc> {
  const title = params.title.trim()
  const slug = (params.slug ?? "").trim() || slugify(title)

  const row: Record<string, unknown> = {
    slug,
    title,
    category: params.category,
    content: params.content,
    enabled: params.enabled ?? true,
    always_load: params.always_load ?? false,
    sort: params.sort ?? 100,
  }
  if (updatedBy) row.updated_by = updatedBy

  const { data, error } = await supabase
    .from("agent_kb_docs")
    .insert(row)
    .select(SELECT_COLS)
    .single()

  if (error) throw mapDbError(error, "createKbDoc")
  invalidateKbCache()
  return normalize(data as Record<string, unknown>)
}

export async function updateKbDoc(
  id: string,
  patch: KbDocPatch,
  updatedBy?: string,
): Promise<KbDoc> {
  const row: Record<string, unknown> = {}
  if (patch.slug !== undefined) row.slug = patch.slug.trim()
  if (patch.title !== undefined) row.title = patch.title.trim()
  if (patch.category !== undefined) row.category = patch.category
  if (patch.content !== undefined) row.content = patch.content
  if (patch.enabled !== undefined) row.enabled = patch.enabled
  if (patch.always_load !== undefined) row.always_load = patch.always_load
  if (patch.sort !== undefined) row.sort = patch.sort

  if (Object.keys(row).length === 0) {
    throw badRequest("Informe ao menos um campo para atualizar.")
  }
  if (updatedBy) row.updated_by = updatedBy

  const { data, error } = await supabase
    .from("agent_kb_docs")
    .update(row)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle()

  if (error) throw mapDbError(error, "updateKbDoc")
  if (!data) throw new NotFoundError("Documento não encontrado.")
  invalidateKbCache()
  return normalize(data as Record<string, unknown>)
}

/** Exclui o documento. Inexistente → NotFoundError. */
export async function deleteKbDoc(id: string): Promise<void> {
  const { error, count } = await supabase
    .from("agent_kb_docs")
    .delete({ count: "exact" })
    .eq("id", id)

  if (error) throw new Error(`deleteKbDoc falhou: ${error.message}`)
  invalidateKbCache()
  if ((count ?? 0) === 0) {
    throw new NotFoundError("Documento não encontrado.")
  }
}

// ---------------------------------------------------------------------------
// Busca (tool kb__buscar)
// ---------------------------------------------------------------------------

export interface KbSearchResultDoc {
  slug: string
  title: string
  categoria: KbCategory
  conteudo: string
  atualizado_em: string
  truncado?: boolean
}

export interface KbSearchResult {
  termo: string | null
  categoria: KbCategory | null
  total_disponivel: number
  documentos: KbSearchResultDoc[]
  indice: KbIndexEntry[]
  dica: string
}

/** Neutraliza curingas do LIKE e os separadores do filtro PostgREST (`or`),
 * para o termo vindo do modelo virar busca literal e não quebrar a query. */
function escapeIlike(term: string): string {
  return term.replace(/[%_*,()"'\\]/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * Busca na KB (só documentos habilitados).
 * - Sem termo → apenas o índice (slug/título/categoria) para o modelo escolher.
 * - Com termo → ilike em título/slug/conteúdo, no máx. 5 docs, conteúdo cortado
 *   em 8k chars com aviso de truncamento.
 */
export async function searchKbDocs(
  termo?: string,
  categoria?: string,
): Promise<KbSearchResult> {
  const term = (termo ?? "").trim()
  const cat = KB_CATEGORIES.includes((categoria ?? "") as KbCategory)
    ? ((categoria ?? "") as KbCategory)
    : null

  let query = supabase
    .from("agent_kb_docs")
    .select(SELECT_COLS)
    .eq("enabled", true)
    .order("sort", { ascending: true })
    .order("title", { ascending: true })

  if (cat) query = query.eq("category", cat)

  const escaped = escapeIlike(term)
  if (escaped) {
    const pattern = `%${escaped}%`
    query = query.or(
      `title.ilike.${pattern},slug.ilike.${pattern},content.ilike.${pattern}`,
    )
  }

  const { data, error } = await query
  if (error) throw new Error(`searchKbDocs falhou: ${error.message}`)

  const rows = (data ?? []).map((r) => normalize(r as Record<string, unknown>))
  const indice: KbIndexEntry[] = rows.map((d) => ({
    slug: d.slug,
    title: d.title,
    category: d.category,
  }))

  // Sem termo a resposta é só o mapa da KB — devolver tudo estouraria o contexto.
  if (!escaped) {
    return {
      termo: null,
      categoria: cat,
      total_disponivel: rows.length,
      documentos: [],
      indice,
      dica: rows.length
        ? "Índice da base de conhecimento. Chame kb__buscar novamente com `termo` (ou o slug do documento) para ler o conteúdo."
        : "A base de conhecimento não tem documentos habilitados para este filtro.",
    }
  }

  const documentos: KbSearchResultDoc[] = rows
    .slice(0, SEARCH_MAX_DOCS)
    .map((d) => {
      const truncado = d.content.length > SEARCH_CONTENT_CAP
      return {
        slug: d.slug,
        title: d.title,
        categoria: d.category,
        conteudo: truncado
          ? `${d.content.slice(0, SEARCH_CONTENT_CAP)}\n\n(documento truncado)`
          : d.content,
        atualizado_em: d.updated_at,
        ...(truncado ? { truncado: true } : {}),
      }
    })

  return {
    termo: term,
    categoria: cat,
    total_disponivel: rows.length,
    documentos,
    indice,
    dica: documentos.length
      ? "Conteúdo curado internamente. Números e status atuais precisam vir das tools dos sistemas."
      : "Nada encontrado na base de conhecimento — tente outro termo, ou chame kb__buscar sem termo para ver o índice.",
  }
}
