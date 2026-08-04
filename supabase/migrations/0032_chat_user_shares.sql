-- Compartilhamento de conversa com outro usuário Dexter (invite → fork).

create table if not exists public.agent_chat_user_shares (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.agent_chats(id) on delete cascade,
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'forked', 'revoked')),
  forked_chat_id uuid references public.agent_chats(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_chat_user_shares_not_self check (from_user_id <> to_user_id)
);

comment on table public.agent_chat_user_shares is
  'Convite de compartilhamento de chat entre usuários; destinatário pode criar fork.';

create unique index if not exists agent_chat_user_shares_pending_uidx
  on public.agent_chat_user_shares (chat_id, to_user_id)
  where status = 'pending';

create index if not exists agent_chat_user_shares_to_pending_idx
  on public.agent_chat_user_shares (to_user_id, created_at desc)
  where status = 'pending';

create index if not exists agent_chat_user_shares_from_idx
  on public.agent_chat_user_shares (from_user_id, chat_id, created_at desc);

alter table public.agent_chat_user_shares enable row level security;

-- Acesso só via AgentCore (service_role). Sem policies para anon/authenticated.
revoke all on table public.agent_chat_user_shares from public;
grant all on table public.agent_chat_user_shares to service_role;
