-- ============================================================
-- Migration 051: nomes completos p/ as estrelas (conclui a 050)
-- ============================================================
-- DESCOBERTA (preview da 050 no banco real): só 5 estrelas estavam de fato
-- DUPLICADAS (Mbappé, Lamine Yamal, Vinícius Jr, Salah, Nico Williams). As
-- outras 28 só existem como linha de INICIAIS — nunca foram duplicadas.
-- Como o squads.json já foi renomeado p/ nomes completos (commit b49d2d8),
-- as 28 linhas de iniciais ficariam DESALINHADAS do squads.json e um futuro
-- sync-players.js criaria duplicatas novas (ex: Harry Kane c/ 4 palpites,
-- Haaland c/ 2). Esta migration alinha o DB ao squads.json.
--
-- O QUE FAZ (idempotente — seguro rodar com ou sem a 050 aplicada):
--   CASE 1  as duas linhas existem  -> MERGE (reaponta palpites/gols p/ a de
--           nome completo, herda api_player_id, apaga a de iniciais).
--   CASE 2  só existe a de iniciais -> RENAME (full_name = nome completo na
--           MESMA linha => preserva id, palpites e api_player_id; preenche
--           número/posição nulos com o seed).
--   CASE 3  só existe a de nome completo -> nada.
--
-- SEGURANÇA: nenhum palpite se perde. MERGE é UPDATE in-place (PK=user_id);
-- RENAME é a mesma linha (id intacto). Guard final faz ROLLBACK se sobrar
-- qualquer linha de iniciais das 33 estrelas.
--
-- COMO RODAR (Supabase SQL Editor): rode [PREVIEW], confira, rode [APPLY].
-- ============================================================


-- ============================================================
-- [PREVIEW] — somente leitura. Mostra a ação por estrela.
-- ============================================================
with pairs(team, full_name, ini_name) as (values
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
  p.team, p.full_name, f.id as full_id, p.ini_name, i.id as ini_id,
  coalesce((select count(*) from public.top_scorer_picks t where t.player_id = i.id), 0) as picks_on_ini,
  case
    when f.id is not null and i.id is not null then '1-MERGE'
    when f.id is null     and i.id is not null then '2-RENAME'
    when f.id is not null and i.id is null     then '3-ja completo'
    else '4-ausente'
  end as action
from pairs p
left join public.players f on f.team = p.team and f.full_name = p.full_name
left join public.players i on i.team = p.team and i.full_name = p.ini_name
order by action, picks_on_ini desc, p.team;


-- ============================================================
-- [APPLY] — transação idempotente.
-- ============================================================
begin;

create temp table _star(team text, full_name text, ini_name text, seed_num int, seed_pos text) on commit drop;
insert into _star(team, full_name, ini_name, seed_num, seed_pos) values
  ('France', 'Kylian Mbappé', 'K. Mbappé', 10, 'ATA'),
  ('France', 'Ousmane Dembélé', 'O. Dembélé', 11, 'ATA'),
  ('France', 'Bradley Barcola', 'B. Barcola', 9, 'ATA'),
  ('Argentina', 'Lionel Messi', 'L. Messi', 10, 'ATA'),
  ('Argentina', 'Julián Álvarez', 'J. Álvarez', 9, 'ATA'),
  ('Argentina', 'Lautaro Martínez', 'L. Martínez', 22, 'ATA'),
  ('Brazil', 'Vinícius Júnior', 'V. Júnior', 7, 'ATA'),
  ('Norway', 'Erling Haaland', 'E. Haaland', 9, 'ATA'),
  ('England', 'Harry Kane', 'H. Kane', 9, 'ATA'),
  ('England', 'Bukayo Saka', 'B. Saka', 7, 'ATA'),
  ('England', 'Jude Bellingham', 'J. Bellingham', 10, 'MEI'),
  ('Spain', 'Lamine Yamal', 'L. Yamal', 19, 'ATA'),
  ('Spain', 'Nico Williams', 'N. Williams', 17, 'ATA'),
  ('Germany', 'Florian Wirtz', 'F. Wirtz', 17, 'MEI'),
  ('Germany', 'Jamal Musiala', 'J. Musiala', 10, 'MEI'),
  ('Germany', 'Kai Havertz', 'K. Havertz', 7, 'ATA'),
  ('Egypt', 'Mohamed Salah', 'M. Salah', 10, 'ATA'),
  ('Netherlands', 'Cody Gakpo', 'C. Gakpo', 11, 'ATA'),
  ('Netherlands', 'Memphis Depay', 'M. Depay', 10, 'ATA'),
  ('Belgium', 'Romelu Lukaku', 'R. Lukaku', 10, 'ATA'),
  ('Belgium', 'Kevin De Bruyne', 'K. De Bruyne', 7, 'MEI'),
  ('Colombia', 'Luis Díaz', 'L. Díaz', 7, 'ATA'),
  ('Colombia', 'James Rodríguez', 'J. Rodríguez', 10, 'MEI'),
  ('Uruguay', 'Darwin Núñez', 'D. Núñez', 19, 'ATA'),
  ('Uruguay', 'Federico Valverde', 'F. Valverde', 15, 'MEI'),
  ('United States', 'Christian Pulisic', 'C. Pulisic', 10, 'ATA'),
  ('United States', 'Folarin Balogun', 'F. Balogun', 9, 'ATA'),
  ('Mexico', 'Santiago Giménez', 'S. Giménez', 9, 'ATA'),
  ('Morocco', 'Achraf Hakimi', 'A. Hakimi', 2, 'DEF'),
  ('South Korea', 'Son Heung-min', 'S. Heung-Min', 7, 'ATA'),
  ('Switzerland', 'Breel Embolo', 'B. Embolo', 7, 'ATA'),
  ('Croatia', 'Andrej Kramarić', 'A. Kramarić', 9, 'ATA'),
  ('Japan', 'Takefusa Kubo', 'T. Kubo', 11, 'ATA');

-- ---------- CASE 1: as duas linhas existem -> MERGE iniciais -> completo ----------
create temp table _merge on commit drop as
select s.full_name, s.team,
       f.id as keep_id, i.id as drop_id,
       i.api_player_id as drop_api, i.shirt_number as drop_num, i.position as drop_pos
from _star s
join public.players f on f.team = s.team and f.full_name = s.full_name
join public.players i on i.team = s.team and i.full_name = s.ini_name;

update public.top_scorer_picks t
set player_id = m.keep_id
from _merge m
where t.player_id = m.drop_id;

update public.player_goals g
set goals = g.goals + d.goals
from _merge m
join public.player_goals d on d.player_id = m.drop_id
where g.player_id = m.keep_id and g.match_id = d.match_id;

delete from public.player_goals g
using _merge m
where g.player_id = m.drop_id
  and exists (select 1 from public.player_goals k
              where k.player_id = m.keep_id and k.match_id = g.match_id);

update public.player_goals g
set player_id = m.keep_id
from _merge m
where g.player_id = m.drop_id;

update public.players l
set api_player_id = null
from _merge m
where l.id = m.drop_id and l.api_player_id is not null;

update public.players k
set api_player_id = coalesce(k.api_player_id, m.drop_api),
    shirt_number  = coalesce(k.shirt_number,  m.drop_num),
    position      = coalesce(k.position,       m.drop_pos)
from _merge m
where k.id = m.keep_id;

delete from public.players p
using _merge m
where p.id = m.drop_id;

-- ---------- CASE 2: só existe a de iniciais -> RENAME (mesma linha) ----------
-- Reaproveita o id (palpites/api_player_id intactos). Preenche número/posição nulos.
create temp table _rename on commit drop as
select i.id as drop_id, s.full_name, s.seed_num, s.seed_pos
from _star s
join public.players i on i.team = s.team and i.full_name = s.ini_name
left join public.players f on f.team = s.team and f.full_name = s.full_name
where f.id is null;

update public.players p
set full_name    = r.full_name,
    shirt_number = coalesce(p.shirt_number, r.seed_num),
    position     = coalesce(p.position,     r.seed_pos)
from _rename r
where p.id = r.drop_id;

-- ---------- GUARD: nenhuma linha de iniciais das 33 pode sobrar ----------
do $$
declare n int;
begin
  select count(*) into n
  from public.players p
  join _star s on s.team = p.team and p.full_name = s.ini_name;
  if n > 0 then
    raise exception 'Sobrou(aram) % linha(s) de iniciais das estrelas. Rollback.', n;
  end if;
end $$;

commit;
