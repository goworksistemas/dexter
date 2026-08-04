-- Realtime para abas dedicadas de artefato (postgres_changes).
-- Filtro por id (PK) — replica identity default basta.

do $$
begin
  alter publication supabase_realtime add table public.agent_artifacts;
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'publication supabase_realtime ausente — ignore em ambientes sem Realtime';
end $$;
