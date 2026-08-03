/**
 * Manifesto de tools por sistema — o catálogo de RPCs read-only que o Dexter
 * pode chamar. Montado a partir do que cada agente aplicou em cada banco.
 *
 * IMPORTANTE: `p_email` NÃO aparece aqui de propósito — o backend injeta o
 * email do usuário AUTENTICADO em toda chamada. O LLM nunca escolhe de quem é
 * o dado. Os params abaixo são só os filtros que o modelo pode passar.
 *
 * (Preenchido incrementalmente conforme os sistemas ficam prontos.)
 */
export type ToolParamType = "string" | "number" | "boolean"

export interface ToolParam {
  name: string
  type: ToolParamType
  description: string
  required?: boolean
}

export interface SystemTool {
  /** nome da RPC no banco (chamada com p_email + estes params). */
  fn: string
  /** rótulo curto. */
  label: string
  description: string
  params: ToolParam[]
}

const PERIODO_BUILDING: ToolParam[] = [
  { name: "p_dias", type: "number", description: "Janela em dias (default 30)." },
  { name: "p_building_id", type: "string", description: "UUID do prédio p/ filtrar. Opcional." },
]

export const SYSTEM_TOOLS: Record<string, SystemTool[]> = {
  networkgo: [
    { fn: "dexter_tickets_resumo", label: "Tickets", description: "Resumo de chamados: total, urgentes abertos, atrasados, avaliação média, quebra por status/categoria + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_os_resumo", label: "Ordens de serviço", description: "Resumo de OS: total, atrasadas, custo total/médio, avaliação, quebra por status/tipo + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_correspondencia_resumo", label: "Correspondência", description: "Resumo de correspondências: total, pendentes, tempo médio de entrega, por status/tipo + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_reservas_resumo", label: "Reservas de sala", description: "Resumo de reservas (por start_date): total, confirmadas/canceladas/no-show, receita paga, por status/sala + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_satisfacao_resumo", label: "Satisfação (NPS)", description: "Resumo de satisfação: total de respostas, NPS médio, promoters/passives/detractors, por follow-up/categoria + recentes.", params: PERIODO_BUILDING },
  ],
  godash: [
    {
      fn: "dexter_hubspot_funil_resumo",
      label: "Funil HubSpot",
      description: "Resumo do funil de vendas (deals): totais aberto/ganho/perdido e quebra por pipeline e estágio.",
      params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 90)." }],
    },
    {
      fn: "dexter_projecao_financeira_resumo",
      label: "Projeção financeira",
      description: "Contas a pagar e a receber agrupadas por mês de vencimento, origem e status.",
      params: [{ name: "p_meses", type: "number", description: "Nº de meses (default 3)." }],
    },
    {
      fn: "dexter_ranking_comissoes",
      label: "Ranking de comissões",
      description: "Totais e ranking de comissões por responsável (owner).",
      params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 180)." }],
    },
    {
      fn: "dexter_notion_tasks_resumo",
      label: "Tarefas Notion",
      description: "Contagem de tarefas por status/departamento + lista de atrasadas.",
      params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 30)." }],
    },
  ],
  sugestoes: [
    {
      fn: "dexter_sugestoes_resumo_status",
      label: "Resumo de sugestões",
      description: "Agregados de sugestões por status/categoria/tipo/impacto, escopado aos sistemas onde o usuário é admin.",
      params: [
        { name: "p_sistema_slug", type: "string", description: "Filtra por sistema (ex.: networkgo, pipego). Opcional." },
        { name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
      ],
    },
    {
      fn: "dexter_sugestoes_top",
      label: "Top sugestões",
      description: "Lista das sugestões mais votadas (sem campos internos sensíveis).",
      params: [
        { name: "p_sistema_slug", type: "string", description: "Filtra por sistema. Opcional." },
        { name: "p_status", type: "string", description: "Filtra por status. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. de itens (default 20, cap 100)." },
      ],
    },
  ],
  expertgo: [
    {
      fn: "dexter_pipeline_summary",
      label: "Funil (pipeline)",
      description: "Resumo do funil por estágio (contagem e valor de deals) do tenant ativo do usuário.",
      params: [{ name: "p_account_id", type: "string", description: "UUID do tenant. Opcional (default: tenant ativo)." }],
    },
    {
      fn: "dexter_recent_deals",
      label: "Deals recentes",
      description: "Negócios atualizados recentemente (título, valor, estágio, contato, owner).",
      params: [
        { name: "p_account_id", type: "string", description: "UUID do tenant. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. de itens (default 20, cap 50)." },
      ],
    },
    {
      fn: "dexter_open_activities",
      label: "Atividades pendentes",
      description: "Tarefas/ligações/reuniões pendentes, mais próximas do prazo primeiro.",
      params: [
        { name: "p_account_id", type: "string", description: "UUID do tenant. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. de itens (default 20, cap 50)." },
      ],
    },
  ],
  qrapido: [
    {
      fn: "dexter_ocorrencias_metricas",
      label: "Ocorrências (métricas)",
      description: "Métricas de chamados de facilities via QR: total, por status/tipo/prédio, tempo médio de resolução, abertas há +3 dias.",
      params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 30, cap 365)." }],
    },
    {
      fn: "dexter_ocorrencias_lista",
      label: "Ocorrências (lista)",
      description: "Lista de tickets (prédio, andar, ambiente, tipo, status, datas), mais recentes primeiro.",
      params: [
        { name: "p_status", type: "string", description: "Filtra status (aberto/em_andamento/resolvido). Opcional." },
        { name: "p_predio", type: "string", description: "Filtra prédio. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 20, cap 50)." },
      ],
    },
    {
      fn: "dexter_localizacoes_status",
      label: "Status por localização",
      description: "Carga de tickets por localização (abertas/total/última), ordenado por abertas.",
      params: [{ name: "p_predio", type: "string", description: "Filtra prédio. Opcional." }],
    },
  ],
  mensurego: [
    { fn: "dexter_rh_colaboradores_estrutura", label: "Colaboradores (estrutura)", description: "Contagem de colaboradores ativos/inativos/gestores por departamento + totais. Só agregados, sem PII individual.", params: [] },
    { fn: "dexter_rh_ferias_saldos", label: "Férias (saldos)", description: "Resumo de férias: períodos abertos, saldo total/médio, vencidos, vencendo, perdas — por departamento. Só agregados.", params: [{ name: "p_dias_alerta", type: "number", description: "Janela de alerta de vencimento em dias (default 90)." }] },
    { fn: "dexter_medicoes_por_unidade", label: "Medições (água/energia)", description: "Consumo de água/energia agregado por unidade (medidores ativos, consumo estimado, última leitura).", params: [] },
    { fn: "dexter_rh_onboarding_offboarding", label: "Onboarding/Offboarding", description: "Cartões do kanban de RH por etapa (L-*/D-*), com atrasados. Só agregados.", params: [] },
  ],
  supplygo: [
    { fn: "dexter_compras_funil_resumo", label: "Funil de compras", description: "Funil Solicitação→Cotação→Pedido (contagem/status/valor) + pendências de aprovação.", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 90)." }] },
    { fn: "dexter_fornecedores_contratos_resumo", label: "Fornecedores e contratos", description: "Homologação de fornecedores, ranking de spend, saúde de contratos (saldo, vencendo).", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 180)." }, { name: "p_limit", type: "number", description: "Máx. (default 50)." }] },
    { fn: "dexter_vendas_ml_resumo", label: "Vendas Mercado Livre", description: "Vendas ML: pedidos por status/valor, envios, top produtos.", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 30)." }, { name: "p_limit", type: "number", description: "Máx. (default 50)." }] },
  ],
  pipego: [
    { fn: "dexter_pipego_contas_receber_resumo", label: "Contas a receber", description: "Contas a receber (OMIE+IUGU) por mês/origem/status + títulos vencidos em aberto.", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 90)." }, { name: "p_status", type: "string", description: "Filtra status. Opcional." }] },
    { fn: "dexter_pipego_pendencias_resumo", label: "Pendências (cobrança)", description: "Pipeline de cobrança por estágio + fila de trabalho.", params: [{ name: "p_estagio", type: "string", description: "Filtra estágio. Opcional." }, { name: "p_incluir_excluidos", type: "boolean", description: "Incluir excluídos (default false)." }] },
    { fn: "dexter_pipego_jornadas_resumo", label: "Jornadas", description: "Jornadas por tipo/status + recentes.", params: [{ name: "p_tipo_jornada", type: "string", description: "Filtra tipo. Opcional." }, { name: "p_dias", type: "number", description: "Janela em dias (default 180)." }] },
    { fn: "dexter_pipego_clientes_busca", label: "Buscar cliente", description: "Busca em cliente_unico por nome/documento/email/código.", params: [{ name: "p_busca", type: "string", description: "Termo de busca." }, { name: "p_limit", type: "number", description: "Máx. (default 20, cap 50)." }] },
    { fn: "dexter_pipego_obras_resumo", label: "Obras", description: "Obras por status + atrasadas.", params: [{ name: "p_status", type: "string", description: "Filtra status. Opcional." }, { name: "p_incluir_inativas", type: "boolean", description: "Incluir inativas (default false)." }] },
  ],
  checkgo: [
    { fn: "dexter_ckl_scores", label: "Scores de checklist", description: "Scores de vistorias: totais/média/status + por unidade (no escopo do usuário).", params: [{ name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }, { name: "p_unidade", type: "string", description: "Filtra unidade (no escopo). Opcional." }] },
    { fn: "dexter_ckl_aplicacoes", label: "Aplicações", description: "Aplicações de checklist: contagem por status + amostra recente.", params: [{ name: "p_status", type: "string", description: "Filtra status. Opcional." }, { name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }, { name: "p_unidade", type: "string", description: "Filtra unidade. Opcional." }] },
    { fn: "dexter_ckl_reincidencias", label: "Reincidências", description: "Eventos de reincidência por unidade/tipo.", params: [{ name: "p_unidade", type: "string", description: "Filtra unidade. Opcional." }, { name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }] },
    { fn: "dexter_ckl_ranking", label: "Ranking de conformidade", description: "Ranking de unidades por percentual médio de conformidade.", params: [{ name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }, { name: "p_limit", type: "number", description: "Máx. (default 20, cap 50)." }] },
  ],
}
