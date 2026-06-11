-- ============================================================
-- Migration 060: Revelação dos palpites no PUBLISH do lacre (não só no apito)
-- ============================================================
-- DECISÃO (2026-06-11): os palpites alheios passam a aparecer no app assim que
-- o lacre do dia estiver PUBLICADO no GitHub (report commitado + existência
-- confirmada), e não apenas no apito inicial de cada jogo.
--
-- Por que é seguro: a ESCRITA trava na véspera 23h59 BRT desde a 023
-- (prediction_deadline nas policies de INSERT/UPDATE) — entre o lacre e o
-- apito ninguém edita nada. E o report público já expõe nome+palpite dos
-- jogos lacrados (decisão 2026-06-10), então o app revela exatamente o que
-- já é público no repositório.
--
-- COMO: a Action do snapshot (integrity-snapshot.yml), DEPOIS do commit/push,
-- confirma que o report existe no GitHub (GET no raw + chain_hash no corpo) e
-- registra a publicação aqui (scripts/integrity/confirm-publication.js, via
-- service_role). A revelação então é:
--   (jogo em lote publicado E deadline passada) OU jogo já começou.
-- O fallback do apito é proposital: se o pipeline falhar num dia, o
-- comportamento regride ao status quo (revela no apito) em vez de deixar a
-- página de Histórico vazia com jogo rolando.
--
-- Defesa em profundidade: o lote publicado lista match_ids, mas a revelação
-- re-checa prediction_deadline(match_date) NO MOMENTO da leitura — jogo adiado
-- (match_date movida pra frente) re-esconde os palpites mesmo constando num
-- lote antigo.
--
-- KEEP IN SYNC:
--   • scripts/integrity/confirm-publication.js (único escritor da tabela)
--   • src/js/pages/historico.js (consome v_revealed_matches)
--   • src/js/auto-refresh.js (fingerprint usa v_revealed_matches)
--   • tests/unit/rls-invariants.test.js (guard estático da policy)
--   • scripts/e2e/prod-smoke.js (MUST_TRUE do grants_health)
--   • scripts/e2e/test-rls-hostile.js (cenários 4b/4c)

-- ============================================================
-- 1) Registro de publicações do lacre (escrito pela Action, via service_role)
-- ============================================================
create table if not exists public.integrity_publications (
  seq               int primary key,          -- mesmo seq do integrity/manifest.json
  report_file       text not null,            -- ex.: 'reports/0006_2026-06-11.md'
  chain_hash        text not null,            -- âncora pra conferir contra o manifest
  locked_match_ids  int[] not null default '{}',
  published_at      timestamptz not null default now()
);

alter table public.integrity_publications enable row level security;

-- Leitura: qualquer autenticado (as páginas precisam saber o que está revelado).
-- Escrita: NENHUMA policy → só service_role (bypassa RLS); authenticated não
-- recebe grant de insert/update/delete nesta migration.
drop policy if exists "integrity_publications_select_all" on public.integrity_publications;
create policy "integrity_publications_select_all"
  on public.integrity_publications for select
  to authenticated using (true);

grant select on public.integrity_publications to authenticated;
-- EXPLÍCITO de propósito: imagens novas do Supabase (CLI ≥ ~2.1xx) não dão mais
-- DML por default privilege a service_role em tabela criada por postgres — sem
-- este grant o confirm-publication.js (service_role) não conseguiria registrar.
grant select, insert, update, delete on public.integrity_publications to service_role;

-- ============================================================
-- 2) v_revealed_matches: jogos cujos palpites (de todos) estão visíveis
-- ============================================================
-- MESMO predicado da policy de SELECT abaixo — mudou um, mude o outro.
create or replace view public.v_revealed_matches as
select m.*
from public.matches m
where m.match_date <= now()                                   -- apito (fallback)
   or (public.prediction_deadline(m.match_date) <= now()      -- travado de fato
       and exists (select 1 from public.integrity_publications ip
                   where m.id = any (ip.locked_match_ids)));  -- e lacre publicado

grant select on public.v_revealed_matches to authenticated;
grant select on public.v_revealed_matches to service_role;

-- ============================================================
-- 3) Policy de SELECT em predictions: revela no publish OU no apito
-- ============================================================
drop policy if exists "predictions_select_own_or_locked" on public.predictions;
drop policy if exists "predictions_select_own_or_revealed" on public.predictions;
create policy "predictions_select_own_or_revealed"
  on public.predictions for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.matches m
      where m.id = predictions.match_id
        and (
          m.match_date <= now()
          or (public.prediction_deadline(m.match_date) <= now()
              and exists (select 1 from public.integrity_publications ip
                          where predictions.match_id = any (ip.locked_match_ids)))
        )
    )
    or public.is_admin()
  );

-- ============================================================
-- 4) grants_health: passa a vigiar os grants novos. Sem eles o Histórico cai
--    (a página consome a view) e a revelação pós-lacre para. Lição do
--    incidente 2026-06-09: o monitor roda como service_role e é CEGO pros
--    grants de authenticated sem esta sonda definer.
--    KEEP IN SYNC: scripts/e2e/prod-smoke.js (MUST_TRUE/MUST_FALSE).
-- ============================================================
create or replace function public.grants_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- precisam ser TRUE — sem eles ranking.html cai e inicio.html degrada
    'champion_bonus_for__auth_exec', has_function_privilege('authenticated', 'public.champion_bonus_for(uuid)', 'execute'),
    'scorer_bonus_for__auth_exec',   has_function_privilege('authenticated', 'public.scorer_bonus_for(uuid)',   'execute'),
    'stage_multiplier__auth_exec',   has_function_privilege('authenticated', 'public.stage_multiplier(text)',   'execute'),
    'v_leaderboard__auth_select',    has_table_privilege('authenticated', 'public.v_leaderboard',    'select'),
    'v_scorer_ranking__auth_select', has_table_privilege('authenticated', 'public.v_scorer_ranking', 'select'),
    'v_pool_stats__auth_select',     has_table_privilege('authenticated', 'public.v_pool_stats',     'select'),
    -- 060: sem estes dois o Histórico quebra e a revelação pós-lacre para
    'v_revealed_matches__auth_select',     has_table_privilege('authenticated', 'public.v_revealed_matches',     'select'),
    'integrity_publications__auth_select', has_table_privilege('authenticated', 'public.integrity_publications', 'select'),
    -- precisam ser FALSE — deny-by-default da 034 (sensíveis seguem trancadas)
    'score_prediction__auth_exec',             has_function_privilege('authenticated', 'public.score_prediction(int,int,text,int,int,text,text)', 'execute'),
    'recompute_prediction_points__auth_exec',  has_function_privilege('authenticated', 'public.recompute_prediction_points(int)', 'execute'),
    'compute_predicted_slots__auth_exec',      has_function_privilege('authenticated', 'public.compute_predicted_slots(uuid)', 'execute')
  );
$$;

revoke all on function public.grants_health() from public, anon, authenticated;
grant execute on function public.grants_health() to service_role;
