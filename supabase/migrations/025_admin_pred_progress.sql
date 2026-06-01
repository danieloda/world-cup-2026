-- ============================================================
-- Migration 025: progresso de palpites por usuário (agregado no servidor)
-- ============================================================
-- BUG: o painel de usuários do admin contava palpites trazendo TODAS as linhas
-- de `predictions` (admin.js: select('user_id')) e agrupando no cliente. O
-- PostgREST limita a resposta a ~1000 linhas, então com 104 jogos bastam ~10
-- participantes para estourar e os palpites além disso não eram contados →
-- usuários apareciam com progresso incompleto.
--
-- FIX: agregar no servidor (1 linha por usuário) via função security definer,
-- restrita a admin (não vaza quem já palpitou). Retorna também a quebra por fase
-- e se o usuário já escolheu campeão/artilheiro, para um painel mais completo.

create or replace function public.admin_pred_progress()
returns table (
  user_id      uuid,
  group_count  int,
  ko_count     int,
  total_count  int,
  has_champion boolean,
  has_scorer   boolean
)
language sql security definer stable as $$
  select
    pr.id,
    count(p.id) filter (where m.stage =  'group')::int as group_count,
    count(p.id) filter (where m.stage <> 'group')::int as ko_count,
    count(p.id)::int as total_count,
    (cp.user_id is not null) as has_champion,
    (tsp.user_id is not null) as has_scorer
  from public.profiles pr
  left join public.predictions p   on p.user_id = pr.id
  left join public.matches m       on m.id = p.match_id
  left join public.champion_picks cp   on cp.user_id = pr.id
  left join public.top_scorer_picks tsp on tsp.user_id = pr.id
  where public.is_admin()  -- gate: não-admin recebe 0 linhas
  group by pr.id, cp.user_id, tsp.user_id;
$$;

grant execute on function public.admin_pred_progress() to authenticated;
