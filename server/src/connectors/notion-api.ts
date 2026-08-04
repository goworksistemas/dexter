/**
 * Cliente REST Notion — access_token OAuth do usuário (ou fallback admin).
 */
import { config } from "../config.js"
import type { AnthropicTool } from "../systems/tool-types.js"

const NOTION_VERSION = "2022-06-28"
const BASE = "https://api.notion.com/v1"

async function notionFetch(
  accessToken: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const token = accessToken.trim()
  if (!token) throw new Error("Token Notion ausente")

  const timeoutMs = init.timeoutMs ?? config.MCP_TOOL_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      const msg =
        typeof body === "object" &&
        body &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : text.slice(0, 500)
      throw new Error(`Notion API ${res.status}: ${msg}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

export const NOTION_REST_TOOLS: AnthropicTool[] = [
  {
    name: "notion__search",
    description:
      "[Notion] Busca páginas e databases no workspace autorizado pelo usuário. Use query em português ou inglês. Para contar cards/itens de um database específico, ache o database aqui e depois use notion__query_database (paginando) — não invente totais.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Texto de busca (título/conteúdo).",
        },
        page_size: {
          type: "number",
          description: "Máximo de resultados (1–20, default 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "notion__fetch_page",
    description:
      "[Notion] Lê propriedades e blocos de uma página (page_id UUID).",
    input_schema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "ID da página Notion (com ou sem hífens).",
        },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion__query_database",
    description:
      "[Notion] Consulta um database (database_id). Opcional: filter/sorts JSON da API Notion. Para 'quantos cards/itens', pagine (has_more/next_cursor) até fechar a contagem e declare o escopo (qual database).",
    input_schema: {
      type: "object",
      properties: {
        database_id: {
          type: "string",
          description: "ID do database Notion.",
        },
        page_size: {
          type: "number",
          description: "Máximo de linhas (1–50, default 20).",
        },
        filter_json: {
          type: "string",
          description: "JSON do filter Notion (opcional).",
        },
        sorts_json: {
          type: "string",
          description: "JSON do array sorts Notion (opcional).",
        },
      },
      required: ["database_id"],
    },
  },
  {
    name: "notion__create_page",
    description:
      "[Notion] Cria uma página filha. parent_page_id OU parent_database_id; title obrigatório.",
    input_schema: {
      type: "object",
      properties: {
        parent_page_id: {
          type: "string",
          description: "Página pai (se não for database).",
        },
        parent_database_id: {
          type: "string",
          description: "Database pai (se não for página).",
        },
        title: {
          type: "string",
          description: "Título da nova página.",
        },
        content_markdown: {
          type: "string",
          description: "Texto inicial (vira blocos paragraph).",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "notion__update_page_title",
    description: "[Notion] Atualiza o título de uma página existente.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "ID da página." },
        title: { type: "string", description: "Novo título." },
      },
      required: ["page_id", "title"],
    },
  },
]

function asNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

async function fetchPageBlocks(
  accessToken: string,
  pageId: string,
): Promise<unknown[]> {
  const blocks: unknown[] = []
  let cursor: string | undefined
  for (let i = 0; i < 5; i++) {
    const q = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""
    const page = (await notionFetch(
      accessToken,
      `/blocks/${pageId}/children${q}`,
    )) as {
      results?: unknown[]
      has_more?: boolean
      next_cursor?: string | null
    }
    blocks.push(...(page.results ?? []))
    if (!page.has_more || !page.next_cursor) break
    cursor = page.next_cursor
  }
  return blocks
}

export async function executeNotionRest(
  fn: string,
  input: Record<string, unknown>,
  accessToken: string,
): Promise<unknown> {
  switch (fn) {
    case "search": {
      const query = String(input.query ?? "").trim()
      if (!query) throw new Error("query é obrigatório")
      const page_size = asNumber(input.page_size, 10, 1, 20)
      return notionFetch(accessToken, "/search", {
        method: "POST",
        body: JSON.stringify({ query, page_size }),
      })
    }
    case "fetch_page": {
      const page_id = String(input.page_id ?? "").trim()
      if (!page_id) throw new Error("page_id é obrigatório")
      const [page, blocks] = await Promise.all([
        notionFetch(accessToken, `/pages/${page_id}`),
        fetchPageBlocks(accessToken, page_id),
      ])
      return { page, blocks }
    }
    case "query_database": {
      const database_id = String(input.database_id ?? "").trim()
      if (!database_id) throw new Error("database_id é obrigatório")
      const body: Record<string, unknown> = {
        page_size: asNumber(input.page_size, 20, 1, 50),
      }
      if (typeof input.filter_json === "string" && input.filter_json.trim()) {
        body.filter = JSON.parse(input.filter_json) as unknown
      }
      if (typeof input.sorts_json === "string" && input.sorts_json.trim()) {
        body.sorts = JSON.parse(input.sorts_json) as unknown
      }
      return notionFetch(accessToken, `/databases/${database_id}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    }
    case "create_page": {
      const title = String(input.title ?? "").trim()
      if (!title) throw new Error("title é obrigatório")
      const parent_page_id =
        typeof input.parent_page_id === "string"
          ? input.parent_page_id.trim()
          : ""
      const parent_database_id =
        typeof input.parent_database_id === "string"
          ? input.parent_database_id.trim()
          : ""
      if (!parent_page_id && !parent_database_id) {
        throw new Error("Informe parent_page_id ou parent_database_id")
      }
      const parent = parent_database_id
        ? { database_id: parent_database_id }
        : { page_id: parent_page_id }
      const children: unknown[] = []
      const md =
        typeof input.content_markdown === "string"
          ? input.content_markdown.trim()
          : ""
      if (md) {
        for (const para of md.split(/\n{2,}/).slice(0, 20)) {
          children.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: para.slice(0, 2000) } }],
            },
          })
        }
      }
      return notionFetch(accessToken, "/pages", {
        method: "POST",
        body: JSON.stringify({
          parent,
          properties: {
            title: {
              title: [{ type: "text", text: { content: title.slice(0, 2000) } }],
            },
          },
          ...(children.length ? { children } : {}),
        }),
      })
    }
    case "update_page_title": {
      const page_id = String(input.page_id ?? "").trim()
      const title = String(input.title ?? "").trim()
      if (!page_id || !title) throw new Error("page_id e title são obrigatórios")
      return notionFetch(accessToken, `/pages/${page_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            title: {
              title: [{ type: "text", text: { content: title.slice(0, 2000) } }],
            },
          },
        }),
      })
    }
    default:
      throw new Error(`função Notion desconhecida: ${fn}`)
  }
}
