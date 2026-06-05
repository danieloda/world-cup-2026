-- ============================================================
-- Migration 035: Trilha de auditoria imutável (achado H3)
-- ============================================================
-- Problema: predictions_admin_all permite o admin (ou quem tiver a service_role)
-- reescrever/apagar um palpite JÁ TRAVADO sem deixar rastro; e mudar um placar
-- finalizado re-pontua todo mundo silenciosamente. Sem histórico (unique(user,match)
-- → UPDATE sobrescreve), não há como provar a um participante que conteste o
-- prêmio que o palpite armazenado é o que ele enviou.
--
-- Solução (camada interna): tabela append-only que registra TODA escrita em
-- predictions / champion_picks / top_scorer_picks e toda mudança de resultado em
-- matches. Escrita só pelo trigger (SECURITY DEFINER); sem policy de
-- INSERT/UPDATE/DELETE → nenhum cliente (nem admin via PostgREST) edita ou apaga.
--
-- LIMITE honesto: o dono do banco / service_role ainda pode adulterar isto direto
-- no Postgres. A prova externa à prova de operador é o snapshot+hash por fase
-- (GitHub Action), que ancora os hashes fora do alcance de quem opera o banco.
-- Esta tabela é a evidência interna; o hash encadeado é a defesa externa.

-- ============================================================
-- 1) Tabela append-only
-- ============================================================
create table if not exists public.prediction_audit (
  id             bigserial primary key,
  table_name     text not null,                 -- predictions | champion_picks | top_scorer_picks | matches
  op             text not null,                 -- INSERT | UPDATE | DELETE
  row_user_id    uuid,                           -- dono do palpite (null em matches)
  match_id       int,                            -- jogo (null em champion/scorer picks)
  old_data       jsonb,                          -- estado anterior (null em INSERT)
  new_data       jsonb,                          -- estado novo (null em DELETE)
  changed_by     uuid default auth.uid(),        -- quem fez a escrita (admin pode != dono)
  actor_is_admin boolean default public.is_admin(),
  at             timestamptz not null default now()
);

create index if not exists idx_pred_audit_user  on public.prediction_audit(row_user_id, at desc);
create index if not exists idx_pred_audit_match on public.prediction_audit(match_id, at desc);
create index if not exists idx_pred_audit_at    on public.prediction_audit(at desc);

comment on table public.prediction_audit is
'Trilha append-only de toda mudança em palpites/picks/resultados. Escrita só por trigger SECURITY DEFINER; sem policy de escrita = imutável via API. Evidência de contestação do bolão.';

-- ============================================================
-- 2) Função de log (genérica para as 4 tabelas)
-- ============================================================
create or replace function public.log_prediction_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := null;
  v_match int  := null;
begin
  -- user_id existe em predictions / champion_picks / top_scorer_picks (não em matches)
  if tg_table_name in ('predictions', 'champion_picks', 'top_scorer_picks') then
    v_user := coalesce(new.user_id, old.user_id);
  end if;
  -- chave do jogo: predictions.match_id ; matches.id
  if tg_table_name = 'predictions' then
    v_match := coalesce(new.match_id, old.match_id);
  elsif tg_table_name = 'matches' then
    v_match := coalesce(new.id, old.id);
  end if;

  insert into public.prediction_audit(
    table_name, op, row_user_id, match_id, old_data, new_data, changed_by, actor_is_admin
  )
  values (
    tg_table_name,
    tg_op,
    v_user,
    v_match,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end,
    auth.uid(),
    public.is_admin()
  );

  return null;  -- AFTER trigger: retorno ignorado
end $$;

-- log_prediction_change roda como dono → escreve em prediction_audit mesmo a
-- tabela tendo RLS sem policy de INSERT. Não exposta a RPC:
revoke execute on function public.log_prediction_change() from public, anon, authenticated;

-- ============================================================
-- 3) Triggers
-- ============================================================
drop trigger if exists trg_predictions_audit on public.predictions;
create trigger trg_predictions_audit
  after insert or update or delete on public.predictions
  for each row execute function public.log_prediction_change();

drop trigger if exists trg_champion_audit on public.champion_picks;
create trigger trg_champion_audit
  after insert or update or delete on public.champion_picks
  for each row execute function public.log_prediction_change();

drop trigger if exists trg_scorer_audit on public.top_scorer_picks;
create trigger trg_scorer_audit
  after insert or update or delete on public.top_scorer_picks
  for each row execute function public.log_prediction_change();

-- matches: só mudanças de RESULTADO interessam (não toda edição de metadado).
drop trigger if exists trg_matches_result_audit on public.matches;
create trigger trg_matches_result_audit
  after update on public.matches
  for each row
  when (
       old.actual_home is distinct from new.actual_home
    or old.actual_away is distinct from new.actual_away
    or old.pen_winner  is distinct from new.pen_winner
    or old.finished    is distinct from new.finished
  )
  execute function public.log_prediction_change();

-- ============================================================
-- 4) RLS: SELECT só admin; nenhuma policy de escrita = append-only via API
-- ============================================================
alter table public.prediction_audit enable row level security;

drop policy if exists "prediction_audit_select_admin" on public.prediction_audit;
create policy "prediction_audit_select_admin"
  on public.prediction_audit for select
  to authenticated
  using (public.is_admin());

-- (Sem policy de INSERT/UPDATE/DELETE de propósito: o trigger SECURITY DEFINER
--  é o único caminho de escrita; PostgREST nega qualquer mutação direta.)
grant select on public.prediction_audit to authenticated;
