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


/** Tools genéricas (schema + SQL read-only) — disponíveis em TODOS os sistemas
 * com dexter_whoami. Preferir tools especializadas quando couber; usar estas
 * quando a pergunta não couber nas especializadas. */
const GENERIC_QUERY_TOOLS: SystemTool[] = [
  {
    fn: "dexter_schema",
    label: "Explorar schema",
    description: "Introspecção do banco. Sem p_tabela: lista TODAS as tabelas (nome, comentário, nº de colunas, linhas estimadas). Com p_tabela: colunas (nome, tipo, comentário) + FKs. USE antes de dexter_sql. Gate: has_access do usuário.",
    params: [{ name: "p_tabela", type: "string", description: "Nome da tabela p/ ver colunas+FKs. Omita p/ listar todas as tabelas." }],
  },
  {
    fn: "dexter_sql",
    label: "Consulta SQL (read-only)",
    description: "Executa UMA consulta SQL SOMENTE-LEITURA (apenas SELECT/WITH). Coringa quando as especializadas não cobrem: explore com dexter_schema, monte o SELECT e rode aqui. Para totais use count(*) / group by — NÃO liste milhares de linhas. Schema-qualifique (ex.: public.tickets). Escrita bloqueada. Lista cap 1000 linhas + timeout; totais via agregação não são truncados.",
    params: [
      { name: "p_sql", type: "string", description: "A consulta SELECT/WITH (sem ;). Para totais: select count(*) from public.tickets where company_id = '...'", required: true },
      { name: "p_limit", type: "number", description: "Máx. de linhas da LISTA (default 200, cap 1000). Para count(*)/group by pode omitir — retorna poucas linhas." },
    ],
  },
]

export const SYSTEM_TOOLS: Record<string, SystemTool[]> = {
  networkgo: [
    { fn: "dexter_tickets_resumo", label: "Tickets", description: "Resumo de chamados: total, urgentes abertos, atrasados, avaliação média, quebra por status/categoria + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_os_resumo", label: "Ordens de serviço", description: "Resumo de OS: total, atrasadas, custo total/médio, avaliação, quebra por status/tipo + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_correspondencia_resumo", label: "Correspondência", description: "Resumo de correspondências: total, pendentes, tempo médio de entrega, por status/tipo + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_reservas_resumo", label: "Reservas de sala", description: "Resumo de reservas (por start_date): total, confirmadas/canceladas/no-show, receita paga, por status/sala + recentes.", params: PERIODO_BUILDING },
    { fn: "dexter_satisfacao_resumo", label: "Satisfação (NPS)", description: "Resumo de satisfação: total de respostas, NPS médio, promoters/passives/detractors, por follow-up/categoria + recentes.", params: PERIODO_BUILDING },
    {
      fn: "dexter_tickets_busca",
      label: "Buscar tickets",
      description: "Busca chamados por código (ticket_number N####), título/descrição, solicitante/responsável (nome), status, prédio, empresa (cadastro). p_texto casa também em ticket_number — use N6324 direto. Pessoas = public.profiles (user_id/assigned_to/agent_id), NÃO public.users. Para ANALISAR 1 chamado: após achar, use dexter_sql denso (descrição, joins, histórico do cliente). NÃO use p_texto sozinho para totais por empresa — use p_empresa/p_company_id. Retorna total_encontrado + itens (cap 50). Histórico: p_dias=0.",
      params: [
        { name: "p_texto", type: "string", description: "Código (N6324), título ou descrição (ilike em ticket_number/title/description). Opcional. NÃO substitui filtro por empresa." },
        { name: "p_solicitante", type: "string", description: "Nome de quem abriu (ilike). Opcional." },
        { name: "p_responsavel", type: "string", description: "Nome do responsável/agente (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Status (ilike). Opcional." },
        { name: "p_building_id", type: "string", description: "UUID do prédio. Opcional." },
        { name: "p_dias", type: "number", description: "Janela em dias (default 30). Use 0 para histórico completo." },
        { name: "p_limit", type: "number", description: "Máx. na lista/amostra (default 50)." },
        { name: "p_company_id", type: "string", description: "UUID da empresa (tickets.company_id). Preferível após achar no cadastro." },
        { name: "p_empresa", type: "string", description: "Nome da empresa no cadastro (ilike em name/fantasia/razao_social/nome_omie/profile_name). Opcional." },
      ],
    },
    {
      fn: "dexter_os_busca",
      label: "Buscar OS",
      description: "Busca ordens de serviço por número (service_order_number), solicitante/executor (nome), texto, status, prédio. Total real + lista.",
      params: [
        { name: "p_texto", type: "string", description: "Número da OS, título ou descrição (ilike). Opcional." },
        { name: "p_solicitante", type: "string", description: "Nome do solicitante (ilike). Opcional." },
        { name: "p_responsavel", type: "string", description: "Nome do executor/designado (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Status (ilike). Opcional." },
        { name: "p_building_id", type: "string", description: "UUID do prédio. Opcional." },
        { name: "p_dias", type: "number", description: "Janela em dias (default 30)." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Lista valores válidos p/ filtrar. p_dimensao: status | categorias | buildings | responsaveis | companies. p_contexto: tickets (default) | os.",
      params: [
        { name: "p_dimensao", type: "string", description: "status | categorias | buildings | responsaveis | companies", required: true },
        { name: "p_contexto", type: "string", description: "tickets (default) | os", required: false },
      ],
    },
    {
      fn: "dexter_pesquisas_listar",
      label: "Listar pesquisas de satisfação",
      description: "Lista as pesquisas do módulo CustOps (cada uma separada: NPS, CSAT, etc.) com tipo, período e nº de respostas. USE ISTO para achar a pesquisa certa antes de pedir o resultado. NUNCA trate a média de várias pesquisas como NPS.",
      params: [
        { name: "p_tipo", type: "string", description: "Filtra o tipo (ex.: nps). Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
      ],
    },
    {
      fn: "dexter_pesquisa_resultado",
      label: "Resultado de UMA pesquisa",
      description: "Métrica de uma pesquisa específica (por id ou título). Para tipo nps: NPS real (%promoters−%detractors) + promoters/passives/detractors + nota média. Para CSAT/geral: média/distribuição. Se o título casar mais de uma, devolve candidatos (não chuta).",
      params: [
        { name: "p_survey_id", type: "string", description: "UUID da pesquisa (preferível). Opcional se passar título." },
        { name: "p_titulo", type: "string", description: "Título da pesquisa (ilike). Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
      ],
    },
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
      label: "Tarefas Notion (sync GoDash)",
      description:
        "SYNC GoDash das tarefas Notion do quadro interno GoWork: contagem por status/departamento + atrasadas. NÃO é o workspace Notion completo do usuário — para Notion ao vivo (cards/páginas/databases do workspace conectado), use o conector Notion (notion__*).",
      params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 30)." }],
    },
    {
      fn: "dexter_deals_busca",
      label: "Buscar deals",
      description: "Busca deals do funil filtrando por owner (nome), estágio, pipeline. Retorna total + valor + lista.",
      params: [
        { name: "p_owner", type: "string", description: "Nome do responsável (ilike). Opcional." },
        { name: "p_estagio", type: "string", description: "Estágio (ilike). Opcional." },
        { name: "p_pipeline", type: "string", description: "Pipeline (ilike). Opcional." },
        { name: "p_dias", type: "number", description: "Janela em dias (default 90)." },
        { name: "p_limit", type: "number", description: "Máx. (default 50, cap 50)." },
      ],
    },
    {
      fn: "dexter_comissoes_busca",
      label: "Buscar comissões",
      description: "Busca comissões por owner (nome) e status de pagamento. Total + valor + lista.",
      params: [
        { name: "p_owner", type: "string", description: "Nome do owner (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Status de pagamento (ilike). Opcional." },
        { name: "p_dias", type: "number", description: "Janela em dias (default 180)." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Lista valores válidos p/ filtrar (resolver nomes antes de buscar). p_dimensao: owners | pipelines | estagios | status_comissao | departamentos.",
      params: [{ name: "p_dimensao", type: "string", description: "owners | pipelines | estagios | status_comissao | departamentos", required: true }],
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
    {
      fn: "dexter_sugestoes_busca",
      label: "Buscar sugestões",
      description: "Busca sugestões por sistema, status, categoria, tipo, impacto, texto. Escopo: sistemas onde o usuário é admin.",
      params: [
        { name: "p_sistema_slug", type: "string", description: "Sistema (ex.: pipego). Opcional." },
        { name: "p_status", type: "string", description: "Status. Opcional." },
        { name: "p_categoria", type: "string", description: "Categoria. Opcional." },
        { name: "p_tipo", type: "string", description: "Tipo. Opcional." },
        { name: "p_impacto", type: "string", description: "Impacto. Opcional." },
        { name: "p_texto", type: "string", description: "Texto no título (ilike). Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar. p_dimensao: sistemas | status | categorias | tipos | impactos | autores.",
      params: [{ name: "p_dimensao", type: "string", description: "sistemas | status | categorias | tipos | impactos | autores", required: true }],
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
    {
      fn: "dexter_deals_busca",
      label: "Buscar deals",
      description: "Busca deals por owner (nome), estágio, contato, status (aberto/ganho/perdido). Total + lista.",
      params: [
        { name: "p_account_id", type: "string", description: "UUID do tenant. Opcional." },
        { name: "p_owner", type: "string", description: "Nome do responsável (ilike). Opcional." },
        { name: "p_estagio", type: "string", description: "Estágio (ilike). Opcional." },
        { name: "p_contato", type: "string", description: "Nome do contato (ilike). Opcional." },
        { name: "p_status", type: "string", description: "aberto | ganho | perdido. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 50, cap 100)." },
      ],
    },
    {
      fn: "dexter_atividades_busca",
      label: "Buscar atividades",
      description: "Busca atividades por tipo (reunião/tarefa/ligação/…), owner, pendentes ou todas.",
      params: [
        { name: "p_account_id", type: "string", description: "UUID do tenant. Opcional." },
        { name: "p_tipo", type: "string", description: "reuniao | tarefa | ligacao | email | note. Opcional." },
        { name: "p_owner", type: "string", description: "Nome (ilike). Opcional." },
        { name: "p_pendentes", type: "boolean", description: "Só pendentes (default true)." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar. p_dimensao: pipelines | estagios | owners | tipos_atividade | status_deals.",
      params: [
        { name: "p_account_id", type: "string", description: "UUID do tenant. Opcional." },
        { name: "p_dimensao", type: "string", description: "pipelines | estagios | owners | tipos_atividade | status_deals", required: true },
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
    {
      fn: "dexter_ocorrencias_busca",
      label: "Buscar ocorrências",
      description: "Busca ocorrências filtrando por prédio, tipo, status, localização, período. Total real + lista.",
      params: [
        { name: "p_predio", type: "string", description: "Prédio (ilike). Opcional." },
        { name: "p_tipo_problema", type: "string", description: "Tipo (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Status (aberto/em_andamento/resolvido). Opcional." },
        { name: "p_localizacao", type: "string", description: "Localização/ambiente (ilike). Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar. p_dimensao: predios | tipos_problema | status | ambientes | categorias_ambiente | andares | localizacoes.",
      params: [{ name: "p_dimensao", type: "string", description: "predios | tipos_problema | status | ambientes | categorias_ambiente | andares | localizacoes", required: true }],
    },
  ],
  mensurego: [
    { fn: "dexter_rh_colaboradores_estrutura", label: "Colaboradores (estrutura)", description: "Contagem de colaboradores ativos/inativos/gestores por departamento + totais. Só agregados, sem PII individual.", params: [] },
    { fn: "dexter_rh_ferias_saldos", label: "Férias (saldos)", description: "Resumo de férias: períodos abertos, saldo total/médio, vencidos, vencendo, perdas — por departamento. Só agregados.", params: [{ name: "p_dias_alerta", type: "number", description: "Janela de alerta de vencimento em dias (default 90)." }] },
    { fn: "dexter_medicoes_por_unidade", label: "Medições (água/energia)", description: "Consumo de água/energia agregado por unidade (medidores ativos, consumo estimado, última leitura).", params: [] },
    { fn: "dexter_rh_onboarding_offboarding", label: "Onboarding/Offboarding", description: "Cartões do kanban de RH por etapa (L-*/D-*), com atrasados. Só agregados.", params: [] },
    {
      fn: "dexter_rh_colaboradores_busca",
      label: "Buscar colaboradores (agregado)",
      description: "Contagens de colaboradores por departamento/status/tipo de vaga + amostra (nome+cargo+depto, sem PII sensível).",
      params: [
        { name: "p_departamento", type: "string", description: "Departamento (ilike). Opcional." },
        { name: "p_status", type: "string", description: "ativo | inativo. Opcional." },
        { name: "p_tipo_vaga", type: "string", description: "demais | obras. Opcional." },
      ],
    },
    {
      fn: "dexter_medicoes_busca",
      label: "Buscar medições",
      description: "Consumo de água/energia por unidade/tipo na janela de meses.",
      params: [
        { name: "p_unidade", type: "string", description: "Unidade (ilike). Opcional." },
        { name: "p_tipo", type: "string", description: "agua | energia. Opcional." },
        { name: "p_meses", type: "number", description: "Janela em meses (default 6, cap 36)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar. p_dimensao: departamentos | unidades | etapas | status_colaborador | tipos_vaga | tipos_medicao.",
      params: [{ name: "p_dimensao", type: "string", description: "departamentos | unidades | etapas | status_colaborador | tipos_vaga | tipos_medicao", required: true }],
    },
  ],
  supplygo: [
    { fn: "dexter_compras_funil_resumo", label: "Funil de compras", description: "Funil Solicitação→Cotação→Pedido (contagem/status/valor) + pendências de aprovação.", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 90)." }] },
    { fn: "dexter_fornecedores_contratos_resumo", label: "Fornecedores e contratos", description: "Homologação de fornecedores, ranking de spend, saúde de contratos (saldo, vencendo).", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 180)." }, { name: "p_limit", type: "number", description: "Máx. (default 50)." }] },
    { fn: "dexter_vendas_ml_resumo", label: "Vendas Mercado Livre", description: "Vendas ML: pedidos por status/valor, envios, top produtos.", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 30)." }, { name: "p_limit", type: "number", description: "Máx. (default 50)." }] },
    {
      fn: "dexter_compras_busca",
      label: "Buscar compras",
      description: "Busca SC/cotações/pedidos por fornecedor, status, comprador (nome), período.",
      params: [
        { name: "p_fornecedor", type: "string", description: "Fornecedor (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Status. Opcional." },
        { name: "p_comprador", type: "string", description: "Nome do comprador (ilike). Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_vendas_ml_busca",
      label: "Buscar vendas ML",
      description: "Busca pedidos Mercado Livre por status e produto.",
      params: [
        { name: "p_status", type: "string", description: "Status (ilike). Opcional." },
        { name: "p_produto", type: "string", description: "Título do produto (ilike). Opcional." },
        { name: "p_dias", type: "number", description: "Janela em dias (default 30)." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar. p_dimensao: fornecedores | status_sc | status_cotacao | status_pedido | compradores | status_ml | produtos.",
      params: [{ name: "p_dimensao", type: "string", description: "fornecedores | status_sc | status_cotacao | status_pedido | compradores | status_ml | produtos", required: true }],
    },
  ],
  pipego: [
    { fn: "dexter_pipego_contas_receber_resumo", label: "Contas a receber", description: "Contas a receber (OMIE+IUGU) por mês/origem/status + títulos vencidos em aberto.", params: [{ name: "p_dias", type: "number", description: "Janela em dias (default 90)." }, { name: "p_status", type: "string", description: "Filtra status. Opcional." }] },
    { fn: "dexter_pipego_pendencias_resumo", label: "Pendências (cobrança)", description: "Pipeline de cobrança por estágio + fila de trabalho.", params: [{ name: "p_estagio", type: "string", description: "Filtra estágio. Opcional." }, { name: "p_incluir_excluidos", type: "boolean", description: "Incluir excluídos (default false)." }] },
    { fn: "dexter_pipego_jornadas_resumo", label: "Jornadas", description: "Jornadas por tipo/status + recentes.", params: [{ name: "p_tipo_jornada", type: "string", description: "Filtra tipo. Opcional." }, { name: "p_dias", type: "number", description: "Janela em dias (default 180)." }] },
    { fn: "dexter_pipego_clientes_busca", label: "Buscar cliente", description: "Busca em cliente_unico por nome/documento/email/código.", params: [{ name: "p_busca", type: "string", description: "Termo de busca." }, { name: "p_limit", type: "number", description: "Máx. (default 20, cap 50)." }] },
    { fn: "dexter_pipego_obras_resumo", label: "Obras", description: "Obras por status + atrasadas.", params: [{ name: "p_status", type: "string", description: "Filtra status. Opcional." }, { name: "p_incluir_inativas", type: "boolean", description: "Incluir inativas (default false)." }] },
    {
      fn: "dexter_contas_receber_busca",
      label: "Buscar contas a receber",
      description: "Busca títulos por cliente (nome/doc), status, origem, período. Total real + valores + lista.",
      params: [
        { name: "p_cliente", type: "string", description: "Nome ou documento do cliente (ilike). Opcional." },
        { name: "p_status", type: "string", description: "A VENCER | ATRASADO | RECEBIDO | CANCELADO. Opcional." },
        { name: "p_origem", type: "string", description: "COR | GOO | COB | COS. Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. na lista (default 50)." },
      ],
    },
    {
      fn: "dexter_jornadas_busca",
      label: "Buscar jornadas",
      description: "Busca jornadas por cliente, responsável (nome), status, tipo. Total real + lista.",
      params: [
        { name: "p_cliente", type: "string", description: "Nome/doc do cliente (ilike). Opcional." },
        { name: "p_responsavel", type: "string", description: "Nome do responsável comercial (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Nome ou id do status. Opcional." },
        { name: "p_tipo", type: "string", description: "Tipo de jornada. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar. p_dimensao: status_jornada | tipos_jornada | origens | status_conta | status_pendencia | status_obra | responsaveis.",
      params: [{ name: "p_dimensao", type: "string", description: "status_jornada | tipos_jornada | origens | status_conta | status_pendencia | status_obra | responsaveis", required: true }],
    },
  ],
  checkgo: [
    { fn: "dexter_ckl_scores", label: "Scores de checklist", description: "Scores de vistorias: totais/média/status + por unidade (no escopo do usuário).", params: [{ name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }, { name: "p_unidade", type: "string", description: "Filtra unidade (no escopo). Opcional." }] },
    { fn: "dexter_ckl_aplicacoes", label: "Aplicações", description: "Aplicações de checklist: contagem por status + amostra recente.", params: [{ name: "p_status", type: "string", description: "Filtra status. Opcional." }, { name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }, { name: "p_unidade", type: "string", description: "Filtra unidade. Opcional." }] },
    { fn: "dexter_ckl_reincidencias", label: "Reincidências", description: "Eventos de reincidência por unidade/tipo.", params: [{ name: "p_unidade", type: "string", description: "Filtra unidade. Opcional." }, { name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }] },
    { fn: "dexter_ckl_ranking", label: "Ranking de conformidade", description: "Ranking de unidades por percentual médio de conformidade.", params: [{ name: "p_data_inicio", type: "string", description: "Data inicial ISO. Opcional." }, { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." }, { name: "p_limit", type: "number", description: "Máx. (default 20, cap 50)." }] },
    {
      fn: "dexter_ckl_aplicacoes_busca",
      label: "Buscar aplicações",
      description: "Busca aplicações de checklist por unidade, formulário, status, período (no escopo do usuário).",
      params: [
        { name: "p_unidade", type: "string", description: "Unidade (no escopo). Opcional." },
        { name: "p_formulario", type: "string", description: "Formulário (ilike). Opcional." },
        { name: "p_status", type: "string", description: "Status. Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
        { name: "p_limit", type: "number", description: "Máx. (default 50)." },
      ],
    },
    {
      fn: "dexter_ckl_scores_busca",
      label: "Buscar scores",
      description: "Scores filtrados por unidade/formulário/período, com quebra por unidade e por formulário.",
      params: [
        { name: "p_unidade", type: "string", description: "Unidade. Opcional." },
        { name: "p_formulario", type: "string", description: "Formulário (ilike). Opcional." },
        { name: "p_data_ini", type: "string", description: "Data inicial ISO. Opcional." },
        { name: "p_data_fim", type: "string", description: "Data final ISO. Opcional." },
      ],
    },
    {
      fn: "dexter_dimensoes",
      label: "Dimensões (valores)",
      description: "Valores válidos p/ filtrar (no escopo). p_dimensao: unidades | formularios | ambientes | status_aplicacao.",
      params: [{ name: "p_dimensao", type: "string", description: "unidades | formularios | ambientes | status_aplicacao", required: true }],
    },
  ],
}

for (const tools of Object.values(SYSTEM_TOOLS)) {
  tools.push(...GENERIC_QUERY_TOOLS)
}
