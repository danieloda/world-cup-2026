-- ============================================================
-- Migration 018: Renomeia 'Turkey' → 'Türkiye' (nome oficial FIFA)
-- ============================================================
-- A API-Football passou a usar 'Türkiye' (nome oficial desde 2022).
-- O DB foi seedado com 'Turkey' antigo. Vamos alinhar pra match cap. FIFA
-- e evitar duplicação de squads (Turkey + Türkiye).
--
-- Tabelas afetadas: players.team, matches.team_home/away/slot_home/slot_away.
-- team_fifa_rank já está com 'Türkiye'.
--
-- Idempotente: pode rodar várias vezes sem efeito se já estiver renomeado.

update public.players
   set team = 'Türkiye'
 where team = 'Turkey';

update public.matches
   set team_home = 'Türkiye'
 where team_home = 'Turkey';

update public.matches
   set team_away = 'Türkiye'
 where team_away = 'Turkey';

update public.matches
   set slot_home = 'Türkiye'
 where slot_home = 'Turkey';

update public.matches
   set slot_away = 'Türkiye'
 where slot_away = 'Turkey';

-- team_fifa_rank: se houver row 'Turkey' duplicada, remove (ja temos Türkiye)
delete from public.team_fifa_rank where team = 'Turkey';
