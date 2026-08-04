/**
 * Cliente Microsoft Graph (Outlook) — OAuth delegated (token do usuário).
 * Usa /me/... (não client-credentials /users/{email}).
 */
import { config } from "../config.js"
import type { AnthropicTool } from "../systems/tool-types.js"

const GRAPH = "https://graph.microsoft.com/v1.0"

async function graphFetch(
  accessToken: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const token = accessToken.trim()
  if (!token) throw new Error("Token Microsoft ausente")

  const timeoutMs = init.timeoutMs ?? config.MCP_TOOL_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${GRAPH}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep */
    }
    if (!res.ok) {
      const msg =
        typeof body === "object" &&
        body &&
        "error" in body &&
        typeof (body as { error?: { message?: string } }).error?.message ===
          "string"
          ? (body as { error: { message: string } }).error.message
          : text.slice(0, 500)
      throw new Error(`Graph ${res.status}: ${msg}`)
    }
    return body === "" ? { ok: true } : body
  } finally {
    clearTimeout(timer)
  }
}

export const OUTLOOK_REST_TOOLS: AnthropicTool[] = [
  {
    name: "outlook__list_messages",
    description:
      "[Outlook] Lista e-mails da caixa do usuário autenticado (OAuth). Preferir $search entre aspas ou $filter; use select enxuto.",
    input_schema: {
      type: "object",
      properties: {
        top: {
          type: "number",
          description: "Quantidade (1–25, default 10).",
        },
        search: {
          type: "string",
          description:
            'KQL Graph $search (ex.: "from:alguem@gowork.com.br"). Sem $filter junto.',
        },
        filter: {
          type: "string",
          description: "OData $filter (não combinar com search).",
        },
        folder: {
          type: "string",
          description: "Pasta opcional (inbox, sentitems, drafts) ou id.",
        },
      },
    },
  },
  {
    name: "outlook__get_message",
    description: "[Outlook] Lê um e-mail completo pelo id.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Id da mensagem Graph." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "outlook__send_mail",
    description:
      "[Outlook] Envia e-mail em nome do usuário autenticado. Confirme destinatários com o usuário antes.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Destinatários separados por vírgula.",
        },
        subject: { type: "string", description: "Assunto." },
        body_html: {
          type: "string",
          description: "Corpo HTML (preferir HTML simples).",
        },
        cc: {
          type: "string",
          description: "Cópia (opcional, CSV de e-mails).",
        },
      },
      required: ["to", "subject", "body_html"],
    },
  },
  {
    name: "outlook__list_calendar_events",
    description:
      "[Outlook] Lista eventos do calendário padrão no intervalo start/end (ISO 8601).",
    input_schema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Início ISO 8601 (inclusive).",
        },
        end: { type: "string", description: "Fim ISO 8601 (exclusive)." },
        top: {
          type: "number",
          description: "Máximo de eventos (1–50, default 20).",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "outlook__create_calendar_event",
    description: "[Outlook] Cria evento no calendário padrão do usuário.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Título do evento." },
        start: { type: "string", description: "Início ISO 8601." },
        end: { type: "string", description: "Fim ISO 8601." },
        body_html: { type: "string", description: "Descrição HTML opcional." },
        location: { type: "string", description: "Local opcional." },
        attendees: {
          type: "string",
          description: "E-mails dos participantes (CSV).",
        },
      },
      required: ["subject", "start", "end"],
    },
  },
  {
    name: "outlook__list_mail_folders",
    description: "[Outlook] Lista pastas de e-mail da caixa do usuário.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
]

function asTop(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}

function splitEmails(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"))
}

export async function executeOutlookRest(
  fn: string,
  input: Record<string, unknown>,
  accessToken: string,
): Promise<unknown> {
  const base = "/me"
  switch (fn) {
    case "list_messages": {
      const top = asTop(input.top, 10, 25)
      const select =
        "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments"
      const folder =
        typeof input.folder === "string" && input.folder.trim()
          ? input.folder.trim()
          : ""
      const root = folder
        ? `${base}/mailFolders/${encodeURIComponent(folder)}/messages`
        : `${base}/messages`
      const params = new URLSearchParams()
      params.set("$top", String(top))
      params.set("$select", select)
      params.set("$orderby", "receivedDateTime desc")
      if (typeof input.search === "string" && input.search.trim()) {
        let s = input.search.trim()
        if (!s.startsWith('"')) s = `"${s}"`
        params.set("$search", s)
        params.delete("$orderby")
      } else if (typeof input.filter === "string" && input.filter.trim()) {
        params.set("$filter", input.filter.trim())
      }
      return graphFetch(accessToken, `${root}?${params.toString()}`)
    }
    case "get_message": {
      const id = String(input.message_id ?? "").trim()
      if (!id) throw new Error("message_id é obrigatório")
      return graphFetch(
        accessToken,
        `${base}/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments`,
      )
    }
    case "send_mail": {
      const to = splitEmails(String(input.to ?? ""))
      if (to.length === 0) throw new Error("to precisa de ao menos um e-mail")
      const subject = String(input.subject ?? "").trim()
      const body_html = String(input.body_html ?? "")
      if (!subject) throw new Error("subject é obrigatório")
      const cc = splitEmails(String(input.cc ?? ""))
      return graphFetch(accessToken, `${base}/sendMail`, {
        method: "POST",
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: body_html },
            toRecipients: to.map((address) => ({
              emailAddress: { address },
            })),
            ...(cc.length
              ? {
                  ccRecipients: cc.map((address) => ({
                    emailAddress: { address },
                  })),
                }
              : {}),
          },
          saveToSentItems: true,
        }),
      })
    }
    case "list_calendar_events": {
      const start = String(input.start ?? "").trim()
      const end = String(input.end ?? "").trim()
      if (!start || !end) throw new Error("start e end são obrigatórios")
      const top = asTop(input.top, 20, 50)
      const params = new URLSearchParams({
        startDateTime: start,
        endDateTime: end,
        $top: String(top),
        $select:
          "id,subject,start,end,location,organizer,isAllDay,bodyPreview",
        $orderby: "start/dateTime",
      })
      return graphFetch(accessToken, `${base}/calendarView?${params.toString()}`)
    }
    case "create_calendar_event": {
      const subject = String(input.subject ?? "").trim()
      const start = String(input.start ?? "").trim()
      const end = String(input.end ?? "").trim()
      if (!subject || !start || !end) {
        throw new Error("subject, start e end são obrigatórios")
      }
      const attendees = splitEmails(String(input.attendees ?? ""))
      const body_html =
        typeof input.body_html === "string" ? input.body_html : ""
      const location =
        typeof input.location === "string" ? input.location.trim() : ""
      return graphFetch(accessToken, `${base}/events`, {
        method: "POST",
        body: JSON.stringify({
          subject,
          start: { dateTime: start, timeZone: "America/Sao_Paulo" },
          end: { dateTime: end, timeZone: "America/Sao_Paulo" },
          ...(body_html
            ? { body: { contentType: "HTML", content: body_html } }
            : {}),
          ...(location ? { location: { displayName: location } } : {}),
          ...(attendees.length
            ? {
                attendees: attendees.map((address) => ({
                  emailAddress: { address },
                  type: "required",
                })),
              }
            : {}),
        }),
      })
    }
    case "list_mail_folders": {
      return graphFetch(
        accessToken,
        `${base}/mailFolders?$top=50&$select=id,displayName,totalItemCount,unreadItemCount`,
      )
    }
    default:
      throw new Error(`função Outlook desconhecida: ${fn}`)
  }
}
