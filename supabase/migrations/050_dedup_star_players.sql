-- ============================================================
-- Migration 050: Dedup star players (full-name seed vs squad initials)
-- ============================================================
-- CONTEXTO
--   public.players foi populada por DUAS fontes com convenções de nome diferentes:
--     1. 02_players.sql        -> ~52 estrelas com NOME COMPLETO ('Kylian Mbappé')
--     2. sync-players.js       -> elenco completo via squads.json com INICIAIS ('K. Mbappé')
--   A identidade da tabela é UNIQUE(full_name, team), então os dois nunca casaram e
--   33 estrelas ficaram DUPLICADAS (Mbappé, Messi, Haaland, Lautaro, Salah, ...).
--   O DELETE do sync não removeu as duplicatas porque top_scorer_picks.player_id é
--   ON DELETE RESTRICT (001_schema.sql:97) — palpites seguravam a linha.
--
-- DECISÃO
--   Mantemos a linha de NOME COMPLETO (keeper) e removemos a de INICIAIS (loser).
--   squads.json já foi renomeado p/ nomes completos no mesmo commit, então o próximo
--   sync-players.js vira no-op (não recria as iniciais). => fix permanente.
--
-- SEGURANÇA DOS PALPITES (requisito do usuário: ninguém pode ficar sem palpite)
--   top_scorer_picks tem PK = user_id (1 palpite por usuário). Reapontar player_id
--   da linha loser -> keeper é UPDATE in-place: nunca cria 2ª linha p/ o mesmo user,
--   nunca viola PK, nunca perde palpite. player_goals (CASCADE) é reapontado ANTES
--   do delete. O alert trigger de "scorer change" já foi removido (026), então o
--   reaponte NÃO dispara notificação aos usuários.
--
-- COMO RODAR (Supabase SQL Editor)
--   1) Rode primeiro o bloco [PREVIEW] (somente leitura) e confira picks_to_move.
--   2) Rode o bloco [APPLY] inteiro (transação; faz rollback sozinho se sobrar algo).
-- ============================================================


-- ============================================================
-- [PREVIEW] — somente leitura. Rode SOZINHO antes de aplicar.
-- Mostra, por par, se as duas linhas existem e quantos palpites/gols serão movidos.
-- ============================================================
with pairs(team, keep_name, drop_name) as (values
  ('France', 'Kylian Mbappé', 'K. Mbappé'),
  ('France', 'Ousmane Dembélé', 'O. Dembélé'),
  ('France', 'Bradley Barcola', 'B. Barcola'),
  ('Argentina', 'Lionel Messi', 'L. Messi'),
  ('Argentina', 'Julián Álvarez', 'J. Álvarez'),
  ('Argentina', 'Lautaro Martínez', 'L. Martínez'),
  ('Brazil', 'Vinícius Júnior', 'V. Júnior'),
  ('Norway', 'Erling Haaland', 'E. Haaland'),
  ('England', 'Harry Kane', 'H. Kane'),
  ('England', 'Bukayo Saka', 'B. Saka'),
  ('England', 'Jude Bellingham', 'J. Bellingham'),
  ('Spain', 'Lamine Yamal', 'L. Yamal'),
  ('Spain', 'Nico Williams', 'N. Williams'),
  ('Germany', 'Florian Wirtz', 'F. Wirtz'),
  ('Germany', 'Jamal Musiala', 'J. Musiala'),
  ('Germany', 'Kai Havertz', 'K. Havertz'),
  ('Egypt', 'Mohamed Salah', 'M. Salah'),
  ('Netherlands', 'Cody Gakpo', 'C. Gakpo'),
  ('Netherlands', 'Memphis Depay', 'M. Depay'),
  ('Belgium', 'Romelu Lukaku', 'R. Lukaku'),
  ('Belgium', 'Kevin De Bruyne', 'K. De Bruyne'),
  ('Colombia', 'Luis Díaz', 'L. Díaz'),
  ('Colombia', 'James Rodríguez', 'J. Rodríguez'),
  ('Uruguay', 'Darwin Núñez', 'D. Núñez'),
  ('Uruguay', 'Federico Valverde', 'F. Valverde'),
  ('United States', 'Christian Pulisic', 'C. Pulisic'),
  ('United States', 'Folarin Balogun', 'F. Balogun'),
  ('Mexico', 'Santiago Giménez', 'S. Giménez'),
  ('Morocco', 'Achraf Hakimi', 'A. Hakimi'),
  ('South Korea', 'Son Heung-min', 'S. Heung-Min'),
  ('Switzerland', 'Breel Embolo', 'B. Embolo'),
  ('Croatia', 'Andrej Kramarić', 'A. Kramarić'),
  ('Japan', 'Takefusa Kubo', 'T. Kubo')
)
select
  p.team,
  p.keep_name, k.id  as keep_id, k.shirt_number as keep_num,
  p.drop_name, l.id  as drop_id, l.shirt_number as drop_num,
  coalesce((select count(*) from public.top_scorer_picks t where t.player_id = l.id), 0) as picks_to_move,
  coalesce((select count(*) from public.player_goals    g where g.player_id = l.id), 0) as goals_to_move,
  case when k.id is null then 'SEM KEEPER (não toca)'
       when l.id is null then 'sem duplicata (ok)'
       else 'merge' end as status
from pairs p
left join public.players k on k.team = p.team and k.full_name = p.keep_name
left join public.players l on l.team = p.team and l.full_name = p.drop_name
order by picks_to_move desc, p.team;


-- ============================================================
-- [APPLY] — transação. Rode este bloco inteiro depois de conferir o preview.
-- ============================================================
begin;

create temp table _dedup(team text, keep_name text, drop_name text) on commit drop;
insert into _dedup(team, keep_name, drop_name) values
  ('France', 'Kylian Mbappé', 'K. Mbappé'),
  ('France', 'Ousmane Dembélé', 'O. Dembélé'),
  ('France', 'Bradley Barcola', 'B. Barcola'),
  ('Argentina', 'Lionel Messi', 'L. Messi'),
  ('Argentina', 'Julián Álvarez', 'J. Álvarez'),
  ('Argentina', 'Lautaro Martínez', 'L. Martínez'),
  ('Brazil', 'Vinícius Júnior', 'V. Júnior'),
  ('Norway', 'Erling Haaland', 'E. Haaland'),
  ('England', 'Harry Kane', 'H. Kane'),
  ('England', 'Bukayo Saka', 'B. Saka'),
  ('England', 'Jude Bellingham', 'J. Bellingham'),
  ('Spain', 'Lamine Yamal', 'L. Yamal'),
  ('Spain', 'Nico Williams', 'N. Williams'),
  ('Germany', 'Florian Wirtz', 'F. Wirtz'),
  ('Germany', 'Jamal Musiala', 'J. Musiala'),
  ('Germany', 'Kai Havertz', 'K. Havertz'),
  ('Egypt', 'Mohamed Salah', 'M. Salah'),
  ('Netherlands', 'Cody Gakpo', 'C. Gakpo'),
  ('Netherlands', 'Memphis Depay', 'M. Depay'),
  ('Belgium', 'Romelu Lukaku', 'R. Lukaku'),
  ('Belgium', 'Kevin De Bruyne', 'K. De Bruyne'),
  ('Colombia', 'Luis Díaz', 'L. Díaz'),
  ('Colombia', 'James Rodríguez', 'J. Rodríguez'),
  ('Uruguay', 'Darwin Núñez', 'D. Núñez'),
  ('Uruguay', 'Federico Valverde', 'F. Valverde'),
  ('United States', 'Christian Pulisic', 'C. Pulisic'),
  ('United States', 'Folarin Balogun', 'F. Balogun'),
  ('Mexico', 'Santiago Giménez', 'S. Giménez'),
  ('Morocco', 'Achraf Hakimi', 'A. Hakimi'),
  ('South Korea', 'Son Heung-min', 'S. Heung-Min'),
  ('Switzerland', 'Breel Embolo', 'B. Embolo'),
  ('Croatia', 'Andrej Kramarić', 'A. Kramarić'),
  ('Japan', 'Takefusa Kubo', 'T. Kubo');

-- Resolve nomes -> ids. INNER JOIN: pares sem keeper OU sem loser são ignorados (no-op seguro).
-- Capturamos api_player_id/número/posição do loser p/ herdar no keeper antes de apagar.
create temp table _map on commit drop as
select d.team, k.id as keep_id, l.id as drop_id,
       l.api_player_id as drop_api, l.shirt_number as drop_num, l.position as drop_pos
from _dedup d
join public.players k on k.team = d.team and k.full_name = d.keep_name
join public.players l on l.team = d.team and l.full_name = d.drop_name;

-- 1) PALPITES: reaponta loser -> keeper. PK = user_id, então é UPDATE in-place sem colisão.
update public.top_scorer_picks t
set player_id = m.keep_id
from _map m
where t.player_id = m.drop_id;

-- 2) GOLS (normalmente vazio pré-torneio). Funde colisões em (player_id, match_id) e reaponta o resto.
update public.player_goals g
set goals = g.goals + d.goals
from _map m
join public.player_goals d on d.player_id = m.drop_id
where g.player_id = m.keep_id and g.match_id = d.match_id;

delete from public.player_goals g
using _map m
where g.player_id = m.drop_id
  and exists (select 1 from public.player_goals k
              where k.player_id = m.keep_id and k.match_id = g.match_id);

update public.player_goals g
set player_id = m.keep_id
from _map m
where g.player_id = m.drop_id;

-- 3a) Libera o api_player_id do loser ANTES de transferir (índice único parcial uniq_players_api_id).
update public.players l
set api_player_id = null
from _map m
where l.id = m.drop_id and l.api_player_id is not null;

-- 3b) Keeper herda api_player_id (link da API) + número/posição do loser quando estiverem nulos.
--     Assim o próximo sync-squads.js casa por api_player_id e NÃO recria a linha de iniciais.
update public.players k
set api_player_id = coalesce(k.api_player_id, m.drop_api),
    shirt_number  = coalesce(k.shirt_number,  m.drop_num),
    position      = coalesce(k.position,       m.drop_pos)
from _map m
where k.id = m.keep_id;

-- 4) Apaga as linhas de iniciais (agora sem nenhuma FK apontando p/ elas).
delete from public.players p
using _map m
where p.id = m.drop_id;

-- 5) GUARD: se sobrou alguma linha loser que tinha keeper, algo deu errado -> ROLLBACK automático.
do $$
declare n int;
begin
  select count(*) into n from public.players p join _map m on p.id = m.drop_id;
  if n > 0 then
    raise exception 'Dedup incompleto: % linha(s) de iniciais ainda referenciada(s). Rollback.', n;
  end if;
end $$;

commit;
