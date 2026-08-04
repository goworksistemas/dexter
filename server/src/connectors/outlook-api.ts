/**
 * Cliente Microsoft Graph (Outlook) — OAuth delegated (token do usuário).
 * Usa /me/... (não client-credentials /users/{email}).
 */
import { config } from "../config.js"
import type { AnthropicTool } from "../systems/tool-types.js"

const GRAPH = "https://graph.microsoft.com/v1.0"

/** Pastas bem conhecidas do Graph (aceitas como id direto). */
const WELL_KNOWN_FOLDERS = new Set([
  "inbox",
  "drafts",
  "sentitems",
  "deleteditems",
  "archive",
  "junkemail",
  "outbox",
  "conversationhistory",
  "msgfolderroot",
])

/** Inclui "Mail.ReadWrite" cedo — o resumo da UI trunca em ~300 chars. */
const RECONNECT_MAIL_WRITE =
  "[Mail.ReadWrite] Reconecte o Outlook em Conexões uma vez."

function isInsufficientMailScope(status: number, code: string, msg: string): boolean {
  if (status === 401 || status === 403) return true
  const blob = `${code} ${msg}`.toLowerCase()
  return (
    blob.includes("accessdenied") ||
    blob.includes("authorization_requestdenied") ||
    blob.includes("insufficient") ||
    blob.includes("mail.readwrite") ||
    blob.includes("forbidden")
  )
}

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
      const errObj =
        typeof body === "object" && body && "error" in body
          ? (body as { error?: { message?: string; code?: string } }).error
          : undefined
      const msg =
        typeof errObj?.message === "string" ? errObj.message : text.slice(0, 500)
      const code = typeof errObj?.code === "string" ? errObj.code : ""
      const writeOpsHint =
        isInsufficientMailScope(res.status, code, msg) &&
        (path.includes("/move") ||
          init.method === "PATCH" ||
          path.includes("/$batch"))
          ? ` ${RECONNECT_MAIL_WRITE}`
          : ""
      throw new Error(`Graph ${res.status}: ${msg}${writeOpsHint}`)
    }
    return body === "" || body === null ? { ok: true } : body
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
    description:
      "[Outlook] Lista pastas de e-mail (inclui filhos de 1º nível). Use os ids/nomes em move_messages.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "outlook__move_messages",
    description:
      "[Outlook] Move uma ou mais mensagens para outra pasta (Graph move). " +
      "destination_folder: id Graph, nome bem conhecido (inbox, archive…) ou displayName " +
      '(ex.: "Lido"). Preferir esta tool em lote em vez de pedir ao usuário mover manualmente.',
    input_schema: {
      type: "object",
      properties: {
        message_ids: {
          type: "string",
          description:
            "Ids Graph das mensagens — CSV ou JSON array em string. Máx. 50 por chamada.",
        },
        destination_folder: {
          type: "string",
          description:
            "Pasta destino: id, well-known (archive, inbox…) ou nome (displayName).",
        },
        destination_folder_id: {
          type: "string",
          description: "Alias de destination_folder (id ou nome).",
        },
      },
      required: ["message_ids"],
    },
  },
  {
    name: "outlook__mark_messages_read",
    description:
      "[Outlook] Marca mensagens como lidas (isRead=true) ou não lidas (isRead=false). " +
      "Use quando o usuário pedir marcar como lido / não lido.",
    input_schema: {
      type: "object",
      properties: {
        message_ids: {
          type: "string",
          description:
            "Ids Graph das mensagens — CSV ou JSON array em string. Máx. 50 por chamada.",
        },
        is_read: {
          type: "boolean",
          description: "true = lido (default), false = não lido.",
        },
      },
      required: ["message_ids"],
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

/** Aceita array, CSV, ou JSON array em string. */
function parseIdList(raw: unknown, max = 50): string[] {
  let items: string[] = []
  if (Array.isArray(raw)) {
    items = raw.map((x) => String(x).trim()).filter(Boolean)
  } else if (typeof raw === "string") {
    const t = raw.trim()
    if (!t) return []
    if (t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t) as unknown
        if (Array.isArray(parsed)) {
          items = parsed.map((x) => String(x).trim()).filter(Boolean)
        }
      } catch {
        /* CSV */
      }
    }
    if (items.length === 0) {
      items = t
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  if (items.length === 0) throw new Error("message_ids é obrigatório")
  if (items.length > max) {
    throw new Error(`no máximo ${max} message_ids por chamada (recebido ${items.length})`)
  }
  return items
}

type FolderRow = { id: string; displayName: string }

async function listFoldersFlat(accessToken: string): Promise<FolderRow[]> {
  const top = (await graphFetch(
    accessToken,
    "/me/mailFolders?$top=50&$select=id,displayName&$expand=childFolders($select=id,displayName;$top=50)",
  )) as { value?: Array<{ id?: string; displayName?: string; childFolders?: FolderRow[] }> }

  const out: FolderRow[] = []
  for (const f of top.value ?? []) {
    if (f.id && f.displayName) out.push({ id: f.id, displayName: f.displayName })
    for (const c of f.childFolders ?? []) {
      if (c.id && c.displayName) out.push({ id: c.id, displayName: c.displayName })
    }
  }
  return out
}

async function resolveFolderId(
  accessToken: string,
  raw: string,
): Promise<{ id: string; matchedBy: string }> {
  const name = raw.trim()
  if (!name) throw new Error("destination_folder é obrigatório")

  const lower = name.toLowerCase()
  if (WELL_KNOWN_FOLDERS.has(lower)) {
    return { id: lower, matchedBy: "well-known" }
  }

  // Id Graph típico (longo) — usar direto
  if (name.length >= 20 && !/\s/.test(name)) {
    return { id: name, matchedBy: "id" }
  }

  const folders = await listFoldersFlat(accessToken)
  const exact = folders.find((f) => f.displayName.toLowerCase() === lower)
  if (exact) return { id: exact.id, matchedBy: `displayName:${exact.displayName}` }

  const partial = folders.filter((f) => f.displayName.toLowerCase().includes(lower))
  if (partial.length === 1) {
    return {
      id: partial[0]!.id,
      matchedBy: `displayName:~${partial[0]!.displayName}`,
    }
  }
  if (partial.length > 1) {
    throw new Error(
      `várias pastas batem com "${name}": ${partial
        .map((f) => f.displayName)
        .join(", ")}. Passe o id ou o nome exato.`,
    )
  }
  throw new Error(
    `pasta "${name}" não encontrada. Liste com outlook__list_mail_folders (disponíveis: ${folders
      .slice(0, 20)
      .map((f) => f.displayName)
      .join(", ")}${folders.length > 20 ? "…" : ""}).`,
  )
}

type BatchRequest = {
  id: string
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}

type BatchResponseItem = {
  id: string
  status: number
  body?: unknown
}

async function graphBatch(
  accessToken: string,
  requests: BatchRequest[],
): Promise<BatchResponseItem[]> {
  const results: BatchResponseItem[] = []
  const chunkSize = 20
  for (let i = 0; i < requests.length; i += chunkSize) {
    const chunk = requests.slice(i, i + chunkSize)
    const body = (await graphFetch(accessToken, "/$batch", {
      method: "POST",
      body: JSON.stringify({ requests: chunk }),
    })) as { responses?: BatchResponseItem[] }
    results.push(...(body.responses ?? []))
  }
  return results
}

function summarizeBatch(
  ids: string[],
  responses: BatchResponseItem[],
  okStatus: number | number[],
): {
  moved_or_updated: number
  failed: Array<{ message_id: string; status: number; error: string }>
} {
  const okSet = new Set(Array.isArray(okStatus) ? okStatus : [okStatus])
  const byId = new Map(responses.map((r) => [r.id, r]))
  const failed: Array<{ message_id: string; status: number; error: string }> = []
  let ok = 0
  for (let i = 0; i < ids.length; i++) {
    const messageId = ids[i]!
    const r = byId.get(String(i + 1))
    if (!r) {
      failed.push({ message_id: messageId, status: 0, error: "sem resposta no batch" })
      continue
    }
    if (okSet.has(r.status)) {
      ok++
      continue
    }
    const errBody = r.body as { error?: { message?: string; code?: string } } | undefined
    const msg = errBody?.error?.message ?? `HTTP ${r.status}`
    const code = errBody?.error?.code ?? ""
    const hint =
      isInsufficientMailScope(r.status, code, msg) ? ` ${RECONNECT_MAIL_WRITE}` : ""
    failed.push({ message_id: messageId, status: r.status, error: `${msg}${hint}` })
  }
  return { moved_or_updated: ok, failed }
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
        `${base}/mailFolders?$top=50&$select=id,displayName,totalItemCount,unreadItemCount&$expand=childFolders($select=id,displayName,totalItemCount,unreadItemCount;$top=50)`,
      )
    }
    case "move_messages": {
      const ids = parseIdList(input.message_ids)
      const destRaw = String(
        input.destination_folder ?? input.destination_folder_id ?? "",
      ).trim()
      if (!destRaw) {
        throw new Error("destination_folder (ou destination_folder_id) é obrigatório")
      }
      const dest = await resolveFolderId(accessToken, destRaw)
      const requests: BatchRequest[] = ids.map((id, i) => ({
        id: String(i + 1),
        method: "POST",
        url: `/me/messages/${encodeURIComponent(id)}/move`,
        headers: { "Content-Type": "application/json" },
        body: { destinationId: dest.id },
      }))
      const responses = await graphBatch(accessToken, requests)
      const summary = summarizeBatch(ids, responses, [201, 200])
      if (summary.moved_or_updated === 0 && summary.failed.length > 0) {
        const first = summary.failed[0]!
        throw new Error(
          `falha ao mover: ${first.error}` +
            (summary.failed.length > 1
              ? ` (+${summary.failed.length - 1} outras)`
              : ""),
        )
      }
      return {
        ok: true,
        destination_folder_id: dest.id,
        matched_by: dest.matchedBy,
        moved: summary.moved_or_updated,
        failed: summary.failed,
      }
    }
    case "mark_messages_read": {
      const ids = parseIdList(input.message_ids)
      const isRead =
        typeof input.is_read === "boolean"
          ? input.is_read
          : input.is_read === undefined
            ? true
            : Boolean(input.is_read)
      const requests: BatchRequest[] = ids.map((id, i) => ({
        id: String(i + 1),
        method: "PATCH",
        url: `/me/messages/${encodeURIComponent(id)}`,
        headers: { "Content-Type": "application/json" },
        body: { isRead },
      }))
      const responses = await graphBatch(accessToken, requests)
      const summary = summarizeBatch(ids, responses, [200])
      if (summary.moved_or_updated === 0 && summary.failed.length > 0) {
        const first = summary.failed[0]!
        throw new Error(
          `falha ao marcar lido: ${first.error}` +
            (summary.failed.length > 1
              ? ` (+${summary.failed.length - 1} outras)`
              : ""),
        )
      }
      return {
        ok: true,
        is_read: isRead,
        updated: summary.moved_or_updated,
        failed: summary.failed,
      }
    }
    default:
      throw new Error(`função Outlook desconhecida: ${fn}`)
  }
}
