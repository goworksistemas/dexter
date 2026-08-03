-- Índices cobrindo FKs user_id (advisor unindexed_foreign_keys)
create index if not exists agent_feedback_user_idx on public.agent_feedback (user_id);
create index if not exists agent_tool_calls_user_idx on public.agent_tool_calls (user_id);
