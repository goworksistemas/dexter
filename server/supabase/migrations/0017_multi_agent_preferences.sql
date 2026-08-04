-- Documenta preferência opt-in de multi-agentes em profiles.preferences (jsonb).
-- Shape: preferences.multi_agent = { "enabled": true, "authorized_at": "<ISO8601>" }
-- Só quando enabled=true E authorized_at presente o AgentCore expõe dexter__spawn_subagent.

comment on column public.profiles.preferences is
  'Preferências do usuário (jsonb): theme, sidebarCollapsed, connectors {notion,outlook}, '
  'multi_agent {enabled, authorized_at} para delegação opt-in a sub-agentes.';
