-- Modelo de IA por conversa: cada chat lembra o modelo escolhido/usado.
-- O seletor global vira só o default para conversas NOVAS; trocar o modelo
-- dentro de uma conversa não vaza para as outras.
alter table public.agent_chats
  add column if not exists model text;
