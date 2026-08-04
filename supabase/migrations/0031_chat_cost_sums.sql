-- Soma de cost_usd por chat (lista do usuário / sidebar).
-- Só chats do próprio usuário (ownership no filtro).

create or replace function public.dexter_sum_chat_costs(
  p_user_id uuid,
  p_chat_ids uuid[]
)
returns table (
  chat_id uuid,
  cost_usd numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.chat_id,
    coalesce(sum(m.cost_usd), 0)::numeric(14, 6) as cost_usd
  from public.agent_messages m
  inner join public.agent_chats c on c.id = m.chat_id
  where c.user_id = p_user_id
    and m.chat_id = any(p_chat_ids)
  group by m.chat_id;
$$;

revoke all on function public.dexter_sum_chat_costs(uuid, uuid[]) from public;
grant execute on function public.dexter_sum_chat_costs(uuid, uuid[]) to service_role;

comment on function public.dexter_sum_chat_costs(uuid, uuid[]) is
  'Soma cost_usd das mensagens por chat, restrito ao dono (p_user_id).';
