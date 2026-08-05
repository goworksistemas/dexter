-- =============================================================================
-- 0035 — Bulk actions em conversas: arquivar (archived_at) e excluir sem
-- perder histórico de custo (deleted_at, soft delete).
--
-- `project_id` já existe desde a 0005 (mover para projeto não muda schema).
--
-- DECISÃO (custo × exclusão): excluir conversa é SOFT DELETE. As linhas de
-- agent_chats e agent_messages ficam intactas; só as listagens do usuário
-- (GET /api/chats) passam a filtrar `deleted_at is null`. A central de custo
-- do admin (dexter_admin_cost_center / dexter_admin_overview /
-- dexter_admin_user_detail, migration 0027) agrega cost_usd/tokens de
-- agent_messages via join em agent_chats e CONTINUA enxergando conversas
-- excluídas e arquivadas — é o histórico real de gasto; o hard delete antigo
-- (cascade em agent_messages) apagava esse histórico.
-- =============================================================================

alter table public.agent_chats
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz;

comment on column public.agent_chats.archived_at is
  'Conversa arquivada pelo usuário: sai da lista principal, aparece na seção "Arquivadas". Reversível (null = ativa).';
comment on column public.agent_chats.deleted_at is
  'Soft delete: some de TODAS as listagens do usuário, mas mensagens/custos ficam no banco para a central de custo do admin.';

-- Listagem quente da sidebar: chats vivos do usuário por atualização.
-- Parcial: linhas excluídas ficam fora do índice (elas só interessam ao admin,
-- que varre por agent_messages).
create index if not exists agent_chats_user_alive_idx
  on public.agent_chats (user_id, updated_at desc)
  where deleted_at is null;
