-- =============================================================================
-- agent_message_embeddings — RAG sobre o histórico longo de uma conversa
-- Projeto Supabase "agentcore"
--
-- A janela deslizante (CONTEXT_WINDOW_MESSAGES) manda ao modelo só as últimas N
-- mensagens e o resumo rolling cobre o resto em visão geral. Falta o DETALHE
-- pontual: numa conversa de 50 turnos, "qual era o número do ticket que a gente
-- viu lá atrás?" não está nem na janela nem no resumo. Esta tabela guarda o
-- embedding das mensagens que JÁ saíram da janela para que o server recupere os
-- trechos relevantes à pergunta nova.
--
-- Dimensão 1536 = OpenAI text-embedding-3-small (mesma escolha de
-- agent_knowledge na 0001). Trocar de modelo de embedding exige nova coluna/
-- tabela — o índice HNSW é fixo na dimensão.
--
-- Acesso: só service_role (o AgentCore lê/escreve). Mesmo modelo de
-- agent_knowledge e agent_kb_docs: RLS habilitada e NENHUMA policy.
-- =============================================================================

create extension if not exists vector;

create table if not exists public.agent_message_embeddings (
  -- 1 embedding por mensagem: a PK é a própria mensagem (reindexar = upsert).
  message_id  uuid primary key
              references public.agent_messages(id) on delete cascade,
  -- Redundante com agent_messages.chat_id de propósito: a busca vetorial filtra
  -- por chat ANTES do ANN, e um join para descobrir o chat mataria o índice.
  chat_id     uuid not null
              references public.agent_chats(id) on delete cascade,
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now()
);

create index if not exists agent_message_embeddings_chat_idx
  on public.agent_message_embeddings (chat_id);

-- ANN por similaridade coseno (mesmo operador usado na RPC abaixo).
create index if not exists agent_message_embeddings_vec_idx
  on public.agent_message_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.agent_message_embeddings enable row level security;
-- Sem policies de propósito: RLS habilitada + zero policy = negado para anon e
-- authenticated. Só o service_role (backend) enxerga.

revoke all on public.agent_message_embeddings from anon, authenticated;

-- =============================================================================
-- match_chat_messages — top-k mensagens antigas mais próximas da pergunta nova.
-- ESCOPADA AO CHAT: o p_chat_id entra no WHERE, então não há como um chat
-- recuperar trecho de outro (a checagem de dono do chat é feita no AgentCore
-- antes de chamar). Devolve só id + distância; o conteúdo o server já lê de
-- agent_messages com o filtro de ownership de sempre.
-- =============================================================================
create or replace function public.match_chat_messages(
  p_chat_id uuid,
  p_query_embedding vector(1536),
  p_limit int default 3
)
returns table (message_id uuid, distance double precision)
language sql
stable
security definer
-- `extensions` é OBRIGATÓRIO aqui: neste projeto o pgvector está instalado
-- nesse schema (padrão do Supabase), então sem ele o operador `<=>` não
-- resolve em tempo de execução. `pg_temp` explicitamente por último para uma
-- função SECURITY DEFINER não poder ser sequestrada por objeto temporário.
set search_path = public, extensions, pg_temp
as $$
  select e.message_id,
         (e.embedding <=> p_query_embedding)::double precision as distance
  from public.agent_message_embeddings e
  where e.chat_id = p_chat_id
  order by e.embedding <=> p_query_embedding
  limit greatest(1, least(coalesce(p_limit, 3), 20));
$$;

revoke all on function public.match_chat_messages(uuid, vector, int) from public;
revoke all on function public.match_chat_messages(uuid, vector, int) from anon, authenticated;
grant execute on function public.match_chat_messages(uuid, vector, int) to service_role;

comment on table public.agent_message_embeddings is
  'Embeddings (text-embedding-3-small, 1536d) das mensagens que saíram da janela de contexto — RAG do histórico longo por chat. Acesso só service_role.';
