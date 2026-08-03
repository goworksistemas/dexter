-- Marca artefatos truncados (resposta cortada por max_tokens) para não
-- reinjetá-los no contexto do modelo.
-- Projeto: jtvscxbwralvzpfhtqcs (agentcore)

alter table public.agent_artifacts
  add column if not exists is_truncated boolean not null default false;

comment on column public.agent_artifacts.is_truncated is
  'true quando o conteúdo veio de fence aberto/resposta cortada — não injetar no prompt.';

-- Heurística best-effort para linhas já existentes (HTML sem fechamento).
update public.agent_artifacts
set is_truncated = true
where is_truncated = false
  and kind = 'html'
  and (
    (content ~* '<html' and content !~* '</html>')
    or (content ~* '<body' and content !~* '</body>')
  );
