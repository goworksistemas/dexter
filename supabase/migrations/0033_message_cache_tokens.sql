-- Métricas de prompt caching (Anthropic) por mensagem.
-- Antes desta migration os tokens de cache eram somados a tokens_in, o que
-- inflava o custo (cache read custa 0,10x e write 1,25x o preço de input).
-- Nullable e sem default: mensagens antigas / providers sem caching ficam NULL
-- e não entram nas médias do painel.

alter table public.agent_messages
  add column if not exists tokens_cache_write integer,
  add column if not exists tokens_cache_read integer;

comment on column public.agent_messages.tokens_cache_write is
  'cache_creation_input_tokens do usage da Anthropic — tokens gravados no cache de prompt (custam 1,25x o input). NULL = provider sem prompt caching.';
comment on column public.agent_messages.tokens_cache_read is
  'cache_read_input_tokens do usage da Anthropic — tokens lidos do cache de prompt (custam 0,10x o input). NULL = provider sem prompt caching.';

-- Agregados de cache do painel admin varrem só as mensagens que têm métrica.
create index if not exists agent_messages_cache_tokens_idx
  on public.agent_messages (created_at desc)
  where tokens_cache_read is not null or tokens_cache_write is not null;
