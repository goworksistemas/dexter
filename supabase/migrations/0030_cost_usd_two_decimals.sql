-- Custo USD: 2 casas decimais (mensagens + backfill).

update public.agent_messages
set cost_usd = round(cost_usd::numeric, 2)
where cost_usd is not null and cost_usd <> round(cost_usd::numeric, 2);

create or replace function public.dexter_backfill_message_costs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with matched as (
    select
      m.id as message_id,
      round((
        (coalesce(m.tokens_in, 0)::numeric / 1000000) * coalesce(p.input_usd_per_million, 0) +
        (coalesce(m.tokens_out, 0)::numeric / 1000000) * coalesce(p.output_usd_per_million, 0)
      )::numeric, 2) as cost
    from public.agent_messages m
    cross join lateral (
      select input_usd_per_million, output_usd_per_million
      from public.dexter_model_pricing pr
      where (pr.input_usd_per_million is not null or pr.output_usd_per_million is not null)
        and (
          pr.id = nullif(trim(m.model), '')
          or pr.id like '%:' || nullif(trim(m.model), '')
        )
      order by
        case
          when pr.id = nullif(trim(m.model), '') then 0
          when pr.id like '%:' || nullif(trim(m.model), '') then 1
          else 2
        end,
        length(pr.id)
      limit 1
    ) p
    where m.role = 'assistant'
      and nullif(trim(m.model), '') is not null
      and (m.cost_usd is null or m.cost_usd = 0)
      and (coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0)) > 0
  )
  update public.agent_messages m
  set cost_usd = matched.cost
  from matched
  where m.id = matched.message_id
    and matched.cost > 0;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
