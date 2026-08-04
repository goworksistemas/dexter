-- Documenta preferências de conectores externos em profiles.preferences (jsonb).
-- Shape: preferences.connectors = { "notion"?: boolean, "outlook"?: boolean }
-- Sem tabela nova: tokens ficam no Infisical (workspace/app); OAuth por usuário é etapa futura.

comment on column public.profiles.preferences is
  'Preferências do usuário (jsonb). Campos conhecidos: theme, sidebarCollapsed, connectors.{notion,outlook} (boolean).';
