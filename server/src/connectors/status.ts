import { config } from "../config.js"
import {
  CONNECTORS,
  connectorConfigured,
  connectorDetail,
  notionAuthMode,
  notionRuntimeMode,
  outlookAuthMode,
  outlookRuntimeMode,
} from "./registry.js"
import { isConnectorEnabled, loadConnectorPreferences } from "./prefs.js"
import { listConnectorPublicStatuses } from "./store.js"
import type {
  ConnectorId,
  ConnectorRuntime,
  ConnectorStatus,
} from "./types.js"

function notionWorkspaceFallbackActive(): boolean {
  return (
    config.NOTION_ALLOW_WORKSPACE_TOKEN === true &&
    typeof config.NOTION_TOKEN === "string" &&
    config.NOTION_TOKEN.trim().length > 0
  )
}

export async function resolveConnectorRuntime(
  userId: string,
): Promise<ConnectorRuntime> {
  const prefs = await loadConnectorPreferences(userId)
  const connectedMap = await listConnectorPublicStatuses(userId)

  const statuses: ConnectorStatus[] = CONNECTORS.map((c) => {
    const configured = connectorConfigured(c.id)
    const row = connectedMap.get(c.id)
    const connected =
      row?.status === "connected" ||
      (c.id === "notion" && notionWorkspaceFallbackActive())
    const enabled = connected && isConnectorEnabled(prefs, c.id)
    const workspaceName =
      typeof row?.meta?.workspace_name === "string"
        ? row.meta.workspace_name
        : undefined
    const safeMeta = row?.meta
      ? {
          workspace_name: row.meta.workspace_name ?? null,
          workspace_id: row.meta.workspace_id ?? null,
        }
      : undefined

    return {
      id: c.id,
      label: c.label,
      configured,
      connected,
      enabled,
      authMode: c.id === "notion" ? notionAuthMode() : outlookAuthMode(),
      runtimeMode:
        c.id === "notion" ? notionRuntimeMode() : outlookRuntimeMode(),
      detail: connectorDetail({
        id: c.id,
        configured,
        connected,
        enabled,
        workspaceName,
      }),
      meta: safeMeta,
    }
  })

  const active = new Set<ConnectorId>()
  for (const s of statuses) {
    if (s.configured && s.connected && s.enabled) active.add(s.id)
  }

  return { active, prefs, statuses }
}

export function connectorsPromptBlock(runtime: ConnectorRuntime): string {
  const lines: string[] = []
  let notionEnabled = false
  for (const s of runtime.statuses) {
    if (!s.configured) continue
    if (!s.connected) {
      lines.push(
        `- ${s.label} (slug: ${s.id}): usuário ainda não conectou — oriente a clicar Conectar em Conexões. NÃO invente dados desse serviço e NÃO use GoDash/outros sistemas como substituto.`,
      )
      continue
    }
    if (s.enabled) {
      if (s.id === "notion") notionEnabled = true
      lines.push(
        `- ${s.label} (slug: ${s.id}): HABILITADO — use as tools \`${s.id}__*\` (token OAuth deste usuário; Notion via MCP).`,
      )
    } else {
      lines.push(
        `- ${s.label} (slug: ${s.id}): conta conectada, mas DESLIGADO pelo usuário (não use tools desse conector). Oriente a religar em Conexões se a pergunta for sobre esse serviço.`,
      )
    }
  }
  if (lines.length === 0) return ""

  let notionRules = ""
  if (notionEnabled) {
    notionRules =
      "\n\n### Notion (conector) — roteamento obrigatório" +
      "\n- Perguntas sobre o workspace Notion do usuário (páginas, databases, cards, boards, propriedades): use SEMPRE as tools \`notion__*\` do conector." +
      "\n- \`notion-fetch\` / fetch com id=\`self\` NÃO lista conteúdo: só devolve identidade (workspace/usuário). NUNCA use isso para contar cards/páginas." +
      "\n- IDs: database/page = UUID ou URL. data_source = \`collection://<uuid>\` vindo do fetch. NUNCA invente \`collection://\` com o database_id — causa Data source not found." +
      "\n- Criar card: (1) \`notion-fetch\` UMA vez no database → ler schema + collection://; (2) \`notion-create-pages\` com parent={data_source_id} e properties do schema. Se o schema veio, NÃO peça print e NÃO desista sem tentar create." +
      "\n- Se a mesma tool+args falhar/vazio 2x: pare e reporte o erro técnico (não refetch 10x o mesmo id)." +
      "\n- Para contar ou listar: use \`notion-search\` e/ou \`notion-query-data-sources\` com o data_source correto. Paginar se necessário." +
      "\n- GoDash \`godash__dexter_notion_tasks_*\` é SYNC interno GoWork — NÃO substitui o Notion ao vivo." +
      "\n- Não narre 'vou buscar / deixa eu puxar' sem chamar a tool. Após as tools, feche com resultado concreto ou erro técnico claro."
  }

  return (
    "\n\n## Conectores externos\n" +
    lines.join("\n") +
    "\n- Só afirme o que as tools desses conectores retornarem.\n" +
    "- Se a tool falhar pedindo conexão, oriente o usuário a conectar Notion/Outlook em Conexões." +
    notionRules
  )
}
